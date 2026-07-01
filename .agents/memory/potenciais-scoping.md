---
name: Potenciais cross-sector scoping
description: Why potenciais bypass sector scoping and the SSE isPotential-flag rule that prevents cross-sector leaks
---

# Potenciais are cross-sector visible

A "potencial" conversation = new unclaimed lead: `assigneeId IS NULL`, not archived,
`status NOT IN (pending, resolved, archived)`. The single source of truth is
`isPotentialConversation()` / `POTENTIAL_EXCLUDED_STATUSES` in
`api-server/src/lib/conversationScope.ts`. Server SQL, `canAccessConversation`, and the
frontend `isVisibleToMe()` in `ChatCenter.tsx` must all stay consistent with it.

**Rule:** vendedores see their own sector PLUS every potencial from any sector, and may
open/claim them. Everything else stays strictly sector-scoped. Claiming a cross-sector
potencial moves its `sectorId` to the claimer so post-claim authz stays consistent.

**Why:** business wants any salesperson to pick up new leads regardless of sector, but
sector scoping is a real authorization/PII boundary (see threat_model.md information
disclosure). So the "potencial" exception is the only sanctioned cross-sector path.

**SSE gotcha (caused a review FAIL):** `broadcast(event, data, sectorId, isPotential)`
— the SSE filter lets `isPotential`-flagged events reach ALL vendedores. When a claim
transitions a potencial to assigned/pending, other vendedores still need that event to
drop it from their list, so the flag must be derived from the **pre-update** state
(`wasPotential = isPotentialConversation(conv)` BEFORE the update), NOT hardcoded `true`
and NOT the post-update state. Hardcoding `true` leaks normal same-sector claims
cross-sector. Server filtering is authoritative; frontend visibility is defense-in-depth.
