-- Robô ligado/desligado POR LINHA de WhatsApp (pedido 17/09: "decidir em
-- quais números o robô vai agir"). Default true: nenhuma linha muda de
-- comportamento até o admin desligar explicitamente em Administração →
-- WhatsApp — o robô continua atendendo normalmente em todos os números até
-- alguém escolher tirar uma linha específica.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS bot_enabled boolean NOT NULL DEFAULT true;
