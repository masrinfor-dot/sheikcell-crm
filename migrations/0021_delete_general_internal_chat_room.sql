-- Permite ao admin excluir permanentemente a sala "Equipe (Geral)" do chat
-- interno. Sem essa flag, ensureGeneralRoom() (rodada em todo GET
-- /internal-chat/conversations) recriaria uma sala vazia assim que qualquer
-- membro da equipe abrisse o chat de novo.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS internal_chat_general_disabled boolean NOT NULL DEFAULT false;
