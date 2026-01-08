# Multi-Tenant Reseller Platform Architecture

## Overview

This document describes the comprehensive multi-tenant reseller expansion system implemented for KemDataplus. The system enables hierarchical reseller structures with price inheritance, automatic profit distribution, and robust financial safeguards.

---

## Architecture Components

### 1. Tenant Hierarchy System

**Location:** `server/src/services/tenant.service.js`

The tenant system implements a hierarchical multi-tenant architecture:

- **Root Tenant**: The top-level tenant (KemDataplus)
- **Sub-Tenants**: Partners, Super Dealers, etc. can create their own branded sub-sites
- **Hierarchy Path**: Uses materialized path pattern (`/root/child/grandchild/`) for efficient queries
- **Hierarchy Levels**: 0 = root, 1 = first-level children, etc.

```
Root (KemDataplus)
├── Partner A (hierarchyPath: /root-tenant-001/)
│   ├── Super Dealer 1 (hierarchyPath: /root-tenant-001/partner-a/)
│   └── Super Dealer 2
└── Partner B
    └── Dealer X
```

**Key Capabilities:**
- `canCreateSubTenant`: Whether tenant can create sub-tenants
- `maxSubTenants`: Limit on number of sub-tenants
- `canSetPrices`: Whether tenant can customize pricing
- `maxDiscountPercent`: Maximum discount from parent price

---

### 2. Price Inheritance Engine

**Location:** `server/src/services/pricing.service.js`

The pricing engine implements cascading price resolution with validation:

#### Price Resolution Order:
1. Check tenant-specific price for role
2. Walk up hierarchy to find parent price
3. Fall back to system role price
4. Use bundle base price as last resort

#### Validation Rules:
- **Rule 1**: Price cannot be below parent's price
- **Rule 2**: Price cannot be below bundle base cost
- **Rule 3**: All price changes are versioned and audited

#### Example Flow:
```
System Price (AGENT): GHS 5.00
    └── Partner A sets: GHS 5.50 (their margin: 0.50)
        └── Super Dealer sets: GHS 6.00 (their margin: 0.50)
            └── Dealer sells at: GHS 6.50 (their margin: 0.50)
```

---

### 3. Profit Distribution System

**Location:** `server/src/services/profit.service.js`

Automatic profit calculation and distribution when orders complete:

#### Profit Types:
- `DIRECT_SALE`: Profit from direct sale (sale price - base cost)
- `UPLINE_COMMISSION`: Commission from downline sales
- `TENANT_MARGIN`: Tenant-level margin

#### Distribution Flow:
1. Order completes
2. System calculates total profit (sale price - base cost)
3. Profit is allocated to each level in hierarchy
4. Each participant's wallet is credited
5. All distributions are recorded for audit

---

### 4. Financial Safeguards

**Location:** `server/src/services/wallet.service.js`

Ledger-based wallet system with comprehensive safeguards:

#### Safeguards:
- **Immutable Ledger**: Every transaction creates a permanent ledger entry
- **Duplicate Prevention**: Reference numbers prevent duplicate credits
- **Daily Caps**: Configurable daily credit/debit limits
- **Wallet Freezing**: Admin can freeze wallets with reason
- **Checksum Verification**: Integrity verification for ledger entries
- **Balance Locking**: Lock funds for pending operations

#### Wallet Operations:
```javascript
// Credit with safeguards
await walletService.creditWallet(userId, 100, 'Profit credit', 'REF-001');

// Debit with validation
await walletService.debitWallet(userId, 50, 'Purchase', 'REF-002');

// Freeze wallet
await walletService.freezeWallet(userId, 'Suspicious activity', adminId);

// Verify integrity
await walletService.verifyLedgerIntegrity(walletId);
```

---

### 5. Audit Logging

**Location:** `server/src/services/audit.service.js`

Comprehensive audit trail for compliance:

#### Audit Actions:
- `CREATE`, `UPDATE`, `DELETE` - CRUD operations
- `LOGIN`, `LOGOUT` - Authentication events
- `PRICE_CHANGE` - Pricing modifications
- `WALLET_CREDIT`, `WALLET_DEBIT` - Financial operations
- `PROFIT_ALLOCATION` - Profit distribution
- `ADMIN_OVERRIDE` - Admin actions
- `TENANT_CREATE`, `TENANT_SUSPEND` - Tenant lifecycle

#### Features:
- Entity audit trails
- Security alerts (failed logins, suspicious patterns)
- Compliance reports
- IP address tracking

---

### 6. API Endpoints

#### Tenant Management (`/api/tenants`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List accessible tenants |
| POST | `/` | Create new sub-tenant |
| GET | `/:id` | Get tenant details |
| PUT | `/:id` | Update tenant |
| POST | `/:id/suspend` | Suspend tenant |
| POST | `/:id/activate` | Activate tenant |
| GET | `/:id/hierarchy` | Get hierarchy tree |
| GET | `/:id/prices` | Get tenant prices |
| PUT | `/:id/prices` | Update tenant prices |

