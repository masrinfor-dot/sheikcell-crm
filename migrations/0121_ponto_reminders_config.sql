ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ponto_reminders_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ponto_reminder_grace_minutes integer;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ponto_reminder_message_entrada text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ponto_reminder_message_saida text;
