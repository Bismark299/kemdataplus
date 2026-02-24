-- =====================================================
-- FINANCIAL-GRADE ORDER PROCESSING MIGRATION
-- =====================================================
-- This migration adds idempotency, audit logging, and
-- state machine enforcement for financially-safe operations.
-- =====================================================
-- NOTE: The standalone tables (idempotency_keys, api_audit_logs,
-- order_state_transitions) and the orders financial safety columns
-- were already created via prisma db push. This migration only
-- adds the triggers and functions that weren't created yet.

-- 1. ENUM changes handled by Prisma schema

-- 2-4. TABLES ALREADY EXIST (idempotency_keys, api_audit_logs, order_state_transitions)
-- Created via prisma db push with camelCase columns. Skipping.

-- 5. ORDERS COLUMNS ALREADY EXIST
-- externalReference, externalStatus, apiSentAt, apiConfirmedAt,
-- retryCount, maxRetries, nextRetryAt, lockedAt, lockedBy,
-- lockExpiresAt, idempotencyKey, walletDeducted, walletDeductedAt
-- All created via prisma db push with camelCase. Skipping.

-- 6. FUNCTION: Validate state transitions (enforces state machine)
CREATE OR REPLACE FUNCTION validate_order_state_transition()
RETURNS TRIGGER AS $$
DECLARE
    valid_transitions TEXT[][] := ARRAY[
        -- FROM -> TO (allowed transitions)
        ARRAY['CREATED', 'QUEUED'],
        ARRAY['CREATED', 'CANCELLED'],
        ARRAY['QUEUED', 'LOCKED'],
        ARRAY['QUEUED', 'FAILED'],
        ARRAY['QUEUED', 'CANCELLED'],
        ARRAY['LOCKED', 'SENT'],
        ARRAY['LOCKED', 'FAILED'],
        ARRAY['SENT', 'CONFIRMED'],
        ARRAY['SENT', 'FAILED'],
        -- Legacy compatibility
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
    -- Allow if status hasn't changed
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;
    
    -- Check if transition is valid
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
$$ LANGUAGE plpgsql;

-- Only create trigger if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_order_state_machine') THEN
        CREATE TRIGGER enforce_order_state_machine
        BEFORE UPDATE OF status ON orders
        FOR EACH ROW
        EXECUTE FUNCTION validate_order_state_transition();
    END IF;
END
$$;

-- 7. FUNCTION: Log state transitions automatically
-- NOTE: Uses camelCase column names matching Prisma schema
CREATE OR REPLACE FUNCTION log_order_state_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO order_state_transitions ("orderId", "fromState", "toState", "triggeredBy", "triggerSource")
        VALUES (NEW.id, OLD.status, NEW.status, COALESCE(NEW."lockedBy", 'system'), 'database_trigger');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'log_order_state_change') THEN
        CREATE TRIGGER log_order_state_change
        AFTER UPDATE OF status ON orders
        FOR EACH ROW
        EXECUTE FUNCTION log_order_state_transition();
    END IF;
END
$$;

-- 8. PREVENT DOUBLE WALLET DEDUCTION
-- NOTE: Uses camelCase column names matching Prisma schema
CREATE OR REPLACE FUNCTION prevent_double_wallet_deduction()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."walletDeducted" = TRUE AND NEW."walletDeducted" = TRUE THEN
        -- Already deducted, don't allow any wallet-related changes
        IF OLD."walletDeductedAt" IS NOT NULL AND NEW."walletDeductedAt" IS DISTINCT FROM OLD."walletDeductedAt" THEN
            RAISE EXCEPTION 'Wallet already deducted for this order at %', OLD."walletDeductedAt";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_wallet_double_deduction') THEN
        CREATE TRIGGER prevent_wallet_double_deduction
        BEFORE UPDATE ON orders
        FOR EACH ROW
        EXECUTE FUNCTION prevent_double_wallet_deduction();
    END IF;
END
$$;
