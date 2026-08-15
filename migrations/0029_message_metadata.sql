-- Guarda extras que não cabem nas colunas fixas de mensagem: nome/tamanho
-- real de documento (o mediaUrl salvo em disco usa nome aleatório) e preview
-- de link (OG tags) buscado sob demanda pra mensagens de texto com URL.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS metadata jsonb;
