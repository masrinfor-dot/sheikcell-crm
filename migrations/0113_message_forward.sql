-- Encaminhar mensagem entre conversas no Atendimento (estilo WhatsApp).
-- Marca a cópia encaminhada — igual ao "forwarded" que já existe no Chat
-- Interno (internal_chat_messages), mas aqui o encaminhamento também
-- dispara envio real pro WhatsApp do destinatário.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;
