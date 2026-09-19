-- Margem PRÓPRIA da avaliação de usados na Vitrine pública (pedido 19/09:
-- editar a margem na Vitrine estava alterando, sem querer, a "Tabela 2
-- (média)" usada pelo vendedor na avaliação manual dentro do CRM — as duas
-- eram literalmente o mesmo valor). Null (padrão) mantém o comportamento de
-- sempre (usa margins.t2) até a loja configurar um valor próprio pela Vitrine.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS public_trade_in_margin_pct integer;
