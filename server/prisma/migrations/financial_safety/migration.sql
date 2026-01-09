-- =====================================================
-- FINANCIAL-GRADE ORDER PROCESSING MIGRATION
-- =====================================================
-- This migration adds idempotency, audit logging, and
-- state machine enforcement for financially-safe operations.
-- =====================================================

-- 1. NEW ENUM: Extended Order Status (State Machine)
-- Note: Prisma handles enum changes differently, this is for reference
-- The actual enum changes are in schema.prisma

-- 2. IDEMPOTENCY KEY TABLE
-- Prevents duplicate operations even under concurrent requests
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "order_id" TEXT,
    "request_hash" TEXT NOT NULL,
    "response_data" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "idempotency_keys_key_unique" UNIQUE ("key")
);

CREATE INDEX "idempotency_keys_user_id_idx" ON "idempotency_keys"("user_id");
CREATE INDEX "idempotency_keys_order_id_idx" ON "idempotency_keys"("order_id");
CREATE INDEX "idempotency_keys_status_idx" ON "idempotency_keys"("status");
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- 3. API AUDIT LOG TABLE
-- Immutable, append-only log of all external API interactions
CREATE TABLE IF NOT EXISTS "api_audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    "order_id" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "operation" TEXT NOT NULL,
    "external_reference" TEXT,
    "request_url" TEXT NOT NULL,
    "request_method" TEXT NOT NULL,
    "request_headers_hash" TEXT,
    "request_payload_hash" TEXT NOT NULL,
    "request_payload" JSONB,
    "response_status" INTEGER,
    "response_payload_hash" TEXT,
    "response_payload" JSONB,
    "response_time_ms" INTEGER,
    "retry_number" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "error_code" TEXT,
    "server_instance" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Immutability: these columns cannot be updated after insert
    CONSTRAINT "api_audit_no_update" CHECK (TRUE)
);

CREATE INDEX "api_audit_logs_order_id_idx" ON "api_audit_logs"("order_id");
CREATE INDEX "api_audit_logs_external_reference_idx" ON "api_audit_logs"("external_reference");
CREATE INDEX "api_audit_logs_idempotency_key_idx" ON "api_audit_logs"("idempotency_key");
CREATE INDEX "api_audit_logs_created_at_idx" ON "api_audit_logs"("created_at");
CREATE INDEX "api_audit_logs_operation_idx" ON "api_audit_logs"("operation");

-- 4. ORDER STATE TRANSITIONS TABLE
-- Complete audit trail of all state changes
CREATE TABLE IF NOT EXISTS "order_state_transitions" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    "order_id" TEXT NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "trigger_source" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "order_state_transitions_order_id_idx" ON "order_state_transitions"("order_id");
CREATE INDEX "order_state_transitions_created_at_idx" ON "order_state_transitions"("created_at");

-- 5. ADD COLUMNS TO ORDERS TABLE FOR FINANCIAL SAFETY
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external_reference" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "external_status" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "api_sent_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "api_confirmed_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "max_retries" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "locked_by" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "lock_expires_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "wallet_deducted" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "wallet_deducted_at" TIMESTAMP(3);

-- Add unique constraint on external reference (prevents duplicates from API)
CREATE UNIQUE INDEX IF NOT EXISTS "orders_external_reference_unique" 
ON "orders"("external_reference") WHERE "external_reference" IS NOT NULL;

-- Add unique constraint on idempotency key per user
CREATE UNIQUE INDEX IF NOT EXISTS "orders_idempotency_key_unique" 
ON "orders"("idempotency_key") WHERE "idempotency_key" IS NOT NULL;

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
CREATE OR REPLACE FUNCTION log_order_state_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO order_state_transitions (order_id, from_state, to_state, triggered_by, trigger_source)
        VALUES (NEW.id, OLD.status, NEW.status, COALESCE(NEW.locked_by, 'system'), 'database_trigger');
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
CREATE OR REPLACE FUNCTION prevent_double_wallet_deduction()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.wallet_deducted = TRUE AND NEW.wallet_deducted = TRUE THEN
        -- Already deducted, don't allow any wallet-related changes
        IF OLD.wallet_deducted_at IS NOT NULL AND NEW.wallet_deducted_at IS DISTINCT FROM OLD.wallet_deducted_at THEN
            RAISE EXCEPTION 'Wallet already deducted for this order at %', OLD.wallet_deducted_at;
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
