-- Acesso personalizado por planilha: listas de setores e vendedores liberados.
-- NULL nas duas colunas = liberada para toda a equipe (comportamento antigo).
ALTER TABLE sheet_links ADD COLUMN IF NOT EXISTS allowed_sector_ids integer[];
ALTER TABLE sheet_links ADD COLUMN IF NOT EXISTS allowed_user_ids integer[];
