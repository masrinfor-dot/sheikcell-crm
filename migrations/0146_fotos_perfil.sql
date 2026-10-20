-- Fotos de perfil do WhatsApp guardadas no CRM (20/10/2026: "o CRM tem que
-- puxar as fotos de perfil também"). O link do WhatsApp expira em poucos
-- dias; a rotina baixa a imagem e marca quando buscou por último.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_fetched_at timestamptz;
CREATE INDEX IF NOT EXISTS conversations_avatar_fetch_idx
  ON conversations (tenant_id, session_key, avatar_fetched_at)
  WHERE channel = 'whatsapp';
