---
name: Multi-loja (tenant) architecture
description: Durable tenancy rules for Sheikcell's multi-loja SaaS — fail-closed scoping, SSE boundaries, WhatsApp session ownership, suspension semantics
---

Sheikcell is multi-tenant ("lojas" = tenants; tenant 1 = legacy Sheikcell data). "Tenants" ≠ "stores" (stores = branch lojas within one network's tenant).

Durable rules (fail closed — a missing tenant filter = cross-lojista data leak):
- EVERY table (including child tables like messages, task_comments, crm_purchases, internal_messages) carries tenant_id NOT NULL DEFAULT 1 — reviewer requires schema-level ownership, not just parent-checked queries. Any NEW table gets tenant_id + filters + tenantId on insert; migration backfills children from parents.
- Tenant-sensitive in-memory caches must be keyed `tenant:user`, never user id alone.
- Sessions carry the loja; superadmin has none and must get NO tenant data. Every data route starts with the requireTenant helper (403 when absent).
- ALL SSE channels (customer chat AND internal team chat) carry tenantId on every event and reject cross-tenant delivery FIRST — live and replay-buffer paths alike. General-room "everyone" events mean everyone IN THE LOJA, never globally.
- Suspension is fail-closed end-to-end: blocks login, blocks live sessions via a short-TTL cache (fails closed when the DB check fails and the cache is cold/stale), and open SSE streams re-check periodically and close themselves.
- WhatsApp: session keys are prefixed per loja (t{tenantId}-); the legacy "default" key maps to tenant 1 ONLY. Unknown inbound sessionKeys are dropped without DB writes. Deleting a connection must never reassign another loja's conversations to "default" — sends fail explicitly until the lojista connects a new session.
- Per-tenant uniques: settings/usage-style keys and singleton rooms are unique per (tenant_id, ...) — upserts must target the composite key.
- Sector/role/potenciais scoping still applies INSIDE the loja, layered on the tenant filter.

**Why:** the system is sold to multiple lojistas; any unscoped query, broadcast, or WhatsApp fallback leaks one customer's data (or sends via another customer's WhatsApp account).
**How to apply:** when adding tables, routes, broadcasts, or WhatsApp flows, add tenant scoping at the same time — reviewers reject silently fail-open paths (default-tenant fallbacks, unscoped SSE, cached allow-on-error).

- Sessões antigas (criadas antes do multi-loja) não têm tenantId e o fail-closed esconde TODOS os dados ("Sessão sem loja"). Um middleware em /api backfilla o tenantId da sessão a partir do usuário no banco (1x por sessão). Qualquer novo campo obrigatório de sessão precisa do mesmo self-heal, ou todo deploy exige relogin geral.
