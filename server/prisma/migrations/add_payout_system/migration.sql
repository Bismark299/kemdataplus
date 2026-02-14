-- Create PayoutStatus enum
DO $$ BEGIN
    CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create agent_payouts table
CREATE TABLE IF NOT EXISTS "agent_payouts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT,
    "bankName" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'mobile_money',
    "recipientCode" TEXT,
    "transferCode" TEXT,
    "reference" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "agent_payouts_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE UNIQUE INDEX IF NOT EXISTS "agent_payouts_reference_key" ON "agent_payouts"("reference");
CREATE INDEX IF NOT EXISTS "agent_payouts_userId_idx" ON "agent_payouts"("userId");
CREATE INDEX IF NOT EXISTS "agent_payouts_status_idx" ON "agent_payouts"("status");
CREATE INDEX IF NOT EXISTS "agent_payouts_createdAt_idx" ON "agent_payouts"("createdAt");
CREATE INDEX IF NOT EXISTS "agent_payouts_reference_idx" ON "agent_payouts"("reference");

-- Add foreign key constraints
ALTER TABLE "agent_payouts" 
    ADD CONSTRAINT "agent_payouts_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_payouts" 
    ADD CONSTRAINT "agent_payouts_reviewedBy_fkey" 
    FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
