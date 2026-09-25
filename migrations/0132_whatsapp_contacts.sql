-- Agenda de Contatos do WhatsApp (pedido 25/09 — fase 1 de "puxar histórico
-- de conversa e contatos igual o WhatsApp Web"): guarda os contatos salvos em
-- cada linha de WhatsApp, sincronizados via Baileys. Não é CRM (crm_contacts
-- continua sendo o cadastro de cliente/atendimento) — é o catálogo bruto da
-- agenda de cada número, pra consulta/busca.
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  id SERIAL PRIMARY KEY,
  session_key TEXT NOT NULL,
  jid TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  push_name TEXT,
  verified_name TEXT,
  avatar_url TEXT,
  is_business BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_contacts_tenant_session_jid_uniq
  ON whatsapp_contacts (tenant_id, session_key, jid);

CREATE INDEX IF NOT EXISTS whatsapp_contacts_tenant_phone_idx
  ON whatsapp_contacts (tenant_id, phone);
