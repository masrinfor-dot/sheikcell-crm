-- Filtros salvos da lista de Conversas (pedido 10/09: "criar opção de
-- separar mensagem de forma pré configurada") — combinação de
-- vendedor/setor/nível/linha/etiqueta/"não respondidas" salva com um nome,
-- pessoal por usuário. Idempotente.
CREATE TABLE IF NOT EXISTS chat_saved_filters (
  tenant_id integer NOT NULL DEFAULT 1,
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_saved_filters_user_idx ON chat_saved_filters(user_id);
