-- Duas adições independentes, ambas colunas novas nullable (sem risco pra
-- dados existentes, sem precisar de bloco DO $$ dinâmico — nenhuma coluna é
-- removida nesta migration):
--
-- 1) Cor por variante: até aqui "cor" só existia como lista no PRODUTO
--    (catalog_products.colors), sem distinguir preço/estoque por cor. Agora
--    cada variante (que já distinguia armazenamento) também pode carregar
--    sua própria cor — permite unificar no mesmo cadastro (mesmo
--    modelo+condição) aparelhos que só diferem por armazenamento e/ou cor,
--    com o cliente escolhendo a combinação exata na vitrine pública.
--    Ver artifacts/api-server/src/routes/catalog.ts (VariantInput) e
--    artifacts/sheikcell/src/pages/VitrinePublica.tsx (seletor de variação).
--
-- 2) WhatsApp separado pra atacado: até aqui só existia UM número
--    (tenants.catalog_whatsapp) usado tanto pra quem vê preço de varejo
--    quanto pra quem desbloqueou o atacado. Agora a loja pode configurar um
--    segundo número específico pra atacado; null = continua usando o mesmo
--    número de varejo pra todo mundo (comportamento anterior preservado).
ALTER TABLE catalog_product_variants ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS catalog_whatsapp_wholesale text;
