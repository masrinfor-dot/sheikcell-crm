-- Restrição de acesso por número/linha de WhatsApp (session_key) para
-- vendedores em lojas com mais de uma linha conectada (ex.: "Varejo",
-- "Atacado"). NULL = sem restrição (vê/responde todas as linhas da loja,
-- comportamento de hoje) — mesmo padrão de null-é-irrestrito já usado em
-- access_hours e admin_access.
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_session_keys jsonb;
