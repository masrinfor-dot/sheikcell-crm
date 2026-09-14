ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_queue_single_task boolean NOT NULL DEFAULT false;
