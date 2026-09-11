-- Prioridade manual do atendimento na Central de Atendimento (pedido 11/09:
-- diferenciar urgente / precisa de retorno / pode aguardar, pra organizar a
-- fila e não perder atendimento novo ou prioritário no meio de conversas
-- antigas). Null = sem prioridade definida (comportamento igual a antes).
-- Idempotente.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS priority text;
