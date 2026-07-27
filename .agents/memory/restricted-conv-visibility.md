---
name: Restricted conversation visibility
description: Regra de visibilidade de atendimentos ativos/resolvidos (chat)
---
Regra: conversa "restrita" = assigneeId != null OU status resolved/archived OU isArchived.
Visível apenas para: vendedor responsável + participantes; admin (global); supervisor do MESMO setor (supervisor com sectorId null = global, para não travar legado).
Potenciais/pendentes seguem o escopo antigo (potenciais cross-sector, pendentes por setor).
**Why:** pedido do usuário — atendimentos ativos/resolvidos não devem ser vistos por colegas do setor.
**How to apply:** a regra vive em 4 lugares que DEVEM andar juntos: canAccessConversation, SQL do list endpoint, allowed() do SSE (BufferedEvent.restrictedTo, inclusive replay) e isVisibleToMe no frontend. Transições p/ restrita emitem evento leve "conversation_hidden" {id, keepFor, sectorId} para o escopo antigo remover da tela sem vazar conteúdo — lembrar dele ao criar novas transições (novo endpoint que atribui/finaliza conversa).
