-- Diretório interno de contatos: ramal opcional por usuário + favoritos
-- (por quem favoritou, individual — mesmo padrão de conversation_pins).
ALTER TABLE users ADD COLUMN IF NOT EXISTS extension text;

CREATE TABLE IF NOT EXISTS team_favorites (
  tenant_id integer NOT NULL DEFAULT 1,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorited_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorited_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, favorited_user_id)
);
