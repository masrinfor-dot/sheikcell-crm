-- Painel do Sistema (Fase 2): motivo obrigatório no "Entrar como" + auditoria
-- global de ações do superadmin.
ALTER TABLE impersonation_log ADD COLUMN IF NOT EXISTS reason text;

CREATE TABLE IF NOT EXISTS superadmin_audit_log (
  id serial PRIMARY KEY,
  superadmin_user_id integer NOT NULL REFERENCES users(id),
  tenant_id integer REFERENCES tenants(id),
  action text NOT NULL,
  description text NOT NULL,
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS superadmin_audit_log_created_idx ON superadmin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS superadmin_audit_log_tenant_idx ON superadmin_audit_log(tenant_id);
