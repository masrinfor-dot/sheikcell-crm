-- GED com alerta de vencimento (pedido 10/09, análise Tangerino): validade
-- opcional por documento (ASO, certificações, vistos etc.).

ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS expires_at date;
CREATE INDEX IF NOT EXISTS employee_documents_expires_at_idx ON employee_documents(expires_at) WHERE expires_at IS NOT NULL;
