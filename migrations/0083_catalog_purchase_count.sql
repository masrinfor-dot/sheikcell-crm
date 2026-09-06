-- Contador de "clique em finalizar pedido" na Vitrine — aproximação de
-- popularidade pra ordenar por "mais comprado" (não é venda confirmada de
-- verdade, ver comentário no schema). Idempotente.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS purchase_count integer NOT NULL DEFAULT 0;
