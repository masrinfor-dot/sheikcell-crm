# Threat Model

## Project Overview

Sheikcell is a public-facing customer-service and CRM platform built as a pnpm monorepo. Its production surface consists primarily of an Express API (`artifacts/api-server`) backed by PostgreSQL, a separate WhatsApp bridge service (`artifacts/whatsapp-bridge`) for inbound and outbound messaging, and authenticated web/mobile clients that consume the API. The deployment is public, so any route not protected by authentication or a shared secret should be treated as internet-reachable.

## Assets

- **User accounts and sessions** — authenticated admin, supervisor, and vendedor accounts plus their session cookies. Compromise would allow access to CRM records, conversations, and operational controls.
- **CRM and queue data** — contact records, internal notes, purchases, attendance logs, and queue state. This data contains customer PII and business-sensitive workflow history.
- **Chat and media content** — WhatsApp conversations, participant assignments, uploaded or downloaded media, and live SSE updates. Exposure would leak customer communications and internal staff actions.
- **WhatsApp integration state** — bridge shared-secret material, Meta API credentials, and Baileys authentication state. Compromise would allow message spoofing, account takeover of the business WhatsApp presence, or unauthorized webhook processing.
- **Application secrets** — database connection strings, session secret, and any provider access tokens. These protect server trust boundaries and downstream service access.

## Trust Boundaries

- **Browser/mobile client to API** — all client input is untrusted. Authentication, role checks, and sector scoping must be enforced server-side.
- **API to PostgreSQL** — the API has broad read/write access to the database. Authorization failures at the API layer become direct data exposure or tampering in the database.
- **API to WhatsApp bridge** — the API calls the bridge using an HMAC-style shared secret. The bridge must reject unauthorized callers and sensitive bridge credentials must not be recoverable from the repo or artifacts.
- **Public webhook/provider to API** — WhatsApp webhook payloads cross from the public internet or Meta into the API. Signature verification must fail closed in production.
- **Role and tenant boundary inside the app** — admins and supervisors have global visibility, while vendedores are intended to be sector-scoped. Every route that reads or mutates sector-owned records must enforce that boundary server-side.
- **Production vs dev-only boundary** — `artifacts/mockup-sandbox`, local build scripts, and similar experimentation tooling are not production-reachable by default and should be ignored unless another path proves exposure. Per scan assumptions, `NODE_ENV` is `production` in deployed environments.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/routes/*`, `artifacts/whatsapp-bridge/src/index.ts`, `artifacts/whatsapp-bridge/src/routes/index.ts`.
- **Highest-risk areas:** auth/session setup in `artifacts/api-server/src/app.ts` and `src/routes/auth.ts`; sector-scoped business routes in `src/routes/chat.ts`, `src/routes/crm.ts`, `src/routes/queue.ts`, `src/routes/admin.ts`; bridge auth and WhatsApp state in `artifacts/whatsapp-bridge/src/**` and `lib/db/src/schema/whatsapp_*.ts`.
- **Public vs authenticated vs admin surfaces:** `/api/auth/login`, `/api/chat/webhook/whatsapp`, and health endpoints are public; most `/api/*` routes require authentication; `/api/admin/*`, `/api/sectors/all`, and `/api/whatsapp/*` are intended to be admin-only.
- **Usually ignore as dev-only:** `artifacts/mockup-sandbox/**`, build output files under `dist/`, and local mobile build scripts unless production reachability is demonstrated.

## Threat Categories

### Spoofing

The application relies on cookie-backed sessions for user identity and a shared bridge secret for service-to-service calls. Protected API routes must require a valid session on every request, admin actions must verify the caller's role server-side, and bridge endpoints must reject callers that do not present the expected secret. Production webhook processing must continue to fail closed when the Meta webhook secret is absent or invalid.

### Tampering

Authenticated users can mutate conversations, CRM contacts, queue entries, routing rules, and user records. Because vendedores are intended to be sector-scoped, the server must prevent them from changing records outside their assigned sector and must not rely on client-side role gating. Message send paths, participant management, and queue/CRM transitions are especially sensitive because they directly affect customer communications and operational history.

### Information Disclosure

The API stores customer PII, internal notes, conversation history, and staff activity. Responses and SSE events must be scoped to the authenticated user's allowed sectors, and sensitive integration material such as WhatsApp auth state or provider tokens must never be committed to the repository, bundled into deployable artifacts, or exposed through logs or API responses.

### Denial of Service

Public login and webhook endpoints, large JSON request bodies, media upload/download paths, and external-provider interactions are the main exhaustion risks. Production endpoints should avoid unauthenticated expensive work, bound upload sizes, and ensure integration calls fail predictably when downstream systems are unavailable.

### Elevation of Privilege

The key application-specific risk is a vendedor or other low-privilege user crossing sector boundaries or reaching admin/global data through missing object-level authorization. Every route that looks up a record by numeric ID must verify that the current session is allowed to access that record before returning or mutating it. Sensitive bridge credentials and WhatsApp auth state must also be protected because recovering them can effectively grant attacker-controlled messaging privileges beyond any normal in-app role.