-- Link público de upload de documentos pro candidato/colaborador em
-- contratação subir os próprios documentos, sem login.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS documents_upload_token text;
CREATE UNIQUE INDEX IF NOT EXISTS employees_documents_upload_token_unique ON employees(documents_upload_token) WHERE documents_upload_token IS NOT NULL;
