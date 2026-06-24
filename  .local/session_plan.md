# Objective
Run an in-depth, production-scoped security scan across the Sheikcell monorepo and report only concrete exploitable vulnerabilities.

# Relevant information
- Public deployment: `https://business-opportunity-analyzer.replit.app`.
- Production-relevant server surfaces are `artifacts/api-server` and `artifacts/whatsapp-bridge`.
- Main trust boundary is role/sector isolation: `admin` and `supervisor` are global; `vendedor` is intended to be sector-scoped.
- Queue and some admin routes already implement explicit sector/role checks; other business routes need consistency validation.
- `artifacts/mockup-sandbox/**`, local build tooling, and similar experimentation areas are dev-only unless another path proves production reachability.
- Deterministic scans completed: SAST produced medium-severity path warnings with many likely false positives; HoundDog returned no findings.

# Tasks

### T001: Validate chat authorization and tenant isolation
- **Blocked By**: []
- **Details**:
  - Inspect `artifacts/api-server/src/routes/chat.ts` and related SSE behavior.
  - Confirm whether vendedores can read or mutate conversations, messages, participants, or media outside their sector by direct object reference.
  - Acceptance: identify any exploitable cross-sector read/write paths with concrete endpoint evidence, or rule them out.

### T002: Validate CRM authorization and tenant isolation
- **Blocked By**: []
- **Details**:
  - Inspect `artifacts/api-server/src/routes/crm.ts`.
  - Focus on direct-ID reads, updates, deletes, note/purchase subresources, and service-history endpoints.
  - Acceptance: identify any exploitable cross-sector read/write paths with concrete endpoint evidence, or rule them out.

### T003: Validate secret handling and WhatsApp bridge exposure
- **Blocked By**: []
- **Details**:
  - Inspect `artifacts/whatsapp-bridge/src/**`, `artifacts/api-server/src/routes/whatsapp.ts`, and any checked-in session/auth state under `artifacts/whatsapp-bridge/sessions/**`.
  - Determine whether bridge credentials or WhatsApp auth state are recoverable from source or deployable artifacts and what attacker capabilities that grants.
  - Acceptance: confirm or reject secret exposure / bridge-auth weaknesses with concrete file evidence.

### T004: Sweep remaining production routes for high-signal authz or public-endpoint issues
- **Blocked By**: []
- **Details**:
  - Inspect `artifacts/api-server/src/routes/{queue,admin,routing,sectors,webhook,auth}.ts` for missed access-control gaps or dangerous public behavior.
  - Acceptance: surface any additional production-impactful vulnerabilities not already covered by T001-T003, or confirm those areas are comparatively sound.

### T005: Synthesize, group, and report
- **Blocked By**: [T001, T002, T003, T004]
- **Details**:
  - Deduplicate findings, update any relevant existing vulnerabilities, organize new findings into remediation groups, and finalize via `report_scan_complete`.
  - Acceptance: grouped vulnerability files plus updated threat model and proposed scan results.