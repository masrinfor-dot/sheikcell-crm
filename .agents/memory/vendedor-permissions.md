---
name: Permissões por vendedor
description: Sistema de permissões individuais (users.permissions jsonb) que limita ações de vendedores
---

Regra: `users.permissions` (jsonb, null/chave ausente = liberado) vale SÓ para role vendedor; admin/supervisor sempre liberados. Chaves: ver_potenciais, transferir, finalizar, criar_atendimento, usar_ia, crm, tarefas, enviar_midia.

**Como funciona:**
- api-server `lib/permissions.ts`: `checkPerm(req,key)` (consulta o banco a cada checagem — mudanças do admin valem sem relogin) e `requirePerm(key)` middleware.
- Enforcement no servidor: list SQL (termo potencial), SSE `allowed()` (recarrega perm a cada 30s via setInterval — limpar no close), canAccessConversation, claim, PATCH (finalizar cobre status resolved **e archived** e isArchived; transferir), requirePerm em create/media/suggest-reply/correct-text, `router.use` em /crm e /tasks.
- Frontend: `can(user,key)` em api.ts esconde abas/botões; admin edita no modal (aba Usuários, ícone escudo, só em vendedores).

**Armadilhas aprendidas (review pegou):**
- `status:"archived"` também é finalizar — bloquear junto com resolved/isArchived.
- Vendedor com "transferir": handoff (assignee=null, status pending) deve ser FORÇADO ignorando status/assignee do payload, senão payload crafted mantém dono/status na transferência cross-sector.
- SSE calcula perms na conexão → precisa do refresh periódico ou revogação vaza eventos de potenciais.

**Why:** admin quer ligar/desligar capacidades por vendedor sem criar novos roles.
**How to apply:** nova ação sensível de vendedor → nova chave em PERMISSION_KEYS (backend+frontend), requirePerm/checkPerm no servidor E esconder na UI; padrão sempre liberado.

## adminAccess (funções de admin liberáveis)
- `users.adminAccess` jsonb string[]: funções de admin liberadas a não-admins (financeiro, sorteios, robo, rh, questionarios, whatsapp).
- Servidor: middleware `requireFeature("x")` (admin passa direto; senão consulta adminAccess no DB, fail closed). Rotas dessas features usam requireFeature, não requireAdmin.
- UI: AdminDashboard mostra aba adminOnly se granted; AttendantDashboard (vendedor) tem GRANTED_TABS extras (exceto whatsapp, que é inline no AdminDashboard).
- Sanitizado no servidor contra lista GRANTABLE_FEATURES; role admin salva null.
