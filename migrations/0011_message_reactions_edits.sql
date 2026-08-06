-- Reações e edições de mensagens do WhatsApp (Baileys): antes eram
-- descartadas silenciosamente (edição/reação) ou apareciam como
-- "(mensagem não suportada)" na Central de Atendimento.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb;
