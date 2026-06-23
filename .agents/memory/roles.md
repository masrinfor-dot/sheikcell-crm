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

Legacy value `attendant` was migrated to `vendedor` via SQL (June 2026). New users default to `vendedor`.

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
