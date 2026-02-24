-- Financial Hardening Migration
-- ================================
-- Adds database-level constraints to prevent financial loss:
-- 1. Fix any existing negative balances from the duplicate-charge bug
-- 2. CHECK constraint on wallet balance (cannot go negative)
-- 3. CHECK constraint on locked balance
-- 4. CHECK constraint on pending balance

-- STEP 0: Fix any existing negative balances before adding constraints
-- These wallets were damaged by the duplicate-charge bug. Reset to 0.
UPDATE "wallets" SET "balance" = 0 WHERE "balance" < 0;
UPDATE "wallets" SET "lockedBalance" = 0 WHERE "lockedBalance" < 0;
UPDATE "wallets" SET "pendingBalance" = 0 WHERE "pendingBalance" < 0;

-- CRITICAL: Prevent negative wallet balance at database level
-- This is the LAST line of defense - even if application code has bugs,
-- the database will reject any update that would make balance negative
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative" CHECK ("balance" >= 0);

-- Prevent locked balance from going negative
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_locked_balance_non_negative" CHECK ("lockedBalance" >= 0);

-- Ensure pending balance cannot be negative
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_pending_balance_non_negative" CHECK ("pendingBalance" >= 0);
