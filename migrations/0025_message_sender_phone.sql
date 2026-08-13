-- Telefone de quem mandou uma mensagem DENTRO de um grupo do WhatsApp
-- (participante), extraído do key.participant do Baileys — permite abrir uma
-- conversa individual com aquele participante a partir da Central.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_phone text;
