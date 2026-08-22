-- Rotinas e Produtividade (Fase 6): relatório por loja, score configurável,
-- ranking e fluxo de aprovação do supervisor. Tudo aditivo.

ALTER TABLE routine_responses
  ADD COLUMN IF NOT EXISTS pendency_review_status text,
  ADD COLUMN IF NOT EXISTS pendency_reviewed_by_user_id integer,
  ADD COLUMN IF NOT EXISTS pendency_review_note text,
  ADD COLUMN IF NOT EXISTS pendency_reviewed_at timestamptz;

ALTER TABLE routine_urgent_bypasses
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id integer,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE routine_closures
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by_user_id integer;

CREATE TABLE IF NOT EXISTS routine_score_weights (
  tenant_id integer PRIMARY KEY,
  weight_on_time integer NOT NULL DEFAULT 50,
  weight_no_pendency integer NOT NULL DEFAULT 30,
  weight_no_urgent_abuse integer NOT NULL DEFAULT 20,
  updated_at timestamptz NOT NULL DEFAULT now()
);
