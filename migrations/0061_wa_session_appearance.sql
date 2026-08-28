-- Cada número de WhatsApp conectado (whatsapp_sessions) ganha uma cor e um
-- ícone (emoji) próprios, pra distinguir visualmente de qual número vem cada
-- atendimento na Central (hoje a etiqueta "via <número>" era sempre da mesma
-- cor fixa, então dois números pareciam iguais e facilitava confundir/errar
-- de qual conexão respondia). Aditivo e idempotente, como as demais.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#10b981';
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS icon TEXT;
