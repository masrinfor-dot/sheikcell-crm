-- Permite vincular MAIS DE UM setor a uma linha de WhatsApp (pedido 16/09,
-- evolução do "vincular setor pra direcionar"): troca a coluna única
-- default_sector_id por uma lista default_sector_ids (jsonb). Preserva o
-- vínculo já configurado (se houver) como lista de 1 item antes de remover
-- a coluna antiga.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS default_sector_ids jsonb NOT NULL DEFAULT '[]';
UPDATE whatsapp_sessions SET default_sector_ids = jsonb_build_array(default_sector_id)
  WHERE default_sector_id IS NOT NULL AND default_sector_ids = '[]'::jsonb;
ALTER TABLE whatsapp_sessions DROP COLUMN IF EXISTS default_sector_id;
