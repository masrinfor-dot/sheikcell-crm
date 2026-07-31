---
name: Team presence & access logs
description: How "Equipe agora" online status and login history work, plus single-instance caveat
---

- Online status = in-memory refcount of open `/chat/events` SSE connections (presenceConnect/Disconnect in sseEmitter). **Single API instance only** — a multi-instance/load-balanced deploy would need shared presence (Redis). EasyPanel prod is single instance today.
- Login history: `access_logs` table, one row per login (inserted awaited in /auth/login, failure logged not fatal). Indexed (user_id, logged_in_at desc); 90-day retention pruned fire-and-forget on each login.
- Endpoints `/admin/team-status` + `/admin/users/:id/access-logs` are admin+supervisor; UI panel `EquipeOnline` lives at top of the admin-only Usuários tab, polls every 30s.
- **Why:** code review flagged multi-instance presence and unbounded log growth; keep these constraints if scaling out.
