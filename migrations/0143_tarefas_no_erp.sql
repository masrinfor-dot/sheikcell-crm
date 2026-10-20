-- Quadro de tarefas unificado (19/10/2026): as tarefas moram no ERP Prumo.
-- O agendamento de mensagem/retorno do atendimento guarda o número da tarefa
-- espelho no ERP (para concluir/arquivar lá). Idempotente.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS erp_task_number integer;
