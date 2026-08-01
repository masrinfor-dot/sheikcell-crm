-- Transcrição de áudios (Whisper). Idempotente.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcript text;
