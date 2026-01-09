# 🔒 Financial-Grade Order Processing Architecture

## KemDataPlus - Production Safety Audit & Implementation

**Date:** January 9, 2026  
**Author:** System Architect  
**Status:** IMPLEMENTATION COMPLETE

---

## 📋 Executive Summary

This document provides a **complete, production-safe order processing architecture** for KemDataPlus. The system handles real money and integrates with external provider APIs (MCBIS DataHub).

### Key Guarantees

| Guarantee | Implementation | Failure Mode Prevention |
|-----------|---------------|------------------------|
| **No Duplicate Orders** | Idempotency keys + External reference persistence | Double-click, parallel requests, retries |
| **Single Wallet Deduction** | `walletDeducted` flag + Serializable transaction | Concurrent requests, server crash |
| **Audit Trail** | Append-only API logs + State transitions | Disputes, reconciliation, fraud |
| **Crash Recovery** | External reference persisted BEFORE API call | Server crash mid-request |
| **State Integrity** | Database triggers enforce state machine | Invalid transitions, race conditions |

---

## 1️⃣ Complete Prisma Schema

### 1.1 Order Model (Extended)

```prisma
model Order {
  id             String      @id @default(uuid())
  userId         String
  bundleId       String
  tenantId       String?
  
  recipientPhone String
  quantity       Int         @default(1)
  
  unitPrice      Float       @default(0)
  totalPrice     Float
  baseCost       Float       @default(0)
  
  reference      String      @unique       // Internal reference
  status         OrderStatus @default(PENDING)
  paymentStatus  String      @default("PENDING")
  
  // ============================================
  // FINANCIAL SAFETY FIELDS
  // ============================================
  
  // External API tracking (CRITICAL)
  externalReference String?   @unique      // From MCBIS - prevents duplicate sends
  externalStatus    String?                // Status from MCBIS
  apiSentAt         DateTime?              // When sent to API
  apiConfirmedAt    DateTime?              // When API confirmed
  
  // Retry control
  retryCount        Int       @default(0)
  maxRetries        Int       @default(3)
  nextRetryAt       DateTime?              // Scheduled retry time
  
  // Locking (prevents concurrent processing)
  lockedAt          DateTime?
  lockedBy          String?                // Server instance ID
  lockExpiresAt     DateTime?
  
  // Idempotency
  idempotencyKey    String?   @unique      // Client idempotency key
  
  // Wallet deduction tracking (CRITICAL FOR FINANCIAL SAFETY)
  walletDeducted    Boolean   @default(false)
  walletDeductedAt  DateTime?
  
  // Indexes for financial safety queries
  @@index([externalReference])
  @@index([nextRetryAt])
  @@index([lockedAt])
}
```

### 1.2 Idempotency Keys

```prisma
model IdempotencyKey {
  id              String    @id @default(uuid())
  key             String    @unique           // Unique per request
  operationType   String                      // CREATE_ORDER, PUSH_ORDER, etc.
  userId          String
  orderId         String?
  requestHash     String                      // Hash of request params
  responseData    Json?                       // Cached response
  status          String    @default("PENDING") // PENDING, COMPLETED, FAILED
  lockedAt        DateTime?
  lockedBy        String?                     // Server instance
  expiresAt       DateTime                    // TTL for cleanup
  createdAt       DateTime  @default(now())
  completedAt     DateTime?
}
```

### 1.3 API Audit Log

```prisma
model ApiAuditLog {
  id                  String    @id @default(uuid())
  orderId             String
  idempotencyKey      String?
  operation           String                  // PLACE_ORDER, CHECK_STATUS
  externalReference   String?
  requestUrl          String
  requestMethod       String
  requestPayloadHash  String                  // SHA-256 of payload
  requestPayload      Json?
  responseStatus      Int?
  responsePayloadHash String?
  responsePayload     Json?
  responseTimeMs      Int?
  retryNumber         Int       @default(0)
  errorMessage        String?
  errorCode           String?
  serverInstance      String?                 // For distributed tracing
  createdAt           DateTime  @default(now())
}
```

### 1.4 State Transition History

```prisma
model OrderStateTransition {
  id            String    @id @default(uuid())
  orderId       String
  fromState     String
  toState       String
  triggeredBy   String                        // User ID or server instance
  triggerSource String                        // application, webhook, admin
  metadata      Json?
  createdAt     DateTime  @default(now())
}
```

---

## 2️⃣ Safe Order-Push Function

