-- Conversas resolvidas/arquivadas podiam ficar com unread_count > 0 pra
-- sempre: o zeramento ao abrir uma conversa só acontece pro responsável
-- (assignee) dela, então quando quem finalizava/conferia era admin ou
-- supervisor (ou a mesclagem de duplicatas desta semana herdou mensagens
-- sem recalcular o contador — ver scripts/src/mergeDuplicates.ts), o valor
-- antigo nunca era corrigido no banco — só na tela, localmente. Isso inflava
-- o badge do widget de chat flutuante, que soma unreadCount de todo mundo
-- que a conta enxerga (admin/supervisor veem resolvidas na lista).
-- A partir de agora o PATCH que finaliza/arquiva já zera isso — esta
-- migration só limpa o que já ficou preso antes dessa correção existir.
UPDATE conversations
SET unread_count = 0
WHERE unread_count > 0 AND (status IN ('resolved', 'archived') OR is_archived = true);
