---
name: TV Box (Uni TV) subscriber billing
description: Recurring subscription panel for TV Box/Uni TV clients — data model, billing job, WhatsApp reminders
---

# TV Box

Per-tenant panel to manage TV Box (Uni TV) subscribers: client registry (monthly
fee + due day), recurring invoice generation, and automated WhatsApp
reminder/charge messages. Module key `"tvbox"` in `OPTIONAL_MODULES` — gated
like any other optional module, **not** admin-only (matches `financeiras`:
anyone with the module granted, view/edit per user).

## Design: mirrors the platform's own SaaS billing

`tv_box_clients` + `tv_box_invoices` (schema/tv_box.ts) deliberately copy the
shape of `saas_contracts`/`saas_invoices` (schema/saas.ts) — the mechanism the
system already uses to bill the **tenant stores themselves** for renting the
platform. Same idempotent generation pattern: unique index on
`(client_id, billing_month)`, "atrasada" always derived (`status='pendente' AND
due_date < today`), never stored. `tvBoxBilling.ts` mirrors `saasBilling.ts`
almost line for line (transaction + row lock + re-check status after lock).

**Why:** don't reinvent recurring-billing idempotency when a battle-tested
version already exists in the codebase for the platform's own rent.

## No auto-suspend (deliberate)

Overdue invoices keep getting charged on `overdueMessageIntervalDays` cadence
forever — the system never flips a client to `suspenso` on its own. Only an
admin manually changes `tv_box_clients.status`. **Why:** user's explicit
choice when this was speced — keep the first version simple, add
auto-suspend later only if actually needed.

## WhatsApp send path

Reuses `sendOutboundText()` (lib/outbound.ts) for both reminder and charge —
the same helper survey reminders/scheduled messages use. **This is what gives
free anti-mass-blast protection**: the pacing queue lives in the
whatsapp-bridge (`waConnection.ts`, per-session, human-like delay between
sends), transparent to any caller of `sendOutboundText`/`/whatsapp/send`. No
new throttle was built. On top of that, each scheduler tick caps itself at
`BATCH_LIMIT = 30` (tvBoxMessaging.ts) so a large client base spreads across
several ticks instead of bursting.

Each client's conversation lives in a dedicated **"TV Box" sector**,
auto-created per tenant on first use (`ensureTvBoxSector`, same
select-then-insert-with-partial-unique-index pattern as
`ensureGeneralRoom()` for internal chat's general room — see
`sectors_tvbox_by_tenant_unique` in migration 0036). The find-or-create
conversation lookup is scoped to that sector specifically (phone match alone
would risk hijacking an unrelated sales conversation for the same customer in
a different sector).

## Scheduler ticks (lib/scheduler.ts)

- `runTvBoxMonthlyBilling` — hourly (same cadence as the platform's own
  `runMonthlyBilling`), idempotent so re-running is free.
- `sendTvBoxReminders` / `sendTvBoxCharges` — every 30 min, both capped by
  `BATCH_LIMIT`.

## Testing note

`tvBoxBilling.test.ts` covers the generation logic directly (idempotency,
short-month due-date clamping, suspended clients skipped) without touching
the messaging path — `sendTvBoxMessage` goes through `sendOutboundText`,
which makes a real HTTP call to the WhatsApp bridge with a 60s timeout; not
worth exercising end-to-end in the unit suite when the bridge isn't
guaranteed to be running. See [[satisfaction-survey]] for the general lesson
about this codebase's migrations only running via `runMigrations()` at real
server boot — the test harness (`app.ts`) does NOT apply them, so a new
migration must be applied to the dev DB by hand before its tests will pass.