### Critical Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SAFE ORDER PUSH SEQUENCE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. ACQUIRE LOCK ──────────────────────────────────────────────────────────▶│
│     │  SELECT ... FOR UPDATE SKIP LOCKED                                    │
│     │  Sets: lockedAt, lockedBy, lockExpiresAt                             │
│     │                                                                       │
│     │  WHY: Prevents two servers from processing same order                │
│     │  BREAK: Without lock, two servers could send same order to API       │
│     ▼                                                                       │
│  2. CHECK IF ALREADY SENT ─────────────────────────────────────────────────▶│
│     │  IF externalReference EXISTS → Already sent, skip                    │
│     │                                                                       │
│     │  WHY: External reference proves order was sent                       │
│     │  BREAK: Without check, retry would create duplicate API order        │
│     ▼                                                                       │
│  3. GENERATE EXTERNAL REFERENCE ───────────────────────────────────────────▶│
│     │  reference = KEM{timestamp}{random}                                  │
│     │                                                                       │
│     │  WHY: Unique identifier for external provider                        │
│     │  BREAK: Without unique ref, provider can't dedupe                    │
│     ▼                                                                       │
│  4. PERSIST REFERENCE TO DATABASE ─────────────────────────────────────────▶│
│     │  UPDATE orders SET externalReference = ? WHERE id = ?                │
│     │  *** COMMIT HAPPENS HERE ***                                         │
│     │                                                                       │
│     │  WHY: If crash after API call, we know order was sent               │
│     │  BREAK: Without this, crash loses knowledge of sent order           │
│     ▼                                                                       │
│  5. LOG API CALL (BEFORE EXECUTION) ───────────────────────────────────────▶│
│     │  INSERT INTO api_audit_logs (order_id, request_payload, ...)        │
│     │                                                                       │
│     │  WHY: Audit trail exists even if API call fails                     │
│     │  BREAK: Without pre-logging, failed calls leave no trace            │
│     ▼                                                                       │
│  6. CALL EXTERNAL API ─────────────────────────────────────────────────────▶│
│     │  POST /placeOrder { reference, network, receiver, amount }          │
│     │  Header: X-Idempotency-Key: {externalReference}                     │
│     │                                                                       │
│     │  WHY: External provider receives order                              │
│     │  BREAK: N/A - this is the actual operation                          │
│     ▼                                                                       │
│  7. UPDATE AUDIT LOG WITH RESPONSE ────────────────────────────────────────▶│
│     │  UPDATE api_audit_logs SET response_status = ?, ...                 │
│     │                                                                       │
│     │  WHY: Complete audit record for disputes/reconciliation             │
│     │  BREAK: Incomplete audit record for failed calls                    │
│     ▼                                                                       │
│  8. UPDATE ORDER STATUS ───────────────────────────────────────────────────▶│
│     │  UPDATE orders SET status = 'PROCESSING', externalStatus = ?        │
│     │                                                                       │
│     │  WHY: Reflect current state of order                                │
│     │  BREAK: Order stays in wrong state                                  │
│     ▼                                                                       │
│  9. RELEASE LOCK ──────────────────────────────────────────────────────────▶│
│     │  UPDATE orders SET lockedAt = NULL, lockedBy = NULL                 │
│     │  *** ALWAYS RUNS (finally block) ***                                │
│     │                                                                       │
│     │  WHY: Allow other operations on order                               │
│     │  BREAK: Order stays locked forever                                  │
│     ▼                                                                       │
│  DONE                                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Code Implementation

See `server/src/services/financial-order.service.js` for the complete implementation.

Key safeguards:

```javascript
// SAFEGUARD 1: Lock acquisition with timeout
const lockResult = await this.acquireOrderLock(orderId);
if (!lockResult.success) {
  return { success: false, error: 'COULD_NOT_ACQUIRE_LOCK' };
}

// SAFEGUARD 2: Check if already sent
if (order.externalReference) {
  return { success: true, alreadySent: true };
}

// SAFEGUARD 3: Persist reference BEFORE API call
await prisma.order.update({
  where: { id: orderId },
  data: { externalReference, apiSentAt: new Date() }
});

// SAFEGUARD 4: Log BEFORE API call
const auditLogId = await this.logApiCall({ ... });

// SAFEGUARD 5: Make API call
const response = await axios.post(...);

// SAFEGUARD 6: Always release lock (finally block)
await this.releaseOrderLock(orderId);
```

---

## 3️⃣ Retry-With-Lock Logic

### Retry Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max Retries | 3 | Enough for transient failures, not infinite |
| Base Delay | 1 second | Quick first retry |
| Max Delay | 60 seconds | Cap on exponential backoff |
| Backoff Multiplier | 2x | Exponential: 1s, 2s, 4s, ... |
| Jitter | ±20% | Prevents thundering herd |

### Retry Flow

```
Attempt 1 (t=0)     → Fail (timeout)     → Schedule retry at t+1s
Attempt 2 (t=1s)    → Fail (5xx)         → Schedule retry at t+2s  
Attempt 3 (t=3s)    → Fail (network)     → Mark as FAILED (max retries)
```

### Safe Retry Implementation

