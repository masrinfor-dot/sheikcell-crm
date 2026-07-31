---
name: Per-seller metrics scoping policy
description: Authorization policy for seller-facing metrics/reporting endpoints
---

Rule: a vendedor may only see their OWN commercial numbers. Any metrics endpoint must force both sector AND attendant scoping to the requester server-side (fail closed, ignoring query params), and that scoping must reach EVERY metric in the response — including lead counts, CRM/purchase aggregates, and time series — not just the obvious per-attendant tables. Cross-seller comparison (ranking) is admin/supervisor-only.

**Why:** per-seller sales/lead performance is treated as sensitive between colleagues; sector-only scoping was judged a data-disclosure path.

**How to apply:** when adding a metric to any report, ask "does this aggregate include colleagues' data when a vendedor calls it?" — scope conversations by assignee and CRM contacts by attendant, or omit the metric for vendedores. Hiding UI filters is never sufficient.
