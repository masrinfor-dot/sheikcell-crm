-- Aprendizado do robô com atendimentos humanos (pedido 16/09: "ultilizar as
-- mesagens de cliente para apreder e melhorar a comunicação... cada
-- antedimento finalizar a ia fazer uma analise do antediento humano e
-- sugeria melhorar na base de conhecimento"): ao finalizar um atendimento
-- que passou por um humano, a IA analisa a conversa e grava uma sugestão de
-- melhoria pra base de conhecimento aqui. O admin aprova (mescla na base via
-- IA) ou rejeita — nunca entra na base sozinho.
CREATE TABLE IF NOT EXISTS kb_suggestions (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  conversation_id integer,
  suggestion text NOT NULL,
  reasoning text,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by integer,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_suggestions_tenant_status_idx ON kb_suggestions (tenant_id, status);

-- Liga/desliga a geração automática de sugestões (botão "Aprender com
-- atendimentos" na tela do Robô) — começa ligado por padrão, o admin desliga
-- manualmente quando achar a base madura o suficiente.
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS learning_enabled boolean NOT NULL DEFAULT true;
