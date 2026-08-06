-- Quadro interno de desenvolvimento do sistema: problemas, atualizações e
-- implementações do sheikcell-crm em si (não é sobre o negócio do lojista).
-- Aba "Sistema (Dev)" no painel admin, liberável para devs via admin_access.
CREATE TABLE IF NOT EXISTS system_board_items (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  type text NOT NULL DEFAULT 'implementacao',    -- problema | atualizacao | implementacao
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'aberto',         -- aberto | andamento | concluido
  priority text NOT NULL DEFAULT 'media',        -- baixa | media | alta
  responsible_id integer REFERENCES users(id),
  created_by_id integer REFERENCES users(id),
  due_date timestamptz,
  position integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_board_items_tenant_idx ON system_board_items (tenant_id, is_archived);

CREATE TABLE IF NOT EXISTS system_board_comments (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  item_id integer NOT NULL REFERENCES system_board_items(id) ON DELETE CASCADE,
  author_id integer REFERENCES users(id) ON DELETE SET NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_board_comments_item_idx ON system_board_comments (item_id, created_at);
