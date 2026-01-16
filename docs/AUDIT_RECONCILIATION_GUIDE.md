# Audit & Reconciliation Report Guide

## Overview

The Audit & Reconciliation Report provides a comprehensive financial snapshot of your KemDataPlus platform. It tracks all money flowing in and out, calculates profits, and helps ensure your books balance.

---

## 📊 Report Sections

### 1. DEPOSITS SUMMARY (Money In)

This section tracks all funds deposited into user wallets.

| Metric | Description |
|--------|-------------|
| **Total Deposits** | Combined Paystack + MoMo deposits |
| **Paystack Deposits** | Auto-credited deposits via Paystack payment gateway |
| **MoMo Claims** | Manual deposits where users claim they sent money via Mobile Money |

#### How Deposits are Identified:
- **Paystack**: Reference starts with `PS_` OR `paymentMethod = 'PAYSTACK'`
- **MoMo**: Everything else (admin-verified claims)

#### Paystack Fees:
- Customer pays **1.5% fee** on top of their deposit amount
- Paystack takes approximately **1.95%** of the total
- Platform absorbs **~0.5%** as a cost
- The report calculates: `Paystack Fees = Paystack Amount × 0.5%`

---

### 2. ORDERS SUMMARY

This section tracks data bundle sales.

#### System Orders (Direct Sales)
Orders placed directly through the admin panel or main platform.

| Metric | Description |
|--------|-------------|
| **Count** | Number of completed orders |
| **Revenue** | Total amount charged to customers |
| **Cost** | Your cost from data providers (MCBIS API) |
| **Profit** | Revenue - Cost |

#### Store Orders (Agent/Storefront Sales)
Orders placed through agent storefronts.

| Metric | Description |
|--------|-------------|
| **Count** | Number of completed storefront orders |
| **Store Revenue** | What end customers paid |
| **Owner Cost** | What agents paid (their wholesale price) |
| **Agent Profit** | Agent's markup (Store Revenue - Owner Cost) |
| **Platform Profit** | Your cut (Owner Cost - Supplier Cost) |

---

### 3. NETWORK BREAKDOWN

Shows orders grouped by network provider:

| Network | Orders | Revenue | Cost | Profit |
|---------|--------|---------|------|--------|
| MTN | 45 | GH₵ 500 | GH₵ 420 | GH₵ 80 |
| TELECEL | 20 | GH₵ 200 | GH₵ 175 | GH₵ 25 |
| AT | 10 | GH₵ 100 | GH₵ 85 | GH₵ 15 |

---

### 4. AGENT BREAKDOWN

Shows performance by agent/store owner:

| Agent | Orders | Store Revenue | Agent Profit | Platform Profit |
|-------|--------|---------------|--------------|-----------------|
| John (KDP-0001) | 15 | GH₵ 150 | GH₵ 15 | GH₵ 8 |
| Mary (KDP-0002) | 10 | GH₵ 100 | GH₵ 10 | GH₵ 5 |

---

### 5. REFUNDS & FAILED ORDERS

| Metric | Description |
|--------|-------------|
| **Refunds** | Money returned to user wallets (failed orders, disputes) |
| **Failed/Cancelled Orders** | Orders that didn't complete successfully |

---

### 6. CURRENT WALLET BALANCES

| Metric | Description |
|--------|-------------|
| **Total Balance** | Sum of all user wallet balances |
| **Wallet Count** | Number of wallets in the system |

This represents money you "owe" to users - they've deposited but haven't spent yet.

---

### 7. PROFIT SUMMARY (The Important Part!)

#### Gross Profit
```
System Gross Profit = System Revenue - System Cost
```

#### Net Profit (After Fees)
```
System Net Profit = System Gross Profit - Paystack Fees (0.5%)
```

#### Store Profits
```
Agent Earnings = Total agent markups (goes to agents)
Platform Cut from Stores = Your profit from wholesale pricing
```

#### Total Platform Profit
```
Total Platform Profit = System Net Profit + Platform Cut from Stores
```

---

## 📅 Time Periods

You can view reports for different periods:

| Period | Description |
|--------|-------------|
| **Today** | Current day (00:00 to 23:59 UTC) |
| **Yesterday** | Previous day |
| **This Week** | Last 7 days |
| **This Month** | Last 30 days |
| **Custom** | Select your own date range |

---

## 🔢 Understanding the Math

### Example Scenario

**Deposits Today:**
- User A deposits GH₵ 100 via Paystack (pays GH₵ 101.50 with fee)
- User B claims GH₵ 50 MoMo deposit (verified by admin)
- **Total Deposits: GH₵ 150**
- **Paystack Fees Absorbed: GH₵ 0.50** (0.5% of 100)

**Orders Today:**
- Order 1: MTN 5GB @ GH₵ 30, Cost: GH₵ 25 → Profit: GH₵ 5
- Order 2: TELECEL 2GB @ GH₵ 15, Cost: GH₵ 12 → Profit: GH₵ 3
- **System Revenue: GH₵ 45**
- **System Cost: GH₵ 37**
- **System Profit: GH₵ 8**

**Store Orders Today:**
- Agent sells MTN 5GB @ GH₵ 32 to customer
  - Agent pays (wholesale): GH₵ 28
  - Platform cost: GH₵ 25
  - Agent Profit: GH₵ 4 (32-28)
  - Platform Profit: GH₵ 3 (28-25)

**Final Calculations:**
```
System Gross Profit: GH₵ 8.00
Paystack Fees:      -GH₵ 0.50
System Net Profit:   GH₵ 7.50
Platform Store Cut:  GH₵ 3.00
------------------------
TOTAL PLATFORM PROFIT: GH₵ 10.50
```

---

## ⚖️ Reconciliation Checks

### Does Money Balance?

**Money In:**
- Total Deposits (Paystack + MoMo)

**Money Out:**
- Orders (cost paid to providers)
- Refunds
- Current Wallet Balances (money held for users)

**Should Equal:**
```
Deposits = Orders Cost + Refunds + Current Wallet Balances + Profit
```

### Red Flags to Watch:
1. **Wallet balance higher than total deposits** → Something's wrong
2. **Refunds > 10% of orders** → Quality issue or fraud
3. **Failed orders increasing** → API or provider issues
4. **Agent profits negative** → Pricing misconfiguration

---

## 📤 Export Options

Click **Export CSV** to download the report data for use in:
- Excel spreadsheets
- Accounting software
- Tax records

---

## 💡 Tips for Daily Use

1. **Check daily** - Review the "Today" report each evening
2. **Compare periods** - Look for trends (weekly vs last week)
3. **Monitor agents** - Identify top performers and issues
4. **Verify refunds** - High refund rates need investigation
5. **Track Paystack fees** - Ensure fee calculations are correct

---

## 🔧 Technical Notes

### Data Sources:
- **Deposits**: `Transaction` table where `type = 'DEPOSIT'` and `status = 'COMPLETED'`
- **Orders**: `OrderItem` table where `status = 'COMPLETED'`
- **Store Orders**: `StorefrontOrder` table where `status = 'COMPLETED'`
- **Refunds**: `WalletLedger` table where `entryType = 'REFUND'`
- **Wallets**: `Wallet` table aggregate balance

### API Endpoint:
```
GET /api/admin/audit-report?startDate=2026-01-15T00:00:00Z&endDate=2026-01-15T23:59:59Z
```

---

## Questions?

If numbers don't add up or you need clarification:
1. Check the date range selected
2. Verify all pending orders have been processed
3. Review any manual wallet adjustments
4. Check for pending MoMo claims not yet verified
