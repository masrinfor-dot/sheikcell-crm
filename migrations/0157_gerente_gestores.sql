-- Gerente IA: 2º número com acesso (gestor) e agenda/lembretes por pessoa.
ALTER TABLE gerente_reminders ADD COLUMN IF NOT EXISTS member_phone text;
ALTER TABLE gerente_events ADD COLUMN IF NOT EXISTS member_phone text;
CREATE TABLE IF NOT EXISTS gerente_members (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  phone text NOT NULL,
  name text NOT NULL,
  user_id integer,
  role text NOT NULL DEFAULT 'gestor',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gerente_members_tenant_phone_uq ON gerente_members(tenant_id, phone);
