-- Fila de atendimento com direcionamento por vendedor_chefe/supervisor
-- (pedido 10/09): filtro por usuário selecionado, em ordem de fila, um
-- atendimento por vez, com protocolo visível desde o início.

ALTER TABLE users ADD COLUMN IF NOT EXISTS queue_restrict_to_assigned boolean NOT NULL DEFAULT false;

ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS target_user_id integer REFERENCES users(id);
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS routed_by integer REFERENCES users(id);
CREATE INDEX IF NOT EXISTS queue_entries_target_user_idx ON queue_entries(target_user_id);
