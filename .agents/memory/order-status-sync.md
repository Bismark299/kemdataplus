---
name: Order status sync across fulfillment and legacy/storefront tables
description: Why admin dashboard and storefront/tracking pages can show different order statuses, and the convention for keeping them in sync.
---

This app has three layers that each track order status independently: `OrderItem`/`OrderGroup` (automated fulfillment truth), legacy `Order`, and `StorefrontOrder` (what customers see on the tracking page). They are linked by reference string (`OrderItem.reference` = `${Order.reference}-NN`) and by `Order.storefrontOrderId` / `StorefrontOrder.orderId`.

**Rule:** any code path that mutates `OrderItem`/`OrderGroup` status (fulfillment engines, provider webhooks, admin bulk actions) must also propagate the same status to the linked legacy `Order` and `StorefrontOrder`, and must call `financialOrderService.creditAgentProfit()` when transitioning to COMPLETED for a Paystack order.

**Why:** one provider integration path (MCBIS's `datahub.service.js`) already did this two-way sync correctly, but a newer path (DGK's `processOrderItems`/`updateItemStatus` in `order-group.service.js`) only updated `OrderItem`/`OrderGroup` and silently left `Order`/`StorefrontOrder` stale — causing admin main dashboard to show COMPLETED while the storefront/customer tracking page and admin per-store orders page kept showing PENDING/FAILED, and Paystack profit never got credited for affected orders.

**How to apply:** when adding or auditing any status-mutation code path, check it calls something equivalent to `syncLegacyOrderStatus()` (guard against downgrading a terminal COMPLETED state). For historical rows already stuck out of sync (e.g. after a production incident), use `orderGroupService.reconcileStorefrontOrders(apply)` — a dry-run/apply-safe idempotent repair function exposed via the admin-only route `POST /api/order-groups/admin/reconcile-storefront-orders`, also runnable as `server/scripts/reconcile-storefront-orders.js` from a shell against production. Do not duplicate this reconciliation logic elsewhere — extend the shared service function instead.
