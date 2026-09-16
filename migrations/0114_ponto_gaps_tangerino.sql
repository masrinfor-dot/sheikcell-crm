-- Correções de Ponto/Banco de Horas (rodada 16/09) a partir da comparação
-- ao vivo com o Tangerino (Sólides), autorizada pelo lojista: calendário de
-- feriados, tolerância de atraso aplicada no cálculo (antes só existia pro
-- lembrete de WhatsApp), vencimento do banco de horas e geofence por loja.

-- Calendário de feriados — abate o expediente esperado do banco de horas.
CREATE TABLE IF NOT EXISTS holidays (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  date date NOT NULL,
  name text NOT NULL,
  excuses_expected boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS holidays_tenant_date_unique ON holidays (tenant_id, date);

-- Tolerância de atraso por escala, agora também usada no cálculo do banco
-- de horas (antes só existia hardcoded pro lembrete de WhatsApp).
ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS tolerance_minutes integer NOT NULL DEFAULT 10;

-- Vencimento do banco de horas (meses) — null = sem vencimento (padrão).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS time_bank_validity_months integer;

-- Geofence do Ponto por loja — null (qualquer um) = sem geofence configurado.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS geofence_lat double precision;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS geofence_lng double precision;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS geofence_radius_meters integer;
