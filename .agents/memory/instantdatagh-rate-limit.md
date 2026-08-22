---
name: InstantDataGH rate limit
description: Live InstantDataGH request ceiling and the polling constraint it creates.
---

## Rule

InstantDataGH reports a maximum of 120 requests per minute. Status polling must account for every IDG request across the service and keep the aggregate rate below that ceiling.

**Why:** Live IDG responses returned HTTP 429 with `Maximum 120 requests per minute allowed` while a 50-item polling batch was being sent at a 400 ms interval.

**How to apply:** Treat 429 as a provider-wide cooldown signal, not an item-level failure. Pace or cap status batches with headroom for balance, order, and manual requests, and do not retry each 429 immediately.