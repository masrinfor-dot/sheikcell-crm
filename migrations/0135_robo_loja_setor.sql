-- Robô direciona para loja e setor (07/10/2026).
-- Treinamento de direcionamento: texto livre que o admin escreve ensinando
-- o robô a escolher loja e setor (ex.: "cliente de Padre Paraíso → loja PP").
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS routing_guide text NOT NULL DEFAULT '';
-- Loja escolhida pelo robô para a conversa (etiqueta; todos do setor veem).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS target_store_id integer REFERENCES stores(id) ON DELETE SET NULL;
