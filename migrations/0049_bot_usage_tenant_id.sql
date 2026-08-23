-- bot_usage ficou pra trás de uma migração de multi-tenant antiga: a tabela
-- em produção não tinha tenant_id nem chave primária nenhuma (bot.ts define
-- tenant_id + PK composta (tenant_id, day) há tempos, mas isso nunca chegou
-- no banco real — drizzle-kit push não aplicou essa mudança sozinho).
-- Toda leitura/escrita de contagem diária de IA (GET /bot/settings e o
-- controle de custo do robô) quebrava com "column tenant_id does not exist".
-- Tabela estava vazia em produção — sem risco de dado a migrar.

ALTER TABLE bot_usage ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bot_usage' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE bot_usage ADD PRIMARY KEY (tenant_id, day);
  END IF;
END $$;
