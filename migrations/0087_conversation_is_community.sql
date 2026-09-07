-- Diferencia Comunidade do WhatsApp (ou o canal de avisos dela) de Grupo
-- comum na Central de Atendimento. Baileys usa o mesmo tipo de JID (@g.us)
-- pros dois; a ponte do WhatsApp agora resolve isso pelo metadata do grupo
-- (isCommunity/isCommunityAnnounce) e manda a flag no webhook. Idempotente.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_community boolean NOT NULL DEFAULT false;
