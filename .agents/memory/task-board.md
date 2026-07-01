---
name: Task board (Quadro de Tarefas)
description: Trello-style team task board for organizing atendimento work
---

# Task board

A Trello-style team board ("Tarefas" tab in both the vendedor and admin
dashboards) backed by a `tasks` table. Columns are status todo/doing/done;
cards carry priority (baixa/media/alta), assignee, sector, due date.

## Access scoping (decision)

Follows the same model as CRM/chat: admin + supervisor see all tasks;
vendedores see tasks in their own sector OR assigned to them OR created by them.
On create, a vendedor's task is pinned to their own sector; only global roles
can set/reassign the sector.

**Why:** matches the app-wide role-scope model (see role-scope-consistency and
vendedor-scoping).

**How to apply:** the access predicate must guard null — `sid != null &&
t.sectorId === sid` and `uid != null` for owner checks — otherwise a vendedor
with no sector fails OPEN and matches every null-sector task. This null-equality
trap recurs in every sector-scoped module; see vendedor-scoping.md.
