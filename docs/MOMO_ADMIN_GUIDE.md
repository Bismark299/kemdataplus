# MoMo Send & Claim System - Admin Documentation

## 🎯 Overview

A production-ready Mobile Money (MoMo) Send & Claim verification system for KemDataplus admin dashboard. Built with:

- **Backend**: Node.js + Express + PostgreSQL
- **Security**: JWT authentication, database transactions, row locking
- **Frontend**: Responsive HTML/CSS/JS admin UI
- **Safety**: Audit logging, immutable ledger, duplicate prevention

---

## 🚀 Quick Start

### 1. Prerequisites

```bash
# Required
- Node.js 14+ (for backend)
- PostgreSQL 12+ (database)
- npm 6+

# Verification
node --version    # v14.0.0+
npm --version     # 6.0.0+
psql --version    # psql (PostgreSQL) 12+
```

### 2. Database Setup

#### Step 1: Create Database
```bash
psql -U postgres
# In PostgreSQL shell:
CREATE DATABASE kemdataplus_dev;
CREATE USER kemdataplus_user WITH PASSWORD 'secure_password';
ALTER ROLE kemdataplus_user WITH CREATEDB;
GRANT ALL PRIVILEGES ON DATABASE kemdataplus_dev TO kemdataplus_user;
\q
```

#### Step 2: Configure Environment
Create `.env` file in `/backend`:
```env
# Server
PORT=5000
NODE_ENV=development

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=kemdataplus_dev
DB_USER=kemdataplus_user
DB_PASSWORD=secure_password

# JWT
JWT_SECRET=your-super-secret-key-change-in-production
```

#### Step 3: Initialize Schema & Seed Data
```bash
cd backend
npm install
node setup-db.js
```

Expected output:
```
✅ Database setup completed successfully!
🔐 Test Login Credentials:
  Email: admin@kemdataplus.com
  Password: admin123
```

### 3. Start Backend
```bash
cd backend
npm run dev
```

Visit: http://localhost:5000/admin

---

## 📊 System Architecture

### Database Schema

```
users
├── id (PK)
├── email (UNIQUE)
├── password_hash
├── first_name, last_name, phone
└── timestamps

admins
├── id (PK)
├── email (UNIQUE)
├── password_hash
├── full_name, role
└── active (boolean)

user_wallets
├── id (PK)
├── user_id (FK, UNIQUE) → users
├── balance (DECIMAL)
├── locked_for_transaction (UUID)
└── timestamps

wallet_ledger (IMMUTABLE)
├── id (PK)
├── user_id (FK) → users
├── transaction_type (enum)
├── amount, description
├── balance_before, balance_after
├── related_transaction_id (UUID)
└── created_at

momo_claims (CORE FEATURE)
├── id (UUID PK)
├── user_id (FK) → users
├── amount (DECIMAL)
├── momo_reference (UNIQUE) ← **CRITICAL: Prevents duplicates**
├── sender_momo_number
├── status (enum: pending, approved, rejected)
├── approved_by_admin_id (FK) → admins
├── admin_note, rejected_reason
├── wallet_balance_at_approval (snapshot)
└── timestamps (created_at, reviewed_at)

momo_audit_log (IMMUTABLE)
├── id (PK)
├── claim_id (FK) → momo_claims
├── admin_id (FK) → admins
├── action (enum: created, approved, rejected, viewed)
├── old_status, new_status
├── details (JSONB)
└── created_at
```

### Key Constraints

```sql
-- Prevent duplicate references
ALTER TABLE momo_claims ADD CONSTRAINT unique_momo_reference UNIQUE (momo_reference);

-- Prevent invalid amounts
ALTER TABLE momo_claims ADD CONSTRAINT chk_amount_positive CHECK (amount > 0);

-- Enforce status values
ALTER TABLE momo_claims ADD CONSTRAINT chk_status CHECK (status IN ('pending', 'approved', 'rejected'));
```

---

## 🔐 API Endpoints

### Authentication

#### Admin Login
```http
POST /api/admin-auth/login
Content-Type: application/json

{
  "email": "admin@kemdataplus.com",
  "password": "admin123"
}

Response 200:
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "admin": {
    "id": 1,
    "email": "admin@kemdataplus.com",
    "fullName": "Super Admin",
    "role": "super_admin"
  }
}
```

**Token Usage**: All MoMo endpoints require:
```http
Authorization: Bearer <token>
```

---

### MoMo Claims Endpoints

#### 1. Get All Claims (with filters)
```http
GET /api/momo/claims?status=pending&search=MOM&limit=20&offset=0
Authorization: Bearer <token>

Response 200:
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "user_id": 1,
      "first_name": "Ama",
      "last_name": "Mensah",
      "email": "user@example.com",
      "amount": "50.00",
      "momo_reference": "MOM-2025-001-ABC123",
      "sender_momo_number": "0551234567",
      "status": "pending",
      "created_at": "2025-01-15T10:30:00Z",
      "approved_by_admin_name": null
    },
    ...
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 42
  }
}
```

