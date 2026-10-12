-- Additive only; no recipient numbers or earlier orders are modified.
ALTER TABLE "storefront_orders" ADD COLUMN IF NOT EXISTS "payerMomoNumber" TEXT;
