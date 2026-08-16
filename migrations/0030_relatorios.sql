-- Relatórios: loja (store_id) como dimensão real, snapshot no momento do
-- evento (mesmo padrão de conversations.survey_scale_max) — nunca um join
-- ao vivo em users.store_name (texto livre, sem FK).

-- 1) users ganha uma FK real pra stores. store_name continua existindo e
--    sendo usado em paralelo (nada quebra). Backfill por nome exato,
--    escopado ao tenant.
ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id integer REFERENCES stores(id);
UPDATE users u SET store_id = s.id
  FROM stores s
  WHERE u.store_id IS NULL AND u.store_name IS NOT NULL
    AND s.tenant_id = u.tenant_id AND s.name = u.store_name;

-- 2) conversations ganha store_id (snapshot de quem está com o atendimento).
--    Sem backfill: só passa a existir para atendimentos novos a partir daqui.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS store_id integer REFERENCES stores(id);

-- 3) attendance_logs ganha store_id — mesma filosofia de sector_id/attendant_id
--    nesta tabela (fato histórico congelado, sem FK).
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS store_id integer;

-- 4) Satisfação normalizada (0-100%) gravada no momento da resposta, e tempo
--    de primeira resposta (agilidade inicial, separado do tempo total).
--    Registros antigos ficam com estas colunas NULL (a escala usada não dá
--    pra reconstruir retroativamente).
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS satisfaction_scale_max integer;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS satisfaction_percent integer;
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS first_response_seconds integer;

-- 5) "Iniciados por dia" confiável (ver lib/db/src/schema/attendance_start_events.ts).
CREATE TABLE IF NOT EXISTS attendance_start_events (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  conversation_id integer NOT NULL,
  attendant_id integer NOT NULL,
  sector_id integer,
  store_id integer,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_start_events_tenant_started_idx ON attendance_start_events(tenant_id, started_at);

-- 6) Performance da consulta "não resolvidos" (ao vivo, roda a cada refresh
--    da tela).
CREATE INDEX IF NOT EXISTS conversations_unresolved_idx ON conversations(tenant_id, status, attendance_started_at)
  WHERE status IN ('open', 'pending');

-- 7) Libera o módulo opcional "Relatórios" pra todas as lojas já existentes
--    (mesma lógica do backfill de módulos em 0024) — ninguém perde acesso,
--    e o admin da loja pode desativar depois pelo Superadmin se quiser.
UPDATE tenants SET enabled_modules = enabled_modules || '["relatorios"]'::jsonb
  WHERE NOT (enabled_modules @> '["relatorios"]'::jsonb);
