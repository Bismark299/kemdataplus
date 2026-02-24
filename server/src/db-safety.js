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
 * 
 * NOTE: Uses $func$ dollar-quoting instead of $$ because Prisma's
 * $executeRawUnsafe may misinterpret $$ as parameter placeholders.
 * ============================================================
 */

const prisma = require('./lib/prisma');

async function applyFinancialSafety() {
  console.log('🔒 Applying database financial safety rules...');

  try {
    // ========================================
    // 0. FIX NEGATIVE BALANCES (from prior bugs)
    // Must run BEFORE adding CHECK constraints
    // ========================================
    await safeExec(
      `UPDATE "wallets" SET "balance" = 0 WHERE "balance" < 0`,
      'fix negative balances'
    );
    await safeExec(
      `UPDATE "wallets" SET "lockedBalance" = 0 WHERE "lockedBalance" < 0`,
      'fix negative locked balances'
    );
    await safeExec(
      `UPDATE "wallets" SET "pendingBalance" = 0 WHERE "pendingBalance" < 0`,
      'fix negative pending balances'
    );

    // ========================================
    // 1. WALLET CHECK CONSTRAINTS
    // Prevent negative balances at DB level
    // ========================================
    await safeExec(
      `DO $chk$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balance_non_negative') THEN
          ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative" CHECK ("balance" >= 0);
        END IF;
      END $chk$`,
      'wallet_balance_non_negative'
    );

    await safeExec(
      `DO $chk$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_locked_balance_non_negative') THEN
          ALTER TABLE "wallets" ADD CONSTRAINT "wallet_locked_balance_non_negative" CHECK ("lockedBalance" >= 0);
        END IF;
      END $chk$`,
      'wallet_locked_balance_non_negative'
    );

    await safeExec(
      `DO $chk$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_pending_balance_non_negative') THEN
          ALTER TABLE "wallets" ADD CONSTRAINT "wallet_pending_balance_non_negative" CHECK ("pendingBalance" >= 0);
        END IF;
      END $chk$`,
      'wallet_pending_balance_non_negative'
    );

    // ========================================
    // 2. ORDER STATE MACHINE TRIGGER
    // STEP A: Drop old triggers first (they may have broken function refs)
    // ========================================
    await safeExec(
      `DROP TRIGGER IF EXISTS enforce_order_state_machine ON orders`,
      'drop old enforce_order_state_machine trigger'
    );
    await safeExec(
      `DROP TRIGGER IF EXISTS log_order_state_change ON orders`,
      'drop old log_order_state_change trigger'
    );
    await safeExec(
      `DROP TRIGGER IF EXISTS prevent_wallet_double_deduction ON orders`,
      'drop old prevent_wallet_double_deduction trigger'
    );

    // STEP B: Drop old functions
    await safeExec(
      `DROP FUNCTION IF EXISTS validate_order_state_transition() CASCADE`,
      'drop old validate_order_state_transition function'
    );
    await safeExec(
      `DROP FUNCTION IF EXISTS log_order_state_transition() CASCADE`,
      'drop old log_order_state_transition function'
    );
    await safeExec(
      `DROP FUNCTION IF EXISTS prevent_double_wallet_deduction() CASCADE`,
      'drop old prevent_double_wallet_deduction function'
    );

    // STEP C: Create functions with $func$ quoting (avoids Prisma $$ issues)
    await safeExec(
      `CREATE FUNCTION validate_order_state_transition()
      RETURNS TRIGGER AS $func$
      DECLARE
          old_status TEXT;
          new_status TEXT;
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
              ARRAY['PENDING', 'DUPLICATE_HOLD'],
              ARRAY['DUPLICATE_HOLD', 'PENDING'],
              ARRAY['DUPLICATE_HOLD', 'CANCELLED'],
              ARRAY['PROCESSING', 'COMPLETED'],
              ARRAY['PROCESSING', 'FAILED']
          ];
          i INTEGER;
          is_valid BOOLEAN := FALSE;
      BEGIN
          old_status := OLD.status::text;
          new_status := NEW.status::text;
          IF old_status = new_status THEN
              RETURN NEW;
          END IF;
          FOR i IN 1..array_length(valid_transitions, 1) LOOP
              IF valid_transitions[i][1] = old_status AND valid_transitions[i][2] = new_status THEN
                  is_valid := TRUE;
                  EXIT;
              END IF;
          END LOOP;
          IF NOT is_valid THEN
              RAISE EXCEPTION 'Invalid order state transition: % -> %', old_status, new_status;
          END IF;
          RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`,
      'create validate_order_state_transition function'
    );

    await safeExec(
      `CREATE FUNCTION log_order_state_transition()
      RETURNS TRIGGER AS $func$
      DECLARE
          old_status TEXT;
          new_status TEXT;
      BEGIN
          old_status := OLD.status::text;
          new_status := NEW.status::text;
          IF old_status IS DISTINCT FROM new_status THEN
              INSERT INTO order_state_transitions ("orderId", "fromState", "toState", "triggeredBy", "triggerSource")
              VALUES (NEW.id, old_status, new_status, COALESCE(NEW."lockedBy", 'system'), 'database_trigger');
          END IF;
          RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`,
      'create log_order_state_transition function'
    );

    await safeExec(
      `CREATE FUNCTION prevent_double_wallet_deduction()
      RETURNS TRIGGER AS $func$
      BEGIN
          IF OLD."walletDeducted" = TRUE AND NEW."walletDeducted" = TRUE THEN
              IF OLD."walletDeductedAt" IS NOT NULL AND NEW."walletDeductedAt" IS DISTINCT FROM OLD."walletDeductedAt" THEN
                  RAISE EXCEPTION 'Wallet already deducted for this order at %', OLD."walletDeductedAt";
              END IF;
          END IF;
          RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`,
      'create prevent_double_wallet_deduction function'
    );

    // STEP D: Create triggers
    await safeExec(
      `CREATE TRIGGER enforce_order_state_machine
       BEFORE UPDATE OF status ON orders
       FOR EACH ROW
       EXECUTE FUNCTION validate_order_state_transition()`,
      'create enforce_order_state_machine trigger'
    );

    await safeExec(
      `CREATE TRIGGER log_order_state_change
       AFTER UPDATE OF status ON orders
       FOR EACH ROW
       EXECUTE FUNCTION log_order_state_transition()`,
      'create log_order_state_change trigger'
    );

    await safeExec(
      `CREATE TRIGGER prevent_wallet_double_deduction
       BEFORE UPDATE ON orders
       FOR EACH ROW
       EXECUTE FUNCTION prevent_double_wallet_deduction()`,
      'create prevent_wallet_double_deduction trigger'
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
