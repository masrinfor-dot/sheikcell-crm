-- Corrige uma lacuna real: o campo isBoxPhoto foi adicionado ao schema
-- (lib/db/src/schema/catalog.ts) pra marcar foto da caixa/embalagem lacrada
-- (carrossel da Vitrine mostra a foto da caixa primeiro pra aparelho "novo"),
-- mas nunca ganhou uma migração — a coluna nunca existiu de fato no banco de
-- produção. Isso quebrava toda consulta em catalog_product_photos (inclusive
-- GET /catalog/products, a lista inteira da Vitrine) com "column is_box_photo
-- does not exist", causando o toast "Erro ao carregar a vitrine" e o erro no
-- botão "Buscar fotos que faltam". Ver artifacts/api-server/src/routes/catalog.ts.
ALTER TABLE catalog_product_photos ADD COLUMN IF NOT EXISTS is_box_photo boolean NOT NULL DEFAULT false;
