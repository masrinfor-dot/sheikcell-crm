-- Cadastro completo de loja: CPF/CNPJ do responsável + módulos contratados
-- (teto por loja, além do controle de permissão já existente por usuário).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cpf_cnpj text;

-- Backfill com TODOS os módulos pras lojas já existentes — ninguém perde
-- acesso a nada com essa migration. Só lojas novas nascem com a lista do
-- pacote escolhido no cadastro (Básico = vazio, Completo = todos).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enabled_modules jsonb NOT NULL DEFAULT
  '["peliculas","avaliacao","financeiras","financeiro_bancario","rh","treinamentos","questionarios","sorteios","planilhas","documentos","robo"]'::jsonb;

-- Histórico de "entrar como": quem (superadmin) virou quem (admin da loja) e quando.
CREATE TABLE IF NOT EXISTS impersonation_log (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id),
  superadmin_user_id integer NOT NULL REFERENCES users(id),
  target_user_id integer NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
