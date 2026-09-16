-- Robô: "tempo de resposta digitando" configurável por loja (pedido 16/09).
-- Default 5s — some ao "humanPacing" que a ponte do WhatsApp já faz sozinha
-- por tamanho de texto; este é um atraso extra, configurável, antes de cada
-- resposta gerada por IA, pra não parecer robótico respondendo instantâneo.
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS typing_delay_seconds integer NOT NULL DEFAULT 5;
