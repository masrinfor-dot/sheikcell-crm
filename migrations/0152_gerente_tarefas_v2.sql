-- Gerente IA: categoria (projeto) das tarefas do quadro.
CREATE TABLE IF NOT EXISTS gerente_task_meta (
  task_id integer PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id integer NOT NULL,
  category text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gerente_task_meta_tenant_idx ON gerente_task_meta(tenant_id);
