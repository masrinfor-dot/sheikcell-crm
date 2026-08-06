-- Trilha de auditoria do módulo financeiro bancário — quem cadastrou/editou/
-- excluiu conta, gravou credencial, ou confirmou/rejeitou uma conciliação.
-- Só inserção: nenhuma rota de update/delete sobre esta tabela.
CREATE TABLE IF NOT EXISTS finance_audit_log (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  user_id integer REFERENCES users(id),
  action text NOT NULL, -- account.create | account.update | account.delete | credential.save | match.confirm | match.reject
  entity_type text NOT NULL, -- bank_account | bank_integration_credential | reconciliation_match
  entity_id integer NOT NULL,
  metadata jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_audit_log_tenant_idx ON finance_audit_log (tenant_id, created_at DESC);
