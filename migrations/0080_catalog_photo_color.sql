-- Permite marcar qual cor cadastrada do produto uma foto representa, pra
-- vitrine pública mostrar a foto certa quando o cliente troca de cor no
-- seletor (antes, todas as cores mostravam o mesmo álbum de fotos). Ver
-- catalogProductPhotosTable em lib/db/src/schema/catalog.ts e
-- autoAttachPhotosForProduct em artifacts/api-server/src/routes/catalog.ts.
-- null = foto "geral" (mostrada em qualquer cor, e usada de fallback quando
-- a cor escolhida não tem foto própria).
ALTER TABLE catalog_product_photos ADD COLUMN IF NOT EXISTS color text;
