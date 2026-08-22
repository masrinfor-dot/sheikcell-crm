-- Rotinas e Produtividade (Fase 3): trava dura + "Atendimento urgente".
-- Bypass nunca marca o checklist como respondido — só libera temporariamente
-- o uso do sistema, registrando que foi usado (item 44 do relatório mestre).
CREATE TABLE IF NOT EXISTS routine_urgent_bypasses (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  checklist_id integer NOT NULL REFERENCES routine_checklists(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routine_urgent_bypasses_user_idx ON routine_urgent_bypasses (user_id);
