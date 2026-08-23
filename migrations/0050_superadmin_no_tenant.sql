-- Isolamento estrutural do Super Admin (correção definitiva, além do patch
-- pontual em GET /admin/users): usersTable.tenant_id é NOT NULL, então a
-- linha do Super Admin carregava tenant_id=1 só por causa dessa constraint
-- — sem relação real com nenhuma loja. Qualquer query no padrão
-- "WHERE tenant_id = <loja do admin logado>" (chat.ts, crm.ts, tasks.ts,
-- internalChat.ts, teamDirectory.ts, systemBoard.ts — pelo menos 15 pontos)
-- vazava o Super Admin pra dentro da loja 1 por coincidência de ID.
--
-- Em vez de tornar a coluna anulável (mudança de tipo com efeito cascata em
-- todo o código que lê usersTable.tenantId), move o Super Admin para
-- tenant_id=0 — um valor que nunca corresponde a uma loja real (lojas
-- começam em 1), então toda comparação "= <tenant real>" para de bater
-- automaticamente, sem precisar tocar nas ~15 queries uma por uma.
-- Idempotente: só afeta linhas que ainda não foram migradas.

UPDATE users SET tenant_id = 0 WHERE role = 'superadmin' AND tenant_id <> 0;
