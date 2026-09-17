-- Avaliação de usados por conversa no WhatsApp (pedido 17/09): interruptor
-- de ligar/desligar a ferramenta do robô que conduz a avaliação de troca
-- (marca/modelo/questionário → estimativa), igual à avaliação pública da
-- vitrine, só que dentro da própria conversa. Começa desligado.

ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS trade_in_enabled boolean NOT NULL DEFAULT false;
