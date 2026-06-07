# Profit Payout System — Full Documentation

## Overview

The Profit Payout page lets admins manage all money owed to agents from their storefront sales. It covers everything from how profit accumulates, to agents requesting withdrawals, to the admin approving and sending money via Paystack MoMo transfer.

---

## How Profit Accumulates

When a customer places an order through an agent's storefront and that order reaches **COMPLETED** status, the system records a `PendingProfit` entry for the agent.

- The profit amount = the storefront selling price minus what the agent paid for the bundle
- It is stored with status `PENDING` and is **not** immediately added to the agent's wallet balance
- It sits in the "Available for Withdrawal" pool until the agent requests a payout

> **Important:** Storefront profits and regular wallet profits are separate. Regular order profits from the hierarchy system (`ProfitRecord`) go directly to wallet balance. Storefront profits (`PendingProfit`) sit in the payout pool and must be withdrawn.

---

## Page Sections

### 1. Summary Cards (top of page)

| Card | What it shows |
|---|---|
| Pending Payouts | Total GHS amount currently awaiting processing |
| Total Agents Pending | Number of agents who have money owed |
| Paid Today | Total amount successfully sent out today |
| Total Ever Paid | Cumulative amount paid to all agents since the system started |

---

### 2. Withdrawal Requests Table

This is the main working area. It lists every agent payout request with these columns:

- **Agent** — name, phone, MoMo number the transfer will go to
- **Amount** — total requested
- **Status** — one of: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `REJECTED`
- **Requested** — when the agent submitted the request
- **Action buttons** — depend on the current status (see below)

**Status filter** — top of the table lets you filter by status. Defaults to PENDING.

**Date range filter** — filter requests by date period.

---

### 3. Action Buttons Per Request

#### PENDING requests
| Button | What it does |
|---|---|
| **Process** (blue) | Sends this single payout via Paystack transfer immediately |
| **Manual Pay** (grey) | Marks as paid without going through Paystack (used if you paid the agent outside the system — cash, bank transfer, etc.) |
| **Reject** (red) | Cancels the request. The agent's pending profit balance is released and they can request again. You enter a reason. |

#### PROCESSING requests (transfer sent, waiting on Paystack)
| Button | What it does |
|---|---|
| **Force Complete** (green) | Use when Paystack actually sent the money but the webhook never came back to update our system. Manually marks it done and credits the agent as PAID. |
| **Force Cancel** (orange) | Use when the transfer genuinely failed but the system is stuck in PROCESSING. Releases the amount so the agent can request again. |

#### COMPLETED / REJECTED / FAILED
No action buttons — these are final states.

---

### 4. Bulk Transfer Button

**"Process Bulk Transfer Now"** — processes ALL pending withdrawal requests in one operation.

- Groups all PENDING requests into batches of up to 100 (Paystack's limit per bulk call)
- Sends them all to Paystack's bulk transfer endpoint in one go
- Sets all of them to PROCESSING status with their Paystack transfer codes
- More efficient than processing one by one — fewer API calls, faster

Use this at the end of the week when you're ready to pay all agents at once.

---

### 5. Pending Profits Panel (right side)

Shows agents who have earned profit but have **not yet requested a withdrawal**. This is your "money owed but not requested yet" view.

- Shows each agent's unclaimed amount
- Used to see the full picture of outstanding obligations

---

## The Paystack Transfer Flow

When you click **Process** or **Process Bulk Transfer**:

1. System looks up or creates a Paystack `recipient_code` for the agent's MoMo number (cached on the user record to avoid repeat API calls)
2. Sends the transfer to Paystack
3. Paystack processes the MoMo transfer to the agent's phone
4. Paystack sends a webhook back to our system when done

**On webhook success:**
- `AgentPayout` status → `COMPLETED`
- The matching `PendingProfit` records (oldest first, up to the withdrawal amount) → `PAID`

**On webhook failure:**
- `AgentPayout` status → `FAILED`
- Profit balance released — agent can request again

---

## The Stuck Checker (background job)

Runs every **5 minutes** automatically.

Paystack webhooks sometimes don't arrive (network issues, timeouts). Without a fallback, transfers would get stuck in PROCESSING forever.

The stuck checker **polls Paystack** for any of our payouts that have been in PROCESSING for more than 2 minutes. If Paystack confirms it went through, the system finalises it as COMPLETED. If Paystack says it failed, it marks it FAILED.

This is why you rarely need to use Force Complete — the stuck checker usually catches missed webhooks within 5–7 minutes.

---

## Weekly Scheduler

The system has a built-in weekly payout scheduler set to **Friday at 19:30 Ghana time**.

Currently set to **Admin Manual Mode** — the scheduler does NOT automatically trigger the bulk transfer. You must click "Process Bulk Transfer Now" yourself.

If `autoProcess` is ever enabled in the scheduler settings, it would automatically run the bulk transfer at the scheduled time without admin action.

---

## Manual Pay — When to Use It

Use **Manual Pay** when:
- You paid the agent in cash
- You did a direct bank transfer outside the system
- Paystack is down and you need to settle urgently

What it does:
- Marks the `AgentPayout` as COMPLETED
- Marks the agent's `PendingProfit` records as PAID
- Deducts from their pending balance so they don't get paid twice

The system records the payment method as `manual_momo` with a note.

---

## Admin Profit Adjustments

Admins can manually add or deduct from an agent's pending profit balance using `AdminProfitAdjustment` records. These affect the "Available for Withdrawal" calculation:

```
Available = Total PendingProfits - Active Requests (PENDING/PROCESSING) + Adjustments
```

---

## Database Models

| Model | Purpose |
|---|---|
| `PendingProfit` | Individual profit entries from each completed storefront order. Source of all withdrawal funds. |
| `AgentPayout` | One record per withdrawal request. Tracks amount, status, Paystack codes, and timestamps. |
| `PayoutBatch` | Groups multiple `AgentPayout` records sent in a single Paystack bulk transfer call. |
| `AdminProfitAdjustment` | Manual balance corrections by admin (bonus credits or deductions). |
| `ProfitRecord` | Hierarchy commission log — separate from storefront profits; these go directly to wallet balance. |

---

## Status Lifecycle

```
Agent earns profit
        ↓
PendingProfit (PENDING)
        ↓
Agent requests withdrawal
        ↓
AgentPayout (PENDING)  ←── Admin rejects → released, agent can re-request
        ↓
Admin processes (single or bulk)
        ↓
AgentPayout (PROCESSING) — Paystack transfer sent
        ↓ webhook or stuck checker
    COMPLETED ✓              FAILED ✗
  PendingProfit → PAID    agent can re-request
```

---

## Common Scenarios

**"Agent says they haven't been paid but it shows COMPLETED"**
Check the `AgentPayout` record for the Paystack `transfer_code` and reference. Give those to the agent to verify with their MoMo provider.

**"Transfer stuck in PROCESSING for over 10 minutes"**
The stuck checker runs every 5 min — wait a bit longer. If still stuck after 15 minutes, use **Force Complete** (if Paystack confirms it went) or **Force Cancel** (if it failed) then re-process.

**"Agent's available balance shows less than expected"**
Check if they have an active PENDING or PROCESSING request — those amounts are reserved and excluded from the available balance to prevent double-payment.

**"Webhook isn't arriving from Paystack"**
The stuck checker is the fallback. It will poll and resolve within 5–7 minutes. You do not need to manually intervene unless it's been 15+ minutes.
