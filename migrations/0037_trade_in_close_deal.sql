-- Passo "Fechar negócio" da avaliação de usados: captura dados de quem está
-- vendendo o aparelho pra loja e o valor final negociado (pode diferir do
-- suggestedPrice calculado pela IA). Preenchidos só quando o negócio fecha —
-- uma avaliação pode nunca ser fechada.
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS seller_customer_name text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS seller_cpf text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS imei text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS final_agreed_price text;
ALTER TABLE trade_in_evaluations ADD COLUMN IF NOT EXISTS closed_at timestamp;
