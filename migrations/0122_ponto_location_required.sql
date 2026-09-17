ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ponto_location_required boolean NOT NULL DEFAULT true;
