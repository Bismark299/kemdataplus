-- Migration: Add TopUpGH Batch System
-- Adds TopUpGHBatch table and related fields on OrderItem

-- CreateEnum
CREATE TYPE "TopUpGHBatchStatus" AS ENUM ('SUBMITTED', 'PARTIAL', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "topupgh_batches" (
    "id" TEXT NOT NULL,
    "sequenceNum" SERIAL NOT NULL,
    "batchRef" TEXT,
    "topupghOrderId" INTEGER,
    "status" "TopUpGHBatchStatus" NOT NULL DEFAULT 'SUBMITTED',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "itemsAdded" INTEGER NOT NULL DEFAULT 0,
    "itemsSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "previousBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "walletDeducted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "newBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rawResponse" JSONB,
    "sentAt" TIMESTAMP(3),
    "deliveryCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topupgh_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "topupgh_batches_batchRef_key" ON "topupgh_batches"("batchRef");
CREATE INDEX "topupgh_batches_sequenceNum_idx" ON "topupgh_batches"("sequenceNum");
CREATE INDEX "topupgh_batches_topupghOrderId_idx" ON "topupgh_batches"("topupghOrderId");
CREATE INDEX "topupgh_batches_status_idx" ON "topupgh_batches"("status");
CREATE INDEX "topupgh_batches_sentAt_idx" ON "topupgh_batches"("sentAt");
CREATE INDEX "topupgh_batches_createdAt_idx" ON "topupgh_batches"("createdAt");

-- AlterTable order_items: add TopUpGH fields
ALTER TABLE "order_items"
    ADD COLUMN "topupghQueuedAt" TIMESTAMP(3),
    ADD COLUMN "topupghBatchId" TEXT,
    ADD COLUMN "topupghItemId" TEXT,
    ADD COLUMN "topupghDeliveryStatus" TEXT,
    ADD COLUMN "topupghDeliveryDate" TIMESTAMP(3);

-- CreateIndex on new order_items columns
CREATE INDEX "order_items_topupghBatchId_idx" ON "order_items"("topupghBatchId");
CREATE INDEX "order_items_topupghQueuedAt_idx" ON "order_items"("topupghQueuedAt");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_topupghBatchId_fkey"
    FOREIGN KEY ("topupghBatchId") REFERENCES "topupgh_batches"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
