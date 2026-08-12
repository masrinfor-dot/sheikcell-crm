---
name: Three-role system
description: Sheikcell has three user roles — admin, supervisor, vendedor — with different access scopes.
---

## Roles

| Role | PT Label | Scope | Can Manage Users/Sectors/WhatsApp |
|------|----------|-------|----------------------------------|
| `admin` | Administrador | Global | Yes |
| `supervisor` | Supervisor | Global (read) | No |
| `vendedor` | Vendedor | Own sector only | No |

Legacy value `attendant` was migrated to `vendedor` via SQL directly in production (June 2026) — but that fix was never captured as a versioned migration, so any environment restored from an older snapshot (or never touched by that one-off SQL) could still have `attendant` rows. Fixed for good in `migrations/0022_normalize_legacy_attendant_role.sql` (idempotent `UPDATE users SET role='vendedor' WHERE role='attendant'`, reapplied on every boot). New users default to `vendedor`.

**Why this mattered:** several features do a strict `role === "vendedor"` check (WhatsApp-line restriction and access-hours sections in the admin edit form, self-assignment on manually created conversations, vendedor→vendedor transfer restriction, auto-queue on participant add, Resultados/Sorteios vendor lists) — for `attendant`-role rows these silently no-op instead of erroring, so the affected UI section just doesn't render with no indication why. `isGlobalRole()` (admin/supervisor only) and `checkPerm()`/permissions.ts are inclusive checks and were never affected.

## API middleware

- `requireAdmin` — only `admin`
- `requireAdminOrSupervisor` — `admin` or `supervisor` (dashboard summary, logs)
- `requireAuth` — any authenticated user

## Scope logic

- `admin` and `supervisor` see **all** conversations and queue entries
- `vendedor` sees only their `sectorId`
- Helper: `isGlobalRole(role)` in `auth.ts`

## Frontend

- Both `admin` and `supervisor` land on `AdminDashboard`
- Tabs `users`, `sectors`, `whatsapp` are hidden for `supervisor` (adminOnly filter)
- `fetchUsersAndSectors` is only called for `admin` (avoids 403 on `/admin/users`)
- Header subtitle: "— Administrador" or "— Supervisor"

**Why:** Store needed role separation — owners (admin) set up the system, managers (supervisor) monitor without destructive access, sellers (vendedor) handle their sector only.
