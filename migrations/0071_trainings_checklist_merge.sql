ALTER TABLE trainings ADD COLUMN IF NOT EXISTS questions jsonb;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS recurrence text;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS day_of_week integer;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS start_date text;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS legacy_checklist_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS trainings_legacy_checklist_id_idx ON trainings (legacy_checklist_id) WHERE legacy_checklist_id IS NOT NULL;

ALTER TABLE training_completions ADD COLUMN IF NOT EXISTS period_key text;
CREATE UNIQUE INDEX IF NOT EXISTS training_completions_period_unique ON training_completions (training_id, user_id, period_key) WHERE period_key IS NOT NULL;

-- Fusão de verdade no banco: o antigo módulo "Questionários" (tabelas
-- checklists / checklist_responses) vira o tipo "checklist" dentro de
-- trainings / training_completions. Isso roda só UMA vez, na primeira subida
-- depois deste deploy — copia os dados e RENOMEIA (não apaga) as tabelas
-- antigas para *_deprecated, como rede de segurança. Em toda subida seguinte
-- a tabela "checklists" já não existe mais com esse nome, então o IF EXISTS
-- abaixo vem falso e o bloco inteiro vira no-op (idempotente).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'checklists') THEN
    INSERT INTO trainings (
      tenant_id, title, description, type, content, quiz, questions,
      target_roles, recurrence, day_of_week, start_date, mandatory, active,
      legacy_checklist_id, created_at
    )
    SELECT
      c.tenant_id, c.title, c.description, 'checklist', NULL, NULL, c.questions,
      c.target_roles, c.recurrence, c.day_of_week, c.start_date, c.mandatory, c.active,
      c.id, c.created_at
    FROM checklists c
    WHERE NOT EXISTS (SELECT 1 FROM trainings t WHERE t.legacy_checklist_id = c.id);

    INSERT INTO training_completions (
      tenant_id, training_id, user_id, attempt_number, quiz_score, answers,
      period_key, created_at
    )
    SELECT
      cr.tenant_id, t.id, cr.user_id,
      ROW_NUMBER() OVER (PARTITION BY cr.checklist_id, cr.user_id ORDER BY cr.created_at),
      NULL, cr.answers, cr.period_key, cr.created_at
    FROM checklist_responses cr
    JOIN trainings t ON t.legacy_checklist_id = cr.checklist_id
    ON CONFLICT (training_id, user_id, period_key) WHERE period_key IS NOT NULL DO NOTHING;

    ALTER TABLE checklists RENAME TO checklists_deprecated;
    ALTER TABLE checklist_responses RENAME TO checklist_responses_deprecated;
  END IF;
END $$;
