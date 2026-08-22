-- Rotinas e Produtividade (Fase 3.5): recorrência "contínuo durante o
-- expediente" (sem horário fixo) + justificativa estruturada em resposta
-- negativa (motivo/pendência/quem comunicar) + mapeamento de nível de
-- alerta por pergunta. Tudo aditivo — nenhuma resposta antiga muda de
-- sentido (o snapshot de cada resposta já congela o formato da pergunta
-- na hora em que foi respondida).

ALTER TABLE routine_checklists ALTER COLUMN scheduled_time DROP NOT NULL;

ALTER TABLE routine_checklist_questions
  ADD COLUMN IF NOT EXISTS requires_justification_on_no boolean NOT NULL DEFAULT false;
ALTER TABLE routine_checklist_questions
  ADD COLUMN IF NOT EXISTS alert_level text;
