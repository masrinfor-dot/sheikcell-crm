-- Chat interno ganha editar/apagar mensagem, igual ao Atendimento (P7:
-- paridade de funcionalidades entre os dois chats).

ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
