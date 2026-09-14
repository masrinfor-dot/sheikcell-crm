-- Corrige 3 colunas que existiam em lib/db/src/schema/*.ts (commits d19f8f3e
-- e c28855cc, 14/09) mas nunca ganharam um arquivo migrations/*.sql — a
-- mesma classe de bug documentada em migrate.ts (queda de 11/09, coluna
-- "priority" nunca criada). Sem essa migração, todo select() completo nessas
-- tabelas quebra com "column ... does not exist" (login e Central de
-- Atendimento fora do ar). IF NOT EXISTS: seguro mesmo se já tiver sido
-- aplicado manualmente via correção pontual.
ALTER TABLE sectors ADD COLUMN IF NOT EXISTS vendors_see_resolved boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS queue_number integer;
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS survey_disabled boolean NOT NULL DEFAULT false;
