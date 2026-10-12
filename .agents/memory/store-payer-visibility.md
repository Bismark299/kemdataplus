---
name: Store payer visibility
description: User-approved scope and evidence rules for showing store payment MoMo numbers to agents.
---

Agents should see the MoMo number that made payment for their own store orders, separately from the number receiving the data. The user said it “should begin with only today's orders” on 2026-10-12; use that day's midnight Ghana/UTC boundary and leave earlier orders unchanged.

**Why:** The user wants agents to identify the account that actually paid, not a recipient or checkout contact.

**How to apply:** Use verified payment-provider instrument details, not customer phone or order metadata as proof of payer. Paystack's documented Ghana mobile-money response may provide only masked authorization bin/last4; preserve that masking and label it. When provider details are absent, show “Not provided”. Restrict display to the store owner and authorized admins; never include it in public customer tracking. Enrich already-paid eligible orders through verification only, without triggering fulfillment or resending.
