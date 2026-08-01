-- Reuniões online da equipe: sala de vídeo + gravação + transcrição por IA.
CREATE TABLE IF NOT EXISTS meetings (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  room_code text NOT NULL,
  status text NOT NULL DEFAULT 'aberta', -- aberta | gravada | transcrita
  recording_name text,                   -- arquivo de áudio no disco (DOCS_DIR)
  recording_bytes integer,
  transcript text,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS meetings_tenant_idx ON meetings (tenant_id, created_at DESC);
