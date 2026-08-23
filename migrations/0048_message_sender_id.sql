-- Identificação individual do vendedor (item 5 do roadmap "Fase 1 |
-- Atendimento WhatsApp"): messages.sender_name já existia (snapshot de
-- texto), mas não havia o id do usuário. ON DELETE SET NULL para a
-- identificação sobreviver mesmo se o vendedor sair da empresa.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_id integer REFERENCES users(id) ON DELETE SET NULL;
