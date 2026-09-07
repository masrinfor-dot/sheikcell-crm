-- Ficha técnica em grade de ícones (pedido do lojista, 07/09): "a ficha
-- tecnica e descrição tem que vir nesse estilo" (referência de site de
-- comparação de preços com ícones Rede/Processador/GPS/Sistema/Tela/
-- Câmera/Vídeo). Campo novo, separado do antigo ai_characteristics (lista
-- livre), que fica mantido só pra produtos antigos já cadastrados com ele.
-- Idempotente.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS ai_specs jsonb;
