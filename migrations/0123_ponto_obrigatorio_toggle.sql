ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ponto_obrigatorio_enabled boolean NOT NULL DEFAULT true;
