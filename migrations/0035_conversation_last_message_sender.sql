-- Nome de quem mandou a última mensagem da conversa (atendente, robô, pesquisa,
-- mensagem agendada, sorteio) — usado na listagem pra mostrar "vendedor" da
-- última mensagem sem precisar de JOIN em messages a cada linha da lista.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_sender_name text;
