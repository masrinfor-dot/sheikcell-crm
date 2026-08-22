-- Rotinas e Produtividade (Fase 2): respostas de checklist. Cada execução
-- grava uma linha nova (nunca sobrescreve) — histórico por construção.
-- questions_snapshot guarda as perguntas exatamente como estavam no momento
-- da resposta, então editar o checklist depois nunca muda o sentido de uma
-- resposta antiga (item 61 do relatório mestre).

CREATE TABLE IF NOT EXISTS routine_responses (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  checklist_id integer NOT NULL REFERENCES routine_checklists(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  answers jsonb NOT NULL,
  questions_snapshot jsonb NOT NULL,
  reauth_at timestamptz NOT NULL,
  device_info text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS routine_responses_unique ON routine_responses (checklist_id, user_id, period_key);
CREATE INDEX IF NOT EXISTS routine_responses_user_idx ON routine_responses (user_id);
