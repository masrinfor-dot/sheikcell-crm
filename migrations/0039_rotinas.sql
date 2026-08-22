-- Rotinas e Produtividade (Fase 1): checklists operacionais agendados
-- (abertura, fechamento, conferência de caixa etc.) — modelo de dados +
-- CRUD do admin. Sem trava/agendamento disparando ainda (fases seguintes).
--
-- Escopo de quem responde é resolvido por regras flat combináveis
-- (loja/setor/função/usuário) em routine_checklist_scopes, não uma árvore
-- FK rígida — "mais específico vence" é um algoritmo de match em código
-- sobre essas linhas, não uma hierarquia de schema (setores hoje não são
-- por loja, e função é texto livre em employees.job_function).

CREATE TABLE IF NOT EXISTS routine_checklists (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  name text NOT NULL,
  message text,
  scheduled_time text NOT NULL,
  recurrence text NOT NULL DEFAULT 'daily',
  recurrence_days jsonb,
  specific_date date,
  tolerance_minutes integer NOT NULL DEFAULT 0,
  mandatory boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routine_checklist_questions (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  checklist_id integer NOT NULL REFERENCES routine_checklists(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  type text NOT NULL DEFAULT 'yes_no',
  required boolean NOT NULL DEFAULT true,
  requires_evidence boolean NOT NULL DEFAULT false,
  evidence_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routine_checklist_questions_checklist_idx ON routine_checklist_questions (checklist_id);

CREATE TABLE IF NOT EXISTS routine_checklist_scopes (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  checklist_id integer NOT NULL REFERENCES routine_checklists(id) ON DELETE CASCADE,
  store_id integer REFERENCES stores(id),
  sector_id integer REFERENCES sectors(id),
  job_function text,
  user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routine_checklist_scopes_checklist_idx ON routine_checklist_scopes (checklist_id);

-- Loja já contratada mas criada antes deste módulo existir: sem backfill,
-- ela nunca teria "rotinas" no enabled_modules e a aba nunca apareceria.
UPDATE tenants
SET enabled_modules = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(enabled_modules || '["rotinas"]'::jsonb) AS elem
)
WHERE NOT (enabled_modules ? 'rotinas');