#### Admin Controls (`/api/admin`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hierarchy` | Full hierarchy tree |
| GET | `/hierarchy/flat` | Flat tenant list |
| GET | `/prices/ladder/:bundleId` | Price ladder for bundle |
| PUT | `/prices/system` | Update system prices |
| POST | `/prices/revert/:tenantId` | Revert to defaults |
| GET | `/profits/flow/:orderId` | Order profit flow |
| GET | `/profits/report` | Profit report |
| POST | `/wallets/:userId/freeze` | Freeze wallet |
| POST | `/wallets/:userId/unfreeze` | Unfreeze wallet |
| POST | `/wallets/:userId/adjust` | Admin adjustment |
| GET | `/wallets/:walletId/verify` | Verify ledger |
| GET | `/audit/logs` | Query audit logs |
| GET | `/audit/security-alerts` | Security alerts |
| GET | `/dashboard` | Admin statistics |

---

## Database Schema

### New Tables

| Table | Purpose |
|-------|---------|
| `Tenant` | Tenant hierarchy and configuration |
| `WalletLedger` | Immutable wallet transaction ledger |
| `TenantBundlePrice` | Tenant-specific bundle pricing |
| `BundlePriceHistory` | Price change audit trail |
| `ProfitRecord` | Profit distribution records |
| `AuditLog` | System-wide audit logs |
| `SystemSettings` | Configurable system settings |
| `FeatureFlag` | Feature toggles |

### Extended Tables

| Table | New Columns |
|-------|-------------|
| `User` | `tenantId`, `parentUserId`, `hierarchyLevel`, `lastLoginAt`, `failedLoginAttempts` |
| `Wallet` | `lockedBalance`, `dailyCreditLimit`, `isFrozen`, `frozenReason` |
| `Order` | `tenantId`, `unitPrice`, `baseCost`, `profitDistributed` |
| `Bundle` | `baseCost` |

---

## Migration

Run the migration to apply schema changes:

```bash
cd server

# Option 1: Using Prisma
npx prisma migrate dev --name multi_tenant_expansion

# Option 2: Run SQL directly (if needed)
psql -d your_database -f prisma/migrations/multi_tenant_expansion/migration.sql
```

---

## Usage Examples

### Creating a Sub-Tenant

```javascript
const tenant = await tenantService.createSubTenant({
  name: 'Partner ABC',
  slug: 'partner-abc',
  parentId: 'root-tenant-001',
  canCreateSubTenant: true,
  maxSubTenants: 10,
  canSetPrices: true,
  maxDiscountPercent: 10,
  commissionPercent: 5
}, adminUserId);
```

### Setting Tenant Prices

```javascript
await pricingEngine.setTenantPrice({
  tenantId: 'partner-abc',
  bundleId: 'bundle-001',
  role: 'AGENT',
  price: 5.50,
  createdBy: userId
});
```

### Distributing Profits

```javascript
// Automatically triggered on order completion
await profitService.distributeOrderProfits(orderId);

// Or manually
await profitService.creditPendingProfits();
```

### Admin Wallet Control

```javascript
// Freeze wallet
await walletService.freezeWallet(userId, 'Investigation', adminId);

// Make adjustment
await walletService.creditWallet(userId, 100, 'Compensation', 'ADJ-001');
```

---

## Security Considerations

1. **Price Validation**: All prices validated against parent and base cost
2. **Audit Trail**: Every financial operation is logged
3. **Duplicate Prevention**: Reference numbers prevent double-credits
4. **Wallet Freezing**: Instant ability to freeze suspicious wallets
5. **Hierarchical Access**: Users can only access their tenant scope
6. **Rate Limiting**: API rate limits prevent abuse

---

## Configuration

System settings in `SystemSettings` table:

| Key | Description | Default |
|-----|-------------|---------|
| `profit_distribution_enabled` | Auto-distribute profits | true |
| `min_price_margin_percent` | Min margin above cost | 5% |
| `max_hierarchy_depth` | Max tenant depth | 5 |
| `audit_retention_days` | Audit log retention | 365 |
| `daily_wallet_limit_default` | Default daily limit | 100,000 |

---

## File Structure

```
server/src/
├── services/
│   ├── tenant.service.js      # Tenant CRUD & hierarchy
│   ├── pricing.service.js     # Price inheritance engine
│   ├── profit.service.js      # Profit distribution
│   ├── wallet.service.js      # Ledger-based wallet
│   └── audit.service.js       # Audit logging
├── middleware/
│   └── tenant.middleware.js   # Tenant resolution
├── routes/
│   ├── tenant.routes.js       # Tenant API endpoints
│   └── admin.routes.js        # Admin control endpoints
└── controllers/
    └── order.controller.js    # Updated with multi-tenant
```

---

## Next Steps

1. **Frontend Integration**: Add tenant management UI in admin dashboard
2. **Branded Sub-Sites**: Implement dynamic theming per tenant
3. **Reporting**: Build profit/revenue dashboards per tenant
4. **Notifications**: Add profit credit notifications
5. **Testing**: Comprehensive integration tests

---

*Document Version: 1.0*
*Last Updated: January 2025*
