---
name: Scheduled messages / retornos
description: Agendamento de mensagem ou retorno ligado ao quadro de Tarefas — regras e armadilhas
---
- Tabela scheduled_messages; cada agendamento cria tarefa espelho (taskId) no quadro (insert direto, bypass do requirePerm("tarefas") de propósito).
- Scheduler: tick 30s em api-server lib/scheduler.ts, iniciado em index.ts. Reivindica linha atomicamente (pending→processing) antes de enviar — nunca remover essa guarda (evita envio duplo e envio de cancelados).
- kind "mensagem" envia pelo mesmo fluxo do bridge (HMAC X-Bridge-Secret) e marca a tarefa como done ao entregar; kind "retorno" não envia nada (a tarefa é o lembrete).
- Vendedor só agenda "mensagem" em conversa da qual é o responsável (mesma regra de posse do envio).
- Cancelar agendamento arquiva a tarefa espelho.
- Avisos em tempo real: no vencimento, scheduler emite SSE "schedule_due" (retorno) e "schedule_failed" (mensagem agendada que falhou), direcionados via restrictedTo=[createdById] (admin/supervisor do setor também recebem). ChatCenter mostra toast clicável + item no sino (MsgNotification.kind).
