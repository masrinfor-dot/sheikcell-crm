-- Rotinas e Produtividade: padrão invertido de justificativa — pergunta
-- onde a pendência dispara na resposta POSITIVA ("Sim"), não na negativa
-- (ex.: "Encontrou alguma irregularidade?"). Aditiva, mesmo padrão de
-- requires_justification_on_no.

ALTER TABLE routine_checklist_questions
  ADD COLUMN IF NOT EXISTS requires_justification_on_yes boolean NOT NULL DEFAULT false;
