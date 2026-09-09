-- Fila de atendimento no Chat Interno: grupos usados como canal de pedidos
-- (ex.: "Assistência Técnica - Reparos") podem ativar "modo fila" — alguém
-- da equipe "assume" a conversa (fica visível pra todo mundo quem está
-- cuidando) e "conclui" quando termina. Colaboradores com a restrição
-- "1 atendimento por vez" ligada não conseguem assumir uma segunda conversa
-- em modo fila enquanto ainda tiverem uma em aberto.

ALTER TABLE "internal_conversations"
  ADD COLUMN IF NOT EXISTS "queue_mode" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "active_handler_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "active_handler_since" timestamptz;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "internal_chat_single_task" boolean NOT NULL DEFAULT false;
