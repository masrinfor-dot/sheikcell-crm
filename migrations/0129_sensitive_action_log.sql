-- Auditoria de ações sensíveis (item 21 do roadmap "Central de Atendimento"):
-- transferência de atendimento/setor, edição e exclusão de mensagem,
-- exclusão de atendimento. "Entrar como"/modo espiar já é auditado à parte
-- em impersonation_log.
CREATE TABLE IF NOT EXISTS sensitive_action_log (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  user_id integer,
  user_name text NOT NULL,
  action text NOT NULL,
  description text NOT NULL,
  conversation_id integer,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensitive_action_log_tenant_created_idx
  ON sensitive_action_log (tenant_id, created_at DESC);
