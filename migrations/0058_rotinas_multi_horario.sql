-- Rotinas ganha múltiplos horários por checklist no mesmo dia (ex.:
-- conferência de caixa 3x/dia, em vez de só 1x). Aditivo: scheduled_times é
-- opcional (null pra quem continua com um horário só), e occurrence_time
-- nasce com default '' em todas as linhas existentes — nenhum checklist ou
-- resposta antiga muda de comportamento, nenhum backfill necessário.

ALTER TABLE routine_checklists ADD COLUMN IF NOT EXISTS scheduled_times jsonb;
ALTER TABLE routine_responses ADD COLUMN IF NOT EXISTS occurrence_time text NOT NULL DEFAULT '';

DROP INDEX IF EXISTS routine_responses_unique;
CREATE UNIQUE INDEX IF NOT EXISTS routine_responses_unique
  ON routine_responses (checklist_id, user_id, period_key, occurrence_time);
