---
name: Completion correction
description: Safe handling when a local order is marked completed before its provider is complete.
---

## Rule

Before reversing a local completion to processing, check the provider's live status and unwind any completion-triggered profit state before changing order statuses.

**Why:** A local completion can be premature while the provider still processes delivery; restoring only the order status can leave queued or credited profit inconsistent with the actual fulfillment state.

**How to apply:** Confirm the external reference remains active, inspect wallet and pending-profit effects, cancel unreleased pending profit or handle any paid profit explicitly, then restore all linked local order views with an audit record. Do not issue a customer refund unless it is separately authorized.