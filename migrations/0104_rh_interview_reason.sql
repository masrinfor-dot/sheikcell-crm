-- Entrevista online (Google Meet) + motivo de status no Recrutamento
-- (pedido 11/09: "adiciona aaba azer entrevista online atraves do meet
-- criar roteiro de perguntas... criar motivo para pre aprovação, aprovado
-- e reprovado"). Idempotente.
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE rh_candidates ADD COLUMN IF NOT EXISTS interview_notes jsonb;
