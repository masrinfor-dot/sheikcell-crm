-- Lembrete único da pesquisa de satisfação: registra quando o lembrete foi
-- enviado para esta pesquisa pendente (NULL = ainda não enviado).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS survey_reminder_sent_at timestamptz;
