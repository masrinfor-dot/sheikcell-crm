-- Mensagem apagada/revogada pelo cliente no WhatsApp (protocolMessage REVOKE):
-- antes era descartada silenciosamente pela ponte (bridge) e o atendente
-- nunca ficava sabendo que a mensagem tinha sido apagada.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
