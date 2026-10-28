-- Gerente IA no chat interno do CRM.
ALTER TABLE gerente_settings ADD COLUMN IF NOT EXISTS internal_chat_enabled boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS gerente_chat_rooms (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  kind text NOT NULL,
  ref_id integer NOT NULL DEFAULT 0,
  conversation_id integer NOT NULL REFERENCES internal_conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_chat_rooms_uq ON gerente_chat_rooms(tenant_id, kind, ref_id);
CREATE INDEX IF NOT EXISTS gerente_chat_rooms_conv_idx ON gerente_chat_rooms(conversation_id);
