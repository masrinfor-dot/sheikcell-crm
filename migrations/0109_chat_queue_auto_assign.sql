ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS queue_auto_assign_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_queue_last_assigned_at timestamp with time zone;
