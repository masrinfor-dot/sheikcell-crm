-- Nome do cliente já na hora da simulação (etapas 1-3), antes de fechar o
-- negócio. Até aqui, o único "nome" gravado era seller_customer_name,
-- preenchido só na etapa 4 (fechar negócio) — uma avaliação que nunca chega
-- a ser fechada (cliente foi pensar, avaliação feita só de curiosidade etc.)
-- ficava sem nenhum nome associado no histórico. customer_name é opcional
-- (nullable, não bloqueia a simulação) e serve só de referência/busca no
-- histórico; ao fechar o negócio de verdade, seller_customer_name continua
-- sendo o nome que vale (pode ser preenchido a partir deste, mas é editável).
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS customer_name text;
