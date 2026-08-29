-- Banco de Promoções: galeria de fotos/materiais prontos pra reenvio rápido
-- no Atendimento (WhatsApp) — só admin/supervisor cadastra, qualquer
-- vendedor com o módulo liberado pode ver e enviar pro cliente.
CREATE TABLE IF NOT EXISTS promo_items (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  title text NOT NULL,
  stored_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promo_items_tenant_idx ON promo_items(tenant_id);

-- Módulo novo: libera por padrão pras lojas já existentes (mesma filosofia
-- da migration 0051 — vitrine).
UPDATE tenants
SET enabled_modules = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(enabled_modules || '["promocoes"]'::jsonb) AS elem
)
WHERE NOT (enabled_modules ?& array['promocoes']);
