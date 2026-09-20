-- Métricas do disparo em massa (ChatCenter → Resolvidas → "Disparar mensagem
-- para vários"): antes nada ficava salvo, o resultado só aparecia no toast na
-- hora. Cada linha é uma leva disparada, com o intervalo real usado e o
-- resultado por conversa.
CREATE TABLE IF NOT EXISTS broadcast_dispatch_log (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  message TEXT NOT NULL,
  total_selected INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  interval_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  results JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS broadcast_dispatch_log_tenant_started_idx
  ON broadcast_dispatch_log (tenant_id, started_at DESC);
