---
name: Task board (Quadro de Tarefas)
description: Trello-style team task board for organizing atendimento work
---

# Task board

A Trello-style team board ("Tarefas" tab in both the vendedor and admin
dashboards) backed by a `tasks` table. Columns are status todo/doing/done;
cards carry priority (baixa/media/alta), assignees (0..N, see below), sector,
due date, and the creator (`createdById`, shown as "Criada por X" both on the
card and in the detail modal).

## Multi-assignee (decision)

A task can have zero or more assignees — `task_assignees` join table
(tenant_id, task_id, user_id), not a single `assignee_id` column (that column
was dropped in migration 0034). Any one of the assignees (not all) can mark
the task "done"; a task with no assignees can be completed by anyone with
access. `PATCH /tasks/:id` and `POST /tasks` take `assigneeIds: number[]`
(never `assigneeId`). Other tables that reference "the" task assignee (the
overdue-tasks widget in admin.ts, the ownership-transfer flow when
deactivating/deleting a user) were updated to join/reassign against
`task_assignees` instead — check those spots again if you touch task
ownership transfer logic.

**Why:** a task like "atender esse grupo de clientes" can genuinely need more
than one person on it; a single owner field forced picking one arbitrarily.

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
