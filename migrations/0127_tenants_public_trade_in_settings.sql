-- Avaliação de usados na vitrine pública, liga/desliga POR LOJA (pedido
-- 18/09: "criar um botão para desativa as avaliações de celulares na
-- vitrine, dentro do crm permanece, e um limite personalizável de número
-- de avaliações"). Default true e limite null (5) mantêm o comportamento
-- de sempre até o admin mudar em Administração → Avaliação de Usados.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS public_trade_in_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS public_trade_in_ai_limit integer;