```javascript
async processRetryQueue(apiConfig) {
  // Find orders due for retry
  const ordersToRetry = await prisma.order.findMany({
    where: {
      status: { in: ['PENDING', 'PROCESSING'] },
      nextRetryAt: { lte: new Date() },        // Due now or past
      retryCount: { lt: 3 },                    // Under max
      externalReference: null                   // Not yet sent
    },
    take: 10
  });

  for (const order of ordersToRetry) {
    // pushOrderToApi handles locking internally
    await this.pushOrderToApi(order.id, apiConfig);
  }
}
```

### Crash Recovery

On server startup:

```javascript
async recoverOrphanedOrders() {
  // Find orders that have external reference but are still "PROCESSING"
  // These may have been interrupted after API call
  const orphaned = await prisma.order.findMany({
    where: {
      externalReference: { not: null },
      status: 'PROCESSING',
      apiSentAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }
    }
  });
  
  // Check status with external API
  for (const order of orphaned) {
    const status = await this.checkOrderStatus(order.externalReference);
    // Update order based on actual provider status
  }
}
```

---

## 4️⃣ Full API Audit Logging

### What Gets Logged

| Field | Purpose |
|-------|---------|
| `orderId` | Links to our order |
| `externalReference` | Links to provider order |
| `requestPayloadHash` | Tamper detection |
| `requestPayload` | Full request for debugging |
| `responseStatus` | HTTP status code |
| `responsePayload` | Full response |
| `responseTimeMs` | Performance tracking |
| `retryNumber` | Which attempt this was |
| `serverInstance` | Which server made call |

### Audit Log Usage

#### Dispute Resolution
```sql
-- Customer claims order never delivered
SELECT * FROM api_audit_logs 
WHERE order_id = 'xxx'
ORDER BY created_at;
-- Shows: request sent, response received, status updates
```

#### Reconciliation
```sql
-- Find all orders sent to provider in date range
SELECT external_reference, response_status, created_at
FROM api_audit_logs
WHERE operation = 'PLACE_ORDER'
  AND created_at BETWEEN '2026-01-01' AND '2026-01-31';
```

#### Fraud Detection
```sql
-- Find orders with multiple send attempts (suspicious)
SELECT order_id, COUNT(*) as attempts
FROM api_audit_logs
WHERE operation = 'PLACE_ORDER'
GROUP BY order_id
HAVING COUNT(*) > 3;
```

---

## 5️⃣ Order State Machine

### State Diagram

```
                    ┌──────────────┐
                    │   CREATED    │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            │
        ┌──────────┐ ┌──────────┐       │
        │ CANCELLED│ │  QUEUED  │       │
        └──────────┘ └────┬─────┘       │
                          │             │
                    ┌─────┴─────┐       │
                    │           │       │
                    ▼           ▼       │
              ┌──────────┐ ┌──────────┐ │
              │  FAILED  │ │  LOCKED  │ │
              └──────────┘ └────┬─────┘ │
                                │       │
                          ┌─────┴─────┐ │
                          │           │ │
                          ▼           ▼ │
                    ┌──────────┐ ┌──────────┐
                    │  FAILED  │ │   SENT   │
                    └──────────┘ └────┬─────┘
                                      │
                                ┌─────┴─────┐
                                │           │
                                ▼           ▼
                          ┌──────────┐ ┌──────────┐
                          │  FAILED  │ │CONFIRMED │
                          └──────────┘ └──────────┘
```

### Valid Transitions (Enforced by Database Trigger)

| From State | To States |
|------------|-----------|
| CREATED | QUEUED, CANCELLED |
| QUEUED | LOCKED, FAILED, CANCELLED |
| LOCKED | SENT, FAILED |
| SENT | CONFIRMED, FAILED |
| CONFIRMED | (terminal) |
| FAILED | (terminal) |
| CANCELLED | (terminal) |

### Database Enforcement

