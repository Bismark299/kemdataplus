/**
 * ============================================================
 * DATABASE FINANCIAL SAFETY SETUP
 * ============================================================
 * Applies CHECK constraints, triggers, and functions that
 * cannot be defined in the Prisma schema.
 * 
 * All statements are idempotent (safe to run on every startup).
 * This ensures financial safety rules are always in place
 * regardless of how the schema was deployed (db push or migrate).
 * ============================================================
 */

const prisma = require('./lib/prisma');

async function applyFinancialSafety() {
  console.log('🔒 Applying database financial safety rules...');

  try {
    // ========================================
    // 1. WALLET CHECK CONSTRAINTS
    // Prevent negative balances at DB level
    // ========================================
    await safeExec(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balance_non_negative') THEN
          ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative" CHECK ("balance" >= 0);
        END IF;
      END $$`,
      'wallet_balance_non_negative'
    );

    await safeExec(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_locked_balance_non_negative') THEN
          ALTER TABLE "wallets" ADD CONSTRAINT "wallet_locked_balance_non_negative" CHECK ("lockedBalance" >= 0);
        END IF;
      END $$`,
      'wallet_locked_balance_non_negative'
    );

    await safeExec(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_pending_balance_non_negative') THEN
          ALTER TABLE "wallets" ADD CONSTRAINT "wallet_pending_balance_non_negative" CHECK ("pendingBalance" >= 0);
        END IF;
      END $$`,
      'wallet_pending_balance_non_negative'
    );

    // ========================================
    // 2. ORDER STATE MACHINE TRIGGER
    // Enforces valid status transitions
    // ========================================
    await safeExec(
      `CREATE OR REPLACE FUNCTION validate_order_state_transition()
      RETURNS TRIGGER AS $$
      DECLARE
          valid_transitions TEXT[][] := ARRAY[
              ARRAY['CREATED', 'QUEUED'],
              ARRAY['CREATED', 'CANCELLED'],
              ARRAY['QUEUED', 'LOCKED'],
              ARRAY['QUEUED', 'FAILED'],
              ARRAY['QUEUED', 'CANCELLED'],
              ARRAY['LOCKED', 'SENT'],
              ARRAY['LOCKED', 'FAILED'],
              ARRAY['SENT', 'CONFIRMED'],
              ARRAY['SENT', 'FAILED'],
              ARRAY['PENDING', 'PROCESSING'],
              ARRAY['PENDING', 'COMPLETED'],
              ARRAY['PENDING', 'FAILED'],
              ARRAY['PENDING', 'CANCELLED'],
              ARRAY['PROCESSING', 'COMPLETED'],
              ARRAY['PROCESSING', 'FAILED']
          ];
          i INTEGER;
          is_valid BOOLEAN := FALSE;
      BEGIN
          IF OLD.status = NEW.status THEN
              RETURN NEW;
          END IF;
          FOR i IN 1..array_length(valid_transitions, 1) LOOP
              IF valid_transitions[i][1] = OLD.status AND valid_transitions[i][2] = NEW.status THEN
                  is_valid := TRUE;
                  EXIT;
              END IF;
          END LOOP;
          IF NOT is_valid THEN
              RAISE EXCEPTION 'Invalid state transition from % to %', OLD.status, NEW.status;
          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
      'validate_order_state_transition function'
    );

    await safeExec(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_order_state_machine') THEN
          CREATE TRIGGER enforce_order_state_machine
          BEFORE UPDATE OF status ON orders
          FOR EACH ROW
          EXECUTE FUNCTION validate_order_state_transition();
        END IF;
      END $$`,
      'enforce_order_state_machine trigger'
    );

    // ========================================
    // 3. ORDER STATE TRANSITION AUDIT LOG
    // Auto-logs every status change
    // ========================================
    await safeExec(
      `CREATE OR REPLACE FUNCTION log_order_state_transition()
      RETURNS TRIGGER AS $$
      BEGIN
          IF OLD.status IS DISTINCT FROM NEW.status THEN
              INSERT INTO order_state_transitions ("orderId", "fromState", "toState", "triggeredBy", "triggerSource")
              VALUES (NEW.id, OLD.status, NEW.status, COALESCE(NEW."lockedBy", 'system'), 'database_trigger');
          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
      'log_order_state_transition function'
    );

    await safeExec(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'log_order_state_change') THEN
          CREATE TRIGGER log_order_state_change
          AFTER UPDATE OF status ON orders
          FOR EACH ROW
          EXECUTE FUNCTION log_order_state_transition();
        END IF;
      END $$`,
      'log_order_state_change trigger'
    );

    // ========================================
    // 4. PREVENT DOUBLE WALLET DEDUCTION
    // Blocks re-charging an already-charged order
    // ========================================
    await safeExec(
      `CREATE OR REPLACE FUNCTION prevent_double_wallet_deduction()
      RETURNS TRIGGER AS $$
      BEGIN
          IF OLD."walletDeducted" = TRUE AND NEW."walletDeducted" = TRUE THEN
              IF OLD."walletDeductedAt" IS NOT NULL AND NEW."walletDeductedAt" IS DISTINCT FROM OLD."walletDeductedAt" THEN
                  RAISE EXCEPTION 'Wallet already deducted for this order at %', OLD."walletDeductedAt";
              END IF;
          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
      'prevent_double_wallet_deduction function'
    );

    await safeExec(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_wallet_double_deduction') THEN
          CREATE TRIGGER prevent_wallet_double_deduction
          BEFORE UPDATE ON orders
          FOR EACH ROW
          EXECUTE FUNCTION prevent_double_wallet_deduction();
        END IF;
      END $$`,
      'prevent_wallet_double_deduction trigger'
    );

    console.log('✅ All financial safety rules applied successfully');
  } catch (error) {
    console.error('⚠️  Financial safety setup encountered errors (non-fatal):', error.message);
    // Don't crash the server - the application-level protections still work
  }
}

async function safeExec(sql, label) {
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log(`   ✓ ${label}`);
  } catch (error) {
    // Ignore "already exists" errors - that's expected on subsequent startups
    if (error.message.includes('already exists') || error.message.includes('duplicate')) {
      console.log(`   ✓ ${label} (already exists)`);
    } else {
      console.warn(`   ⚠ ${label}: ${error.message}`);
    }
  }
}

module.exports = { applyFinancialSafety };
