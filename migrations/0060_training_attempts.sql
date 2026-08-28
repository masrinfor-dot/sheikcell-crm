-- Repetir treinamento: até aqui só existia 1 linha de conclusão por
-- (treinamento, usuário) — repetir era literalmente bloqueado (409 "Você já
-- concluiu"). Agora vira histórico de tentativas: cada conclusão grava uma
-- linha nova com attempt_number incrementado, nada é apagado nem
-- sobrescrito. E ganha uma tabela de rascunho (training_progress) pra
-- "Continuar de onde parou" num quiz em andamento.
--
-- Aditivo e idempotente: dado existente vira "tentativa 1" de cada usuário
-- (attempt_number nasce com default 1 em toda linha já gravada), nenhuma
-- conclusão passada muda de significado.

ALTER TABLE training_completions ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS training_completions_unique;
CREATE UNIQUE INDEX IF NOT EXISTS training_completions_attempt_unique
  ON training_completions (training_id, user_id, attempt_number);

CREATE TABLE IF NOT EXISTS training_progress (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  training_id integer NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers jsonb,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS training_progress_unique
  ON training_progress (training_id, user_id);
