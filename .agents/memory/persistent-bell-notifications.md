---
name: Persistent bell notifications
description: chat_notifications table backs the Central bell for schedule due/failed notices
---
Schedule notices (retorno vencido, envio agendado falhou) are persisted per-user in `chat_notifications` by the scheduler BEFORE the SSE broadcast, so offline vendedores see them when the Central loads. Frontend merges them with SSE notices by id `sched-<kind>-<scheduledId>` (dedupe). Read state is per-user; mark-read endpoint accepts optional conversationId. **Why:** SSE replay buffer (1000 events) drops notices for long-offline users. **How to apply:** any new "must not be missed" notice should insert a chat_notifications row (scoped to a userId, fail closed) and reuse the same bell load/mark-read flow.
