-- Explicação da solução aplicada ao marcar um chamado de suporte como
-- "resolvido" — fica registrada e visível pra sempre (o chamado nunca é
-- arquivado/escondido, só muda de status).
ALTER TABLE saas_tickets ADD COLUMN IF NOT EXISTS resolution_note text;
