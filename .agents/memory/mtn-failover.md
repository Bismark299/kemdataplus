---
name: MTN Failover
description: Primary/backup API failover for MTN orders between MCBIS and IDG; architecture decisions and constraints.
---

## Rule
When `mtnFailoverEnabled` is true in siteSettings, MTN orders go to `mtnPrimaryProvider` first. If the primary cancels, the order is rerouted to `mtnBackupProvider` before any refund is issued. Refund only fires if backup also cancels.

**Why:** Customer never gets refunded just because one supplier had a bad day. Zero money risk because:
1. A fresh status re-check (race-condition guard) confirms the cancel before rerouting.
2. The `tryMtnFailover` function only runs if `currentProvider === primaryProvider` — backup cancellations fall straight through to refund, no loop.

## How to apply
- `providerName` field on `Order` model tracks which provider currently holds the order (`'MCBIS'` | `'IDG'` | null).
- `datahub.service.js syncOrderStatus` routes the status API call to IDG service when `providerName === 'IDG'` or `externalReference` starts with `'IDG-'`.
- `tryMtnFailover` is a module-level async function at the bottom of `datahub.service.js` (before `module.exports`).
- Failover intercept sits BEFORE the DB write of CANCELLED status — if rerouted, order stays PROCESSING with the new provider's reference.
- MCBIS rate-limit in `syncAllPendingOrders` now uses `continue` (not `break`) so IDG orders in the same query are still processed.
- `storefront.service.js` PROVIDERS array now includes IDG. When failover is on for MTN, it bypasses the normal toggle-order and goes straight to `mtnPrimaryProvider`.
- `retryPendingOrders` in `datahub.service.js` also includes IDG in PROVIDERS and respects `mtnPrimaryProvider` for MTN.
- Admin UI: "MTN Failover" settings card between MCBIS card and Etopup card in the API Integrations section. Settings keys: `mtnFailoverEnabled`, `mtnPrimaryProvider`, `mtnBackupProvider`.
- `prisma db push --accept-data-loss` was used (not `migrate dev`) because the shadow DB has a missing `bundle_price_history` table that blocks migrations.
