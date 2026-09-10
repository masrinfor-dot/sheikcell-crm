-- Reconhecimento facial na batida de ponto (pedido 10/09, análise
-- Tangerino) — opt-in por loja, default desligado.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS facial_recognition_enabled boolean NOT NULL DEFAULT false;
