-- Quadro do atendimento, fase 2 (29/10/2026): prazo de atraso por linha.
-- NULL = usa o prazo geral da loja (alert_unanswered_minutes).
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS alert_minutes integer;
