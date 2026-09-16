-- Vincular setores aos números de atendimento (whatsapp_sessions) pra
-- direcionar automaticamente as conversas novas que chegam por cada número
-- (pedido 16/09). null = comportamento de sempre (regras de palavra-chave).
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS default_sector_id integer REFERENCES sectors(id);
