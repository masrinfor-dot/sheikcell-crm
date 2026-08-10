-- Recuperação de senha via e-mail: token de uso único com expiração curta.
-- Guardamos o HASH do token (não o valor bruto), mesmo padrão de senha —
-- se o banco vazar, ninguém consegue usar os links de reset ativos.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens(user_id);
