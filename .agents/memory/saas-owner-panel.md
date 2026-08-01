---
name: SaaS owner panel (superadmin)
description: Non-obvious rules of the dono-do-sistema panel (status derivation, cancel semantics, billing)
---

- **"Inadimplente" is never stored**: tenants.saas_status only holds ativo|cancelado; "inadimplente" is derived at read time from pendente invoices past due. Invoice "atrasada" is likewise derived.
  **Why:** stored status would drift when an invoice is paid/cancelled.
- **A cancelled store must never carry a pending charge**: cancelling cascades atomically (suspend access, deactivate contract, cancel pending invoices), and every billing write — manual invoice, generation, status change back to pendente — locks the tenant row (FOR UPDATE) and re-checks saas_status under the lock, so it serializes with cancellation.
- **One monthly charge per store per month**: generation is guarded twice — unique index on (tenant_id, billing_month) plus an under-lock check for any non-cancelled invoice due in the month (covers manual invoices, whose billing_month is null).
