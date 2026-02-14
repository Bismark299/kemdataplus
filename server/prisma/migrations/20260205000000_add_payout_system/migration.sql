-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "agent_payouts" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "agent_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_payouts_reference_key" ON "agent_payouts"("reference");

-- CreateIndex
CREATE INDEX "agent_payouts_userId_idx" ON "agent_payouts"("userId");

-- CreateIndex
CREATE INDEX "agent_payouts_status_idx" ON "agent_payouts"("status");

-- CreateIndex
CREATE INDEX "agent_payouts_createdAt_idx" ON "agent_payouts"("createdAt");

-- CreateIndex
CREATE INDEX "agent_payouts_reference_idx" ON "agent_payouts"("reference");

-- AddForeignKey
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_payouts" ADD CONSTRAINT "agent_payouts_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- ============================================
-- DAILY BATCH PROFIT DISTRIBUTION TABLES
-- ============================================

-- CreateEnum
CREATE TYPE "PendingProfitStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateTable: pending_profits
-- Tracks pending profits waiting for daily batch payout
CREATE TABLE "pending_profits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderReference" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "status" "PendingProfitStatus" NOT NULL DEFAULT 'PENDING',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_profits_pkey" PRIMARY KEY ("id")
);

-- CreateTable: payout_batches
-- Tracks daily payout batch processing
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,
    "profitCount" INTEGER NOT NULL DEFAULT 0,
    "processedBy" TEXT,
    "processorName" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes for pending_profits
CREATE INDEX "pending_profits_userId_idx" ON "pending_profits"("userId");
CREATE INDEX "pending_profits_storefrontId_idx" ON "pending_profits"("storefrontId");
CREATE INDEX "pending_profits_status_idx" ON "pending_profits"("status");
CREATE INDEX "pending_profits_createdAt_idx" ON "pending_profits"("createdAt");
CREATE INDEX "pending_profits_batchId_idx" ON "pending_profits"("batchId");

-- CreateIndexes for payout_batches
CREATE INDEX "payout_batches_processedAt_idx" ON "payout_batches"("processedAt");

-- AddForeignKeys for pending_profits
ALTER TABLE "pending_profits" ADD CONSTRAINT "pending_profits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pending_profits" ADD CONSTRAINT "pending_profits_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pending_profits" ADD CONSTRAINT "pending_profits_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;