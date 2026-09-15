-- Fase 1 do Painel do Sistema (gaps restantes): sub-perfis do superadmin
-- (escopos restritos), 2FA por e-mail no login do superadmin, e estrutura
-- de cobrança automática (Pix/boleto) nas mensalidades — só a estrutura,
-- sem gateway real integrado ainda.

-- null (padrão) = acesso completo, exatamente como todo superadmin de hoje
-- já é (nada muda pra quem já existe). Um array (ex.: ["billing"]) passa a
-- restringir esse superadmin aos escopos ali listados — ver
-- requireSuperadminScope/requireFullSuperadmin em middlewares/auth.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS superadmin_scopes jsonb;

-- Código de 2FA por e-mail, só pro login de superadmin (papel mais
-- sensível do sistema — acesso a todas as lojas). Guarda só o hash do
-- código, nunca o valor puro (mesmo padrão de password_reset_tokens).
CREATE TABLE IF NOT EXISTS two_factor_codes (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS two_factor_codes_user_id_idx ON two_factor_codes(user_id);

-- Preparação pra cobrança automática (Pix/boleto) — payment_method
-- "manual" (padrão) preserva o fluxo atual (superadmin marca "paga" na
-- mão) pra toda mensalidade já existente e pra quem continuar sem
-- gateway configurado.
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'manual';
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS external_reference text;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS pix_payload text;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS boleto_url text;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS reminders_sent_count integer NOT NULL DEFAULT 0;
