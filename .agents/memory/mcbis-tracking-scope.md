---
name: MCBIS tracking boundaries
description: Scope and safety decisions for improving MCBIS order-status synchronization.
---

MCBIS tracking improvements must not adopt the comparison site's wallet-cache fallback, direct store-profit accounting, or refund policy. Reuse this platform's established financial and failover rules.

**Why:** The user authorized order-tracking changes only. The working comparison site's scheduling is useful, but its financial model differs; copying its entire poller would change when money moves.

**How to apply:** Keep status scheduling separate from dispatch and wallet access. Coordinate manual and automatic application, not only provider HTTP requests. Apply a legacy order's result before its linked item so the item's simpler cancellation path cannot bypass legacy failover or issue a second refund.

For a tracking-only repair, avoid changing the external production schema or repurposing general order timestamps merely to rotate polling. Process-local scheduling restarts from the oldest active backlog; it does not provide cross-instance coordination.

**Why:** This keeps deployment and database impact narrow while addressing batch starvation. An in-memory guard cannot coordinate multiple Render instances.

**How to apply:** If scaling to multiple instances, explicitly scope a shared worker lease and durable scheduling rather than assuming the process-local guard covers all servers.