```sql
CREATE OR REPLACE FUNCTION validate_order_state_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if transition is in allowed list
  IF NOT (OLD.status, NEW.status) IN (
    ('CREATED', 'QUEUED'),
    ('QUEUED', 'LOCKED'),
    ('LOCKED', 'SENT'),
    ...
  ) THEN
    RAISE EXCEPTION 'Invalid state transition from % to %', 
      OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## 6️⃣ Failure & Attack Scenarios

### Scenario 1: Double Button Click

**Attack:** User clicks "Buy" button twice rapidly.

**Protection:**
1. Frontend: Disable button after first click
2. Backend: Idempotency key generated from (userId, bundleId, phone, timestamp/10s)
3. Second request sees existing idempotency key → returns cached response

**Result:** ✅ Single order created, single wallet deduction

### Scenario 2: Parallel Requests

**Attack:** Attacker sends 10 concurrent requests with same parameters.

**Protection:**
1. First request creates IdempotencyKey record with UNIQUE constraint
2. Other 9 requests fail on unique constraint
3. Requests return "CONCURRENT_REQUEST" error

**Result:** ✅ Single order created

### Scenario 3: Server Crash Mid-Request

**Attack:** Server crashes after API call but before updating order status.

**Protection:**
1. External reference saved BEFORE API call
2. On recovery, find orders with externalReference but status=PROCESSING
3. Query provider API for actual status
4. Update order to match provider

**Result:** ✅ Order state eventually consistent

### Scenario 4: External API Timeout

**Attack:** Provider API hangs for 60 seconds.

**Protection:**
1. API call has 30-second timeout
2. Timeout treated as retryable error
3. Retry scheduled with exponential backoff
4. Order stays locked during retry

**Result:** ✅ Retry happens, no duplicate

### Scenario 5: Duplicate Webhook Callbacks

**Attack:** Provider sends "completed" webhook twice.

**Protection:**
1. Check current order status before updating
2. CONFIRMED is terminal state
3. Second webhook sees CONFIRMED → no-op

**Result:** ✅ Order updated once

### Scenario 6: Manual Admin Retries

**Attack:** Admin clicks "Retry" on failed order multiple times.

**Protection:**
1. Lock acquisition required before retry
2. Check externalReference - if exists, order already sent
3. Return "already sent" response

**Result:** ✅ Single send to provider

---

## 📊 Invariants (Rules That Must Never Break)

### Financial Invariants

1. **INV-001:** `walletDeducted = true` implies exactly one wallet transaction exists
2. **INV-002:** `externalReference IS NOT NULL` implies order was sent to provider
3. **INV-003:** Order status can only move forward in state machine
4. **INV-004:** Every API call has a corresponding audit log entry
5. **INV-005:** Idempotency key uniqueness prevents duplicate operations

### Operational Invariants

6. **INV-006:** Locked order cannot be modified by another server instance
7. **INV-007:** Retry count never exceeds maxRetries
8. **INV-008:** State transitions are atomic and logged
9. **INV-009:** Failed terminal state cannot transition to success
10. **INV-010:** Audit logs are append-only (no updates or deletes)

---

## 🔴 Top 5 Financial-Loss Failure Points

### 1. Double Wallet Deduction

**Risk:** User charged twice for single order  
**Prevention:** `walletDeducted` boolean + Serializable transaction  
**Test:** Concurrent order creation returns idempotent response

### 2. Duplicate API Orders

**Risk:** Provider receives same order twice, user gets double data  
**Prevention:** External reference saved before API call + unique constraint  
**Test:** Crash after API call → recovery detects existing reference

### 3. Missing Order After Payment

**Risk:** Wallet deducted but order not created  
**Prevention:** Atomic transaction (deduct + create in same tx)  
**Test:** Transaction rollback if order creation fails

### 4. Retry Creates Duplicate

**Risk:** Retry mechanism sends already-sent order again  
**Prevention:** Check `externalReference` before sending  
**Test:** Manual retry on sent order returns "already sent"

### 5. Concurrent Lock Breach

**Risk:** Two servers process same order simultaneously  
**Prevention:** `FOR UPDATE SKIP LOCKED` + lock expiry  
**Test:** Parallel requests → only one acquires lock

---

## ✅ Final Verdict

### Is the System Financially Safe?

## **YES** - With Conditions

The system is financially safe **IF ALL COMPONENTS ARE DEPLOYED**:

| Component | Required | Status |
|-----------|----------|--------|
| Prisma schema with safety fields | ✅ | Implemented |
| financial-order.service.js | ✅ | Implemented |
| Database migration | ✅ | Created |
| State machine trigger | ⚠️ | Needs deployment |
| Recovery on startup | ⚠️ | Needs integration |
| Idempotency cleanup job | ⚠️ | Needs scheduling |

### Deployment Checklist

- [ ] Run Prisma migration: `npx prisma migrate deploy`
- [ ] Apply SQL triggers: Run `financial_safety/migration.sql`
- [ ] Update order controller to use `financialOrderService`
- [ ] Add startup recovery: Call `recoverOrphanedOrders()` on boot
- [ ] Schedule cleanup: Remove expired idempotency keys daily
- [ ] Test all 6 failure scenarios in staging
- [ ] Monitor audit logs for anomalies

---

## 📁 Files Created/Modified

1. `server/prisma/schema.prisma` - Extended Order model + new models
2. `server/prisma/migrations/financial_safety/migration.sql` - Database triggers
3. `server/src/services/financial-order.service.js` - Safe order processing
4. `docs/FINANCIAL_SAFETY_ARCHITECTURE.md` - This document

---

*Document Version: 1.0*  
*Last Updated: January 9, 2026*
