ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS store_ids jsonb;
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS user_ids jsonb;
