ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS conversation_id integer;
CREATE INDEX IF NOT EXISTS attendance_logs_conversation_id_idx ON attendance_logs (conversation_id) WHERE conversation_id IS NOT NULL;
