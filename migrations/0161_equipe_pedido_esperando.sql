-- Tela "Equipe" (chat interno + pedidos): pedido "Esperando alguém" e por quem.
-- Ligado ao número da tarefa (vale com as tarefas aqui ou no ERP Prumo).
CREATE TABLE IF NOT EXISTS task_waiting (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  task_id integer NOT NULL,
  waiting_for text NOT NULL,
  set_by_id integer REFERENCES users(id) ON DELETE SET NULL,
  since timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS task_waiting_tenant_task_uq ON task_waiting(tenant_id, task_id);
