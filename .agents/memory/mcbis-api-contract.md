---
name: MCBIS API contract
description: External MCBIS DataHub API contract and the provider-side proxy behavior observed during troubleshooting.
---

MCBIS DataHub uses Bearer-token authentication at `/api/v1`, with wallet balance at `/walletBalance` and the balance payload nested at `data.walletBalance`. The published examples list AirtelTigo as `atpremium`; do not assume the internal `atishare` name is accepted.

The published examples show LiteSpeed responses, while live requests may pass through Cloudflare and return HTML 403 pages. A valid token can therefore coexist with an intermittent Render-only access failure.

**Why:** The wallet endpoint returned 200 with the configured credential, while deployed requests later returned HTML 403 responses; this separates request-format/authentication problems from provider/WAF behavior.

**How to apply:** Keep the Bearer header and endpoint unchanged, log safe status/proxy metadata on failures, and treat HTML 403 responses as an upstream access-block signal rather than automatically assuming the token is invalid.