**Query Parameters:**
- `status`: Filter by status (pending, approved, rejected)
- `search`: Search by reference, user name, or email
- `startDate`, `endDate`: Date range filter (ISO format)
- `limit`: Results per page (default: 20)
- `offset`: Pagination offset (default: 0)

---

#### 2. Get Claim Details
```http
GET /api/momo/claims/:claimId
Authorization: Bearer <token>

Response 200:
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": 1,
    "first_name": "Ama",
    "last_name": "Mensah",
    "email": "user@example.com",
    "phone": "0551234567",
    "amount": "50.00",
    "momo_reference": "MOM-2025-001-ABC123",
    "sender_momo_number": "0551234567",
    "status": "pending",
    "created_at": "2025-01-15T10:30:00Z",
    "currentBalance": "0.00",
    "hasDuplicateReference": false,
    "auditLog": [
      {
        "id": 1,
        "claim_id": "550e8400-e29b-41d4-a716-446655440000",
        "admin_id": null,
        "action": "created",
        "created_at": "2025-01-15T10:30:00Z"
      }
    ]
  }
}
```

---

#### 3. Approve Claim (ATOMIC TRANSACTION)
```http
POST /api/momo/claims/:claimId/approve
Authorization: Bearer <token>
Content-Type: application/json

{
  "adminNote": "Verified sender identity. MoMo transaction confirmed."
}

Response 200:
{
  "success": true,
  "message": "✅ Claim approved and 50.00 GHS credited to user wallet",
  "data": {
    "claimId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": 1,
    "amount": "50.00",
    "newBalance": "50.00",
    "approvedAt": "2025-01-15T10:35:00Z"
  }
}
```

**Backend Logic (Transactional)**:
1. ✅ Verify claim exists and is PENDING
2. 🔒 Lock user wallet row (prevents race conditions)
3. 💳 Credit wallet: `balance += amount`
4. 📝 Create immutable ledger entry
5. ✔️ Mark claim as APPROVED
6. 📋 Log admin action to audit trail
7. ✅ Commit transaction (all-or-nothing)

**Error Responses**:
```json
{
  "success": false,
  "error": "Cannot approve claim with status: already_approved"
}
```

---

#### 4. Reject Claim (with mandatory reason)
```http
POST /api/momo/claims/:claimId/reject
Authorization: Bearer <token>
Content-Type: application/json

{
  "rejectionReason": "Invalid MoMo reference format. Request user to resubmit with correct reference."
}

Response 200:
{
  "success": true,
  "message": "✅ Claim rejected successfully",
  "data": {
    "claimId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "rejected",
    "rejectedAt": "2025-01-15T10:35:00Z"
  }
}
```

**Validation**:
- Reason required (must be present)
- Minimum 10 characters
- Cannot be empty or whitespace

**Error Response**:
```json
{
  "success": false,
  "error": "Rejection reason must be at least 10 characters"
}
```

---

#### 5. Get MoMo Stats
```http
GET /api/momo/stats
Authorization: Bearer <token>

Response 200:
{
  "success": true,
  "data": {
    "total_claims": 42,
    "pending_count": 15,
    "approved_count": 22,
    "rejected_count": 5,
    "total_approved_amount": "5250.00",
    "pending_amount": "875.00"
  }
}
```

---

#### 6. Create MoMo Claim (Customer-side)
```http
POST /api/momo/create
Content-Type: application/json

{
  "userId": 1,
  "amount": 50.00,
  "momoReference": "MOM-2025-001-ABC123",
  "senderMomoNumber": "0551234567"
}

Response 201:
{
  "success": true,
  "message": "✅ MoMo claim submitted successfully. Awaiting admin review.",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "user_id": 1,
    "amount": "50.00",
    "momo_reference": "MOM-2025-001-ABC123",
    "status": "pending",
    "created_at": "2025-01-15T10:30:00Z"
  }
}
```

**Validation**:
- All fields required
- Amount must be > 0
- Duplicate reference rejected at DB level (UNIQUE constraint)

**Error Response**:
```json
{
  "success": false,
  "error": "This MoMo reference has already been submitted"
}
```

---

## 🎨 Admin UI / UX Flow

### 1. MoMo Claims List Page
**URL**: `/admin/momo.html`

**Features**:
- ✅ Stats cards: Total, Pending, Approved, Rejected
- ✅ Advanced filters: Status, Search, Date range
- ✅ Responsive data table with pagination
- ✅ Loading skeletons while fetching
- ✅ Empty state message
- ✅ Click any row to view details

