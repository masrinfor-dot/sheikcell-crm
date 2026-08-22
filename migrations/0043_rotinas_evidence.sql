-- Rotinas e Produtividade (Fase 4): evidência (foto/documento) anexada a uma
-- pergunta de uma resposta. Arquivo em disco (mesmo padrão de documents.ts:
-- UUID + validação de magic-bytes), metadado aqui.

CREATE TABLE IF NOT EXISTS routine_response_evidence (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  response_id integer NOT NULL REFERENCES routine_responses(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES routine_checklist_questions(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  stored_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routine_response_evidence_response_idx ON routine_response_evidence (response_id);
