/*
  Warnings:

  - You are about to drop the column `previousValues` on the `audit_logs` table. All the data in the column will be lost.
  - You are about to drop the column `reason` on the `bundle_price_history` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `feature_flags` table. All the data in the column will be lost.
  - You are about to drop the column `baseCost` on the `profit_records` table. All the data in the column will be lost.
  - You are about to drop the column `creditedToWalletId` on the `profit_records` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `profit_records` table. All the data in the column will be lost.
  - You are about to drop the column `salePrice` on the `profit_records` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `profit_records` table. All the data in the column will be lost.
  - The `status` column on the `profit_records` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `createdAt` on the `system_settings` table. All the data in the column will be lost.
  - You are about to drop the column `effectiveFrom` on the `tenant_bundle_prices` table. All the data in the column will be lost.
  - You are about to drop the column `effectiveTo` on the `tenant_bundle_prices` table. All the data in the column will be lost.
  - You are about to drop the column `version` on the `tenant_bundle_prices` table. All the data in the column will be lost.
  - You are about to drop the column `canSetPrices` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `commissionPercent` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `maxDiscountPercent` on the `tenants` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `wallet_ledger` table. All the data in the column will be lost.
  - You are about to drop the column `dailyCreditUsed` on the `wallets` table. All the data in the column will be lost.
  - You are about to drop the column `dailyDebitUsed` on the `wallets` table. All the data in the column will be lost.
  - You are about to drop the column `lastDailyReset` on the `wallets` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[storefrontOrderId]` on the table `orders` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[momoReference]` on the table `transactions` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[resetToken]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[momoTransactionId]` on the table `wallet_ledger` will be added. If there are existing duplicate values, this will fail.
  - Made the column `baseCost` on table `bundles` required. This step will fail if there are existing NULL values in that column.
  - Made the column `unitPrice` on table `orders` required. This step will fail if there are existing NULL values in that column.
  - Made the column `baseCost` on table `orders` required. This step will fail if there are existing NULL values in that column.
  - Made the column `profitDistributed` on table `orders` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `beneficiaryId` to the `profit_records` table without a default value. This is not possible if the table is not empty.
  - Added the required column `costPrice` to the `profit_records` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hierarchyLevel` to the `profit_records` table without a default value. This is not possible if the table is not empty.
  - Added the required column `marginPercent` to the `profit_records` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sellingPrice` to the `profit_records` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sourceUserId` to the `profit_records` table without a default value. This is not possible if the table is not empty.
  - Made the column `parentPriceAtCreation` on table `tenant_bundle_prices` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `updatedAt` to the `transactions` table without a default value. This is not possible if the table is not empty.
  - Made the column `hierarchyLevel` on table `users` required. This step will fail if there are existing NULL values in that column.
  - Made the column `failedLoginAttempts` on table `users` required. This step will fail if there are existing NULL values in that column.
  - Changed the type of `entryType` on the `wallet_ledger` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Made the column `lockedBalance` on table `wallets` required. This step will fail if there are existing NULL values in that column.
  - Made the column `isFrozen` on table `wallets` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "StorefrontStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED', 'PENDING_APPROVAL');

-- CreateEnum
CREATE TYPE "MomoTransactionStatus" AS ENUM ('INITIATED', 'PENDING_CLAIM', 'CLAIMED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "TransactionStatus" ADD VALUE 'REVERSED';

-- DropForeignKey
ALTER TABLE "bundle_price_history" DROP CONSTRAINT "bundle_price_history_bundleId_fkey";

-- DropForeignKey
ALTER TABLE "bundle_price_history" DROP CONSTRAINT "bundle_price_history_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "profit_records" DROP CONSTRAINT "profit_records_orderId_fkey";

-- DropForeignKey
ALTER TABLE "profit_records" DROP CONSTRAINT "profit_records_userId_fkey";

-- DropIndex
DROP INDEX "audit_logs_entityType_idx";

-- DropIndex
DROP INDEX "profit_records_status_idx";

-- DropIndex
DROP INDEX "profit_records_userId_idx";

-- AlterTable
ALTER TABLE "audit_logs" DROP COLUMN "previousValues",
ADD COLUMN     "oldValues" JSONB,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "bundle_price_history" DROP COLUMN "reason",
ADD COLUMN     "changeReason" TEXT,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "outOfStock" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "baseCost" SET NOT NULL;

-- AlterTable
ALTER TABLE "feature_flags" DROP COLUMN "metadata",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "tenantIds" DROP DEFAULT,
ALTER COLUMN "roleAccess" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "priceSnapshot" DOUBLE PRECISION,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "processedBy" TEXT,
ADD COLUMN     "storefrontId" TEXT,
ADD COLUMN     "storefrontOrderId" TEXT,
ALTER COLUMN "unitPrice" SET NOT NULL,
ALTER COLUMN "unitPrice" SET DEFAULT 0,
ALTER COLUMN "baseCost" SET NOT NULL,
ALTER COLUMN "baseCost" SET DEFAULT 0,
ALTER COLUMN "profitDistributed" SET NOT NULL;

-- AlterTable
ALTER TABLE "profit_records" DROP COLUMN "baseCost",
DROP COLUMN "creditedToWalletId",
DROP COLUMN "metadata",
DROP COLUMN "salePrice",
DROP COLUMN "userId",
ADD COLUMN     "beneficiaryId" TEXT NOT NULL,
ADD COLUMN     "costPrice" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "hierarchyLevel" INTEGER NOT NULL,
ADD COLUMN     "marginPercent" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "sellingPrice" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "sourceUserId" TEXT NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "status",
ADD COLUMN     "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "system_settings" DROP COLUMN "createdAt",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenant_bundle_prices" DROP COLUMN "effectiveFrom",
DROP COLUMN "effectiveTo",
DROP COLUMN "version",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "parentPriceAtCreation" SET NOT NULL,
ALTER COLUMN "parentPriceAtCreation" SET DEFAULT 0,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" DROP COLUMN "canSetPrices",
DROP COLUMN "commissionPercent",
DROP COLUMN "maxDiscountPercent",
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "dailyTransactionCap" DOUBLE PRECISION,
ADD COLUMN     "isRoot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxUsers" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "minProfitMargin" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "monthlyTransactionCap" DOUBLE PRECISION,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "momoPhone" TEXT,
ADD COLUMN     "momoReference" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedBy" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "canCreateUsers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxDownlineUsers" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpiry" TIMESTAMP(3),
ALTER COLUMN "hierarchyLevel" SET NOT NULL,
ALTER COLUMN "failedLoginAttempts" SET NOT NULL;

-- AlterTable
ALTER TABLE "wallet_ledger" DROP COLUMN "metadata",
ADD COLUMN     "momoTransactionId" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "profitRecordId" TEXT,
ADD COLUMN     "transactionId" TEXT,
ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "entryType",
ADD COLUMN     "entryType" "TransactionType" NOT NULL;

-- AlterTable
ALTER TABLE "wallets" DROP COLUMN "dailyCreditUsed",
DROP COLUMN "dailyDebitUsed",
DROP COLUMN "lastDailyReset",
ADD COLUMN     "dailyCredits" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "dailyDebits" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "dailyResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "pendingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
ALTER COLUMN "lockedBalance" SET NOT NULL,
ALTER COLUMN "isFrozen" SET NOT NULL;

-- CreateTable
CREATE TABLE "storefronts" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "tenantId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "primaryColor" TEXT DEFAULT '#024959',
    "accentColor" TEXT DEFAULT '#F2C12E',
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "contactWhatsapp" TEXT,
    "momoNumber" TEXT,
    "momoName" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "showOwnerInfo" BOOLEAN NOT NULL DEFAULT false,
    "allowDirectContact" BOOLEAN NOT NULL DEFAULT true,
    "status" "StorefrontStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "suspendedBy" TEXT,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefronts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_products" (
    "id" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "displayName" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "priceSnapshot" DOUBLE PRECISION NOT NULL,
    "sellingPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_orders" (
    "id" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "storefrontProductId" TEXT,
    "customerPhone" TEXT NOT NULL,
    "customerName" TEXT,
    "bundleId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "ownerCost" DOUBLE PRECISION NOT NULL,
    "ownerProfit" DOUBLE PRECISION NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "paymentReference" TEXT,
    "paymentPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "momo_transactions" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "momoReference" TEXT,
    "targetUserId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "claimedBy" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "targetPhone" TEXT NOT NULL,
    "status" "MomoTransactionStatus" NOT NULL DEFAULT 'INITIATED',
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimCode" TEXT,
    "verificationNotes" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "momo_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_customers" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_favorites" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_slug_key" ON "storefronts"("slug");

-- CreateIndex
CREATE INDEX "storefronts_ownerId_idx" ON "storefronts"("ownerId");

-- CreateIndex
CREATE INDEX "storefronts_tenantId_idx" ON "storefronts"("tenantId");

-- CreateIndex
CREATE INDEX "storefronts_slug_idx" ON "storefronts"("slug");

-- CreateIndex
CREATE INDEX "storefronts_status_idx" ON "storefronts"("status");

-- CreateIndex
CREATE INDEX "storefront_products_storefrontId_idx" ON "storefront_products"("storefrontId");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_products_storefrontId_bundleId_key" ON "storefront_products"("storefrontId", "bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_orders_orderId_key" ON "storefront_orders"("orderId");

-- CreateIndex
CREATE INDEX "storefront_orders_storefrontId_idx" ON "storefront_orders"("storefrontId");

-- CreateIndex
CREATE INDEX "storefront_orders_customerPhone_idx" ON "storefront_orders"("customerPhone");

-- CreateIndex
CREATE INDEX "storefront_orders_status_idx" ON "storefront_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "momo_transactions_reference_key" ON "momo_transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "momo_transactions_momoReference_key" ON "momo_transactions"("momoReference");

-- CreateIndex
CREATE INDEX "momo_transactions_targetUserId_idx" ON "momo_transactions"("targetUserId");

-- CreateIndex
CREATE INDEX "momo_transactions_status_idx" ON "momo_transactions"("status");

-- CreateIndex
CREATE INDEX "momo_transactions_reference_idx" ON "momo_transactions"("reference");

-- CreateIndex
CREATE INDEX "momo_transactions_momoReference_idx" ON "momo_transactions"("momoReference");

-- CreateIndex
CREATE INDEX "momo_transactions_expiresAt_idx" ON "momo_transactions"("expiresAt");

-- CreateIndex
CREATE INDEX "store_customers_phone_idx" ON "store_customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "store_customers_phone_key" ON "store_customers"("phone");

-- CreateIndex
CREATE INDEX "customer_favorites_customerId_idx" ON "customer_favorites"("customerId");

-- CreateIndex
CREATE INDEX "customer_favorites_bundleId_idx" ON "customer_favorites"("bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_favorites_customerId_bundleId_storefrontId_key" ON "customer_favorites"("customerId", "bundleId", "storefrontId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "bundles_isActive_idx" ON "bundles"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "orders_storefrontOrderId_key" ON "orders"("storefrontOrderId");

-- CreateIndex
CREATE INDEX "orders_storefrontId_idx" ON "orders"("storefrontId");

-- CreateIndex
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX "profit_records_beneficiaryId_idx" ON "profit_records"("beneficiaryId");

-- CreateIndex
CREATE INDEX "profit_records_createdAt_idx" ON "profit_records"("createdAt");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_domain_idx" ON "tenants"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_momoReference_key" ON "transactions"("momoReference");

-- CreateIndex
CREATE INDEX "transactions_momoReference_idx" ON "transactions"("momoReference");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_resetToken_key" ON "users"("resetToken");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_ledger_momoTransactionId_key" ON "wallet_ledger"("momoTransactionId");

-- CreateIndex
CREATE INDEX "wallet_ledger_reference_idx" ON "wallet_ledger"("reference");

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_momoTransactionId_fkey" FOREIGN KEY ("momoTransactionId") REFERENCES "momo_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_price_history" ADD CONSTRAINT "bundle_price_history_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_records" ADD CONSTRAINT "profit_records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_records" ADD CONSTRAINT "profit_records_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_records" ADD CONSTRAINT "profit_records_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_products" ADD CONSTRAINT "storefront_products_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_products" ADD CONSTRAINT "storefront_products_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "momo_transactions" ADD CONSTRAINT "momo_transactions_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "momo_transactions" ADD CONSTRAINT "momo_transactions_initiatedBy_fkey" FOREIGN KEY ("initiatedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "momo_transactions" ADD CONSTRAINT "momo_transactions_claimedBy_fkey" FOREIGN KEY ("claimedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_favorites" ADD CONSTRAINT "customer_favorites_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "store_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_favorites" ADD CONSTRAINT "customer_favorites_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_favorites" ADD CONSTRAINT "customer_favorites_storefrontId_fkey" FOREIGN KEY ("storefrontId") REFERENCES "storefronts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