**UI Elements**:
```
┌─────────────────────────────────────────────────┐
│ 📊 Stats Cards                                   │
│ ┌──────┬──────┬──────┬──────┐                   │
│ │ 42   │ 15   │ 22   │ 5    │                   │
│ │ Total│ Pend │Appro │ Rej  │                   │
│ └──────┴──────┴──────┴──────┘                   │
├─────────────────────────────────────────────────┤
│ 🔍 Filters                                       │
│ ┌──────────┬──────────┬──────────┬──────────┐   │
│ │ Search   │ Status   │ From     │ To       │   │
│ │ Ref/User │ Pending  │ Date     │ Date     │   │
│ └──────────┴──────────┴──────────┴──────────┘   │
├─────────────────────────────────────────────────┤
│ 📋 Data Table                                    │
│ ┌─────────────────────────────────────────────┐ │
│ │ User    │ Amount│ Ref  │ MoMo  │ Date│Stat│ │ │
│ ├─────────────────────────────────────────────┤ │
│ │ Ama M   │ 50 GH│ MOM-│ 0551  │ Jan │PEN │ │ │
│ │         │      │ 001 │ 2345  │ 15  │   │ │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 2. Claim Detail Panel
**Triggered**: Click any table row or "View" button

**Features**:
- ✅ Full claim details in organized grid
- ✅ Current user wallet balance
- ✅ ⚠️ Duplicate reference warning (if applicable)
- ✅ Approve button (pending claims only)
- ✅ Reject button (pending claims only)
- ✅ Audit log history

**UX Rules**:
- Close button to dismiss
- No actions visible without opening details
- Status-aware (hide actions if not pending)

### 3. Approve Modal
**Triggered**: Click "Approve" button on detail panel

**Modal Content**:
```
┌──────────────────────────────────────┐
│ ✓ Confirm Approval                   │
├──────────────────────────────────────┤
│ User          │ Ama Mensah           │
│ Amount        │ GHS 50.00            │
│ Reference     │ MOM-2025-001-ABC123  │
│ Current Bal   │ GHS 0.00             │
├──────────────────────────────────────┤
│ Admin Note (Optional)                │
│ ┌────────────────────────────────┐   │
│ │ Verified sender identity...    │   │
│ └────────────────────────────────┘   │
├──────────────────────────────────────┤
│ [Confirm Approval] [Cancel]          │
└──────────────────────────────────────┘
```

**UX States**:
- ✅ Before click: Button enabled
- ⏳ During processing: Button disabled + spinner
- ✅ Success: Toast notification + auto-refresh
- ❌ Error: Red toast with error message

### 4. Reject Modal
**Triggered**: Click "Reject" button on detail panel

**Modal Content**:
```
┌──────────────────────────────────────┐
│ ✗ Reject Claim                       │
├──────────────────────────────────────┤
│ Rejection Reason *                   │
│ ┌────────────────────────────────┐   │
│ │ Invalid MoMo reference format...│   │
│ └────────────────────────────────┘   │
├──────────────────────────────────────┤
│ [Confirm Rejection] [Cancel]         │
└──────────────────────────────────────┘
```

**Validation**:
- ❌ Cannot submit without reason
- ❌ Minimum 10 characters (validated on input)
- ✅ Error message shown below textarea
- ✅ Confirm button disabled if invalid

---

## 🔒 Security Features

### 1. Database-Level Constraints
```sql
-- Unique reference prevents duplicates at DB level
UNIQUE (momo_reference)

-- Positive amounts enforced
CHECK (amount > 0)

-- Valid status values
CHECK (status IN ('pending', 'approved', 'rejected'))
```

### 2. Transaction Safety
```javascript
BEGIN TRANSACTION
  1. Lock wallet row (SELECT ... FOR UPDATE)
  2. Verify claim is pending
  3. Credit wallet
  4. Create ledger entry
  5. Update claim status
  6. Log admin action
COMMIT
// If any step fails, all changes rolled back
```

### 3. Row Locking
```sql
-- Prevents race conditions during concurrent approvals
SELECT * FROM user_wallets WHERE user_id = $1 FOR UPDATE
-- Holds exclusive lock until transaction ends
```

### 4. Immutable Audit Trail
```sql
-- Ledger entries can NEVER be updated or deleted
-- Only new inserts allowed
-- Full history preserved forever
```

### 5. JWT Authentication
```javascript
// Every request validated
Authorization: Bearer <token>

