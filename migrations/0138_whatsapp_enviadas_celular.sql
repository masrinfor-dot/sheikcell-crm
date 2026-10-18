-- Mensagens enviadas pelo celular (17/10/2026): com isto ligado na linha, o
-- que alguém digita direto no celular dela aparece na conversa do CRM como
-- mensagem enviada (o que o próprio sistema envia já aparecia).
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS phone_outbound_enabled boolean NOT NULL DEFAULT false;
