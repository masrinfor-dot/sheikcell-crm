-- Identifica qual loja da rede está comprando o aparelho usado em cada
-- avaliação de compra — pedido do lojista (09/09): com várias lojas
-- cadastradas, precisa aparecer no histórico/nota de compra qual loja
-- fechou aquele negócio. store_id é FK de verdade (pra relatório agrupar
-- por loja de forma confiável); store_name é o texto copiado (mesmo padrão
-- já usado em users.store_name/store_id), pra continuar funcionando mesmo
-- se a loja for renomeada ou removida depois. Idempotente.
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS store_id integer REFERENCES stores(id);
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS store_name text;