// Token includes:
{
  id: admin.id,
  email: admin.email,
  fullName: admin.full_name,
  role: admin.role,
  expiresIn: '24h'
}
```

---

## 📝 Workflow: Approving a Claim

### Step-by-Step

1. **Admin logs in**
   - Email: admin@kemdataplus.com
   - Password: admin123
   - JWT token issued

2. **Navigate to MoMo Claims**
   - Click "MoMo Claims" in sidebar
   - See stats cards and table of claims

3. **Search/Filter claims**
   - Filter by status: "Pending"
   - Search by reference or user name

4. **Click claim row**
   - Detail panel opens
   - Shows all claim info
   - Shows current wallet balance

5. **Review warnings**
   - Check for duplicate reference alerts
   - Review audit history

6. **Click "Approve"**
   - Confirmation modal appears
   - Shows amount to credit
   - Shows current wallet balance

7. **Add optional note**
   - Admin notes the reason for approval
   - Optional but recommended

8. **Click "Confirm Approval"**
   - Button becomes disabled
   - Spinner shown
   - Backend processes request:
     - Transaction begins
     - Wallet row locked
     - Amount credited
     - Ledger entry created
     - Claim marked approved
     - Action logged

9. **Success feedback**
   - Green toast: "✅ Claim approved! Wallet credited."
   - Table automatically refreshes
   - Stats cards update
   - Detail panel closes

---

## 🧪 Testing

### Manual Test Cases

#### Test 1: Approve a Pending Claim
```
Setup: Create claim with status='pending'
Steps:
  1. Login as admin
  2. Go to MoMo Claims
  3. Filter status='pending'
  4. Click claim row
  5. Click "Approve"
  6. Add note "Test approval"
  7. Click "Confirm Approval"
Expected:
  - Claim status changes to 'approved'
  - User wallet credited with amount
  - Ledger entry created
  - Audit log records action
  - Table refreshes automatically
```

#### Test 2: Reject with Reason
```
Setup: Create claim with status='pending'
Steps:
  1. Login as admin
  2. Go to MoMo Claims
  3. Click claim row
  4. Click "Reject"
  5. Enter reason: "Invalid reference format"
  6. Click "Confirm Rejection"
Expected:
  - Claim status changes to 'rejected'
  - Reason saved
  - No wallet credit
  - Audit log records rejection
  - Table refreshes
```

#### Test 3: Duplicate Reference Prevention
```
Setup: Create claim with same momo_reference
Expected:
  - Database INSERT fails (UNIQUE constraint)
  - Error message: "This MoMo reference has already been submitted"
  - No duplicate in system
```

#### Test 4: Transaction Rollback
```
Setup: Simulate wallet update failure during approval
Expected:
  - Transaction rolled back
  - Wallet balance unchanged
  - Claim still pending
  - Error message to admin
```

---

## 📦 Deployment Checklist

### Pre-Production

- [ ] Change JWT_SECRET in .env (use 32+ char random string)
- [ ] Change DB_PASSWORD (use strong password)
- [ ] Update admin password (use bcryptjs for hashing)
- [ ] Set NODE_ENV=production
- [ ] Enable HTTPS only
- [ ] Setup regular database backups
- [ ] Configure admin email notifications
- [ ] Test all API endpoints
- [ ] Load test with 100+ concurrent requests
- [ ] Review audit logs
- [ ] Document runbook for admins

### Production

- [ ] Use PostgreSQL managed service (AWS RDS, etc)
- [ ] Enable SSL connections to database
- [ ] Setup monitoring and alerting
- [ ] Configure admin role-based access control
- [ ] Implement IP whitelisting for admin access
- [ ] Setup WAF (Web Application Firewall)
- [ ] Enable database audit logging
- [ ] Schedule daily backups + weekly exports
- [ ] Monitor transaction speeds
- [ ] Setup payment reconciliation cron job

---

## 🐛 Troubleshooting

### Database Connection Error
```
Error: connect ECONNREFUSED 127.0.0.1:5432

Solution:
1. Verify PostgreSQL running: sudo service postgresql status
2. Check connection string in .env
3. Verify database exists: psql -U postgres -c "\\l"
4. Test connection: psql -U kemdataplus_user -d kemdataplus_dev
```

### Duplicate Reference Error
```
Error: duplicate key value violates unique constraint

Cause: Reference already submitted
Solution: Ask user for new reference or investigate fraud

Prevention: Frontend should check before submitting
```

### Transaction Timeout
```
Error: Query did not return

Cause: Long lock wait (concurrent approvals)
Solution: Increase statement_timeout in PostgreSQL
```

### Admin Login Failed
```
Error: Invalid email or password

Verify:
1. Email matches exactly
2. Password is 'admin123' (for test credential)
3. Admin account is active (active=true)
4. Database connection working
```

---

## 📞 Support & Contact

- **Issue Reporting**: Create GitHub issue
- **Security**: Email security@kemdataplus.com
- **Urgent**: Call +233 XXX XXXX XXX

---

## 📄 License

Proprietary - KemDataplus 2025

All rights reserved. Unauthorized copying prohibited.
