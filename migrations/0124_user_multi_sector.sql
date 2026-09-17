-- Vendedor em mais de um setor (pedido 17/09: "colocar vendedores com mais
-- de um setor"). Mesmo padrão já usado em whatsapp_sessions.default_sector_ids
-- (migration 0117): adiciona a lista sector_ids (jsonb) preservando o setor
-- único já cadastrado (sector_id) como primeiro item da lista. sector_id NÃO
-- é removido — continua como o setor primário/de exibição, mantido em
-- sincronia com sector_ids[0] pela aplicação.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sector_ids jsonb NOT NULL DEFAULT '[]';
UPDATE users SET sector_ids = jsonb_build_array(sector_id)
  WHERE sector_id IS NOT NULL AND sector_ids = '[]'::jsonb;
