-- Multi-Tenant Reseller Platform Migration
-- This migration adds tenant hierarchy, pricing inheritance, 
-- profit distribution, and financial safeguards
-- NOTE: Uses lowercase table names to match existing schema (users, wallets, orders, bundles)

-- ============================================
-- STEP 1: Add new ENUMS (if not exists)
-- ============================================

-- Add TenantStatus enum
DO $$ BEGIN
    CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING', 'DISABLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add AuditAction enum
DO $$ BEGIN
    CREATE TYPE "AuditAction" AS ENUM (
        'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT',
        'PRICE_CHANGE', 'WALLET_CREDIT', 'WALLET_DEBIT',
        'PROFIT_ALLOCATION', 'ORDER_CREATE', 'ORDER_COMPLETE',
        'ORDER_CANCEL', 'ADMIN_OVERRIDE', 'TENANT_CREATE',
        'TENANT_SUSPEND', 'ROLE_CHANGE'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add new transaction types
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'PROFIT_CREDIT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'COMMISSION';

-- ============================================
-- STEP 2: Create tenants table
-- ============================================

CREATE TABLE IF NOT EXISTS "tenants" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "parentId" TEXT,
    "hierarchyLevel" INTEGER NOT NULL DEFAULT 0,
    "hierarchyPath" TEXT NOT NULL DEFAULT '/',
    "brandName" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT DEFAULT '#024959',
    "secondaryColor" TEXT DEFAULT '#F2C12E',
    "canCreateSubTenant" BOOLEAN NOT NULL DEFAULT false,
    "maxSubTenants" INTEGER NOT NULL DEFAULT 0,
    "canSetPrices" BOOLEAN NOT NULL DEFAULT false,
    "maxDiscountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_domain_key" ON "tenants"("domain");
CREATE INDEX IF NOT EXISTS "tenants_parentId_idx" ON "tenants"("parentId");
CREATE INDEX IF NOT EXISTS "tenants_hierarchyPath_idx" ON "tenants"("hierarchyPath");

-- Add foreign key constraint for tenant hierarchy
ALTER TABLE "tenants" 
    ADD CONSTRAINT "tenants_parentId_fkey" 
    FOREIGN KEY ("parentId") REFERENCES "tenants"("id") 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- STEP 3: Extend users table for multi-tenancy
-- ============================================

-- Add tenant fields to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "parentUserId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hierarchyLevel" INTEGER DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginIp" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);

-- Add indexes
CREATE INDEX IF NOT EXISTS "users_tenantId_idx" ON "users"("tenantId");
CREATE INDEX IF NOT EXISTS "users_parentUserId_idx" ON "users"("parentUserId");

-- Add foreign key constraints
ALTER TABLE "users" 
    ADD CONSTRAINT "users_tenantId_fkey" 
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") 
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "users" 
    ADD CONSTRAINT "users_parentUserId_fkey" 
    FOREIGN KEY ("parentUserId") REFERENCES "users"("id") 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- STEP 4: Extend wallets for financial safeguards
-- ============================================

ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "lockedBalance" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "dailyCreditLimit" DOUBLE PRECISION;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "dailyDebitLimit" DOUBLE PRECISION;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "dailyCreditUsed" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "dailyDebitUsed" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "lastDailyReset" TIMESTAMP(3);
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "isFrozen" BOOLEAN DEFAULT false;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "frozenReason" TEXT;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "frozenAt" TIMESTAMP(3);
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "frozenBy" TEXT;

-- ============================================
-- STEP 5: Create wallet_ledger table (immutable entries)
-- ============================================

CREATE TABLE IF NOT EXISTS "wallet_ledger" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "walletId" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "runningBalance" DOUBLE PRECISION NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_ledger_reference_key" ON "wallet_ledger"("reference");
CREATE INDEX IF NOT EXISTS "wallet_ledger_walletId_idx" ON "wallet_ledger"("walletId");
CREATE INDEX IF NOT EXISTS "wallet_ledger_createdAt_idx" ON "wallet_ledger"("createdAt");

ALTER TABLE "wallet_ledger" 
    ADD CONSTRAINT "wallet_ledger_walletId_fkey" 
    FOREIGN KEY ("walletId") REFERENCES "wallets"("id") 
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================
-- STEP 6: Create tenant_bundle_prices table
-- ============================================

CREATE TABLE IF NOT EXISTS "tenant_bundle_prices" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "parentPriceAtCreation" DOUBLE PRECISION,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_bundle_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_bundle_prices_tenantId_bundleId_role_key" 
    ON "tenant_bundle_prices"("tenantId", "bundleId", "role");
CREATE INDEX IF NOT EXISTS "tenant_bundle_prices_tenantId_idx" ON "tenant_bundle_prices"("tenantId");
CREATE INDEX IF NOT EXISTS "tenant_bundle_prices_bundleId_idx" ON "tenant_bundle_prices"("bundleId");

ALTER TABLE "tenant_bundle_prices" 
    ADD CONSTRAINT "tenant_bundle_prices_tenantId_fkey" 
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") 
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_bundle_prices" 
    ADD CONSTRAINT "tenant_bundle_prices_bundleId_fkey" 
    FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") 
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================
-- STEP 7: Create bundle_price_history table
-- ============================================

CREATE TABLE IF NOT EXISTS "bundle_price_history" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "bundleId" TEXT NOT NULL,
    "tenantId" TEXT,
    "role" "Role" NOT NULL,
    "oldPrice" DOUBLE PRECISION NOT NULL,
    "newPrice" DOUBLE PRECISION NOT NULL,
    "changedBy" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_price_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bundle_price_history_bundleId_idx" ON "bundle_price_history"("bundleId");
CREATE INDEX IF NOT EXISTS "bundle_price_history_tenantId_idx" ON "bundle_price_history"("tenantId");
CREATE INDEX IF NOT EXISTS "bundle_price_history_createdAt_idx" ON "bundle_price_history"("createdAt");

ALTER TABLE "bundle_price_history" 
    ADD CONSTRAINT "bundle_price_history_bundleId_fkey" 
    FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") 
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bundle_price_history" 
    ADD CONSTRAINT "bundle_price_history_tenantId_fkey" 
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- STEP 8: Create profit_records table
-- ============================================

CREATE TABLE IF NOT EXISTS "profit_records" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "profitType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "baseCost" DOUBLE PRECISION,
    "salePrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "creditedAt" TIMESTAMP(3),
    "creditedToWalletId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "profit_records_orderId_idx" ON "profit_records"("orderId");
CREATE INDEX IF NOT EXISTS "profit_records_userId_idx" ON "profit_records"("userId");
CREATE INDEX IF NOT EXISTS "profit_records_tenantId_idx" ON "profit_records"("tenantId");
CREATE INDEX IF NOT EXISTS "profit_records_status_idx" ON "profit_records"("status");

ALTER TABLE "profit_records" 
    ADD CONSTRAINT "profit_records_orderId_fkey" 
    FOREIGN KEY ("orderId") REFERENCES "orders"("id") 
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "profit_records" 
    ADD CONSTRAINT "profit_records_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "users"("id") 
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "profit_records" 
    ADD CONSTRAINT "profit_records_tenantId_fkey" 
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- STEP 9: Extend orders table
-- ============================================

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "unitPrice" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "baseCost" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "profitDistributed" BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS "orders_tenantId_idx" ON "orders"("tenantId");

ALTER TABLE "orders" 
    ADD CONSTRAINT "orders_tenantId_fkey" 
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") 
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- STEP 10: Create audit_logs table
-- ============================================

CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT,
    "tenantId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "previousValues" JSONB,
    "newValues" JSONB,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_userId_idx" ON "audit_logs"("userId");
CREATE INDEX IF NOT EXISTS "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX IF NOT EXISTS "audit_logs_entityType_idx" ON "audit_logs"("entityType");
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- ============================================
-- STEP 11: Create system_settings table
-- ============================================

CREATE TABLE IF NOT EXISTS "system_settings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_settings_key_key" ON "system_settings"("key");

-- ============================================
-- STEP 12: Create feature_flags table
-- ============================================

CREATE TABLE IF NOT EXISTS "feature_flags" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tenantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roleAccess" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "feature_flags_name_key" ON "feature_flags"("name");

-- ============================================
-- STEP 13: Add baseCost to bundles if not exists
-- ============================================

ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "baseCost" DOUBLE PRECISION DEFAULT 0;

-- ============================================
-- STEP 14: Create default root tenant
-- ============================================

INSERT INTO "tenants" ("id", "name", "slug", "hierarchyLevel", "hierarchyPath", "canCreateSubTenant", "maxSubTenants", "canSetPrices", "status")
VALUES ('root-tenant-001', 'KemDataplus', 'root', 0, '/', true, 9999, true, 'ACTIVE')
ON CONFLICT ("slug") DO NOTHING;

-- ============================================
-- STEP 15: Insert default system settings
-- ============================================

INSERT INTO "system_settings" ("key", "value", "description", "isPublic")
VALUES 
    ('profit_distribution_enabled', '"true"', 'Enable automatic profit distribution on order completion', false),
    ('min_price_margin_percent', '"5"', 'Minimum margin required above base cost', false),
    ('max_hierarchy_depth', '"5"', 'Maximum tenant hierarchy depth', false),
    ('audit_retention_days', '"365"', 'Days to retain audit logs', false),
    ('daily_wallet_limit_default', '"100000"', 'Default daily wallet transaction limit', false)
ON CONFLICT ("key") DO NOTHING;

-- ============================================
-- COMPLETE
-- ============================================

SELECT 'Multi-tenant migration completed successfully!' as status;
