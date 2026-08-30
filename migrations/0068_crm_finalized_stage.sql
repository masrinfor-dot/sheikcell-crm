ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS last_resolution_reason text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS finalized_at timestamp;
