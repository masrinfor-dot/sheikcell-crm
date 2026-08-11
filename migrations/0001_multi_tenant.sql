-- Multi-loja (SaaS): migração idempotente aplicada no boot do api-server
-- (também pode ser rodada manualmente com psql em produção ANTES do deploy).
-- Ordem: 1) tabela tenants + loja 1  2) tenant_id em todas as tabelas
-- (backfill = 1, a loja original)  3) chaves/índices compostos por loja.

BEGIN;

-- 1) Lojas (tenants). A loja 1 é a Sheikcell original (dona dos dados atuais).
CREATE TABLE IF NOT EXISTS tenants (
  id serial PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenants (id, name, is_active)
  SELECT 1, 'Sheikcell', true
  WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = 1);
SELECT setval('tenants_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM tenants), 1));

-- 2) tenant_id em todo dado operacional. DEFAULT 1 faz o backfill dos dados
-- existentes para a loja original; NOT NULL garante fail-closed daqui em diante.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','sectors','conversations','attendance_logs','access_logs',
    'crm_contacts','crm_custom_fields','tasks','quick_replies',
    'scheduled_messages','whatsapp_sessions','app_settings','bot_settings',
    'bot_states','chat_labels','checklists','documents','film_compat',
    'internal_conversations','partner_links','queue_entries','raffles',
    'rh_candidates','rh_settings','routing_rules','sheet_links','stores',
    'trade_in_evaluations','trainings'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1', t);
    END IF;
  END LOOP;
END $$;

-- 2b) tenant_id também nas tabelas FILHAS (dupla defesa: mesmo que uma rota
-- futura esqueça o join com o pai, o dado carrega a própria loja). Backfill
-- vem do registro pai; default 1 cobre linhas órfãs pré-multi-loja.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('messages',                      'conversations',          'conversation_id'),
    ('conversation_participants',     'conversations',          'conversation_id'),
    ('conversation_pins',             'conversations',          'conversation_id'),
    ('checklist_responses',           'checklists',             'checklist_id'),
    ('crm_purchases',                 'crm_contacts',           'contact_id'),
    ('crm_internal_notes',            'crm_contacts',           'contact_id'),
    ('task_comments',                 'tasks',                  'task_id'),
    ('task_subtasks',                 'tasks',                  'task_id'),
    ('internal_conversation_members', 'internal_conversations', 'conversation_id'),
    ('internal_messages',             'internal_conversations', 'conversation_id'),
    ('raffle_draws',                  'raffles',                'raffle_id'),
    ('training_completions',          'trainings',              'training_id')
  ) AS v(child, parent, fk) LOOP
    IF to_regclass(r.child) IS NOT NULL AND to_regclass(r.parent) IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = r.child AND column_name = 'tenant_id'
      ) THEN
        EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id integer NOT NULL DEFAULT 1', r.child);
        EXECUTE format(
          'UPDATE %I c SET tenant_id = p.tenant_id FROM %I p WHERE p.id = c.%I AND c.tenant_id <> p.tenant_id',
          r.child, r.parent, r.fk);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 3a) app_settings: PK precisa ser (tenant_id, key) — configurações por loja.
-- Bug corrigido aqui: a versão anterior só agia quando pk_cols = 1 (PK antiga
-- de 1 coluna), tratando pk_cols = 0 (SEM NENHUMA PK — visto em produção,
-- causa do "Erro ao salvar" ao mexer em Configurações do Atendimento, com
-- ON CONFLICT (tenant_id, key) falhando por não achar a constraint) como se
-- já estivesse migrado. Agora cobre os três estados possíveis: sem PK nenhuma,
-- PK antiga de 1 coluna, ou já migrada — e por ser idempotente, também
-- AUTO-CORRIGE se a constraint sumir de novo por qualquer outro motivo.
DO $$
DECLARE pk_name text;
DECLARE pk_is_composite boolean;
BEGIN
  SELECT c.constraint_name INTO pk_name
    FROM information_schema.table_constraints c
   WHERE c.table_name = 'app_settings' AND c.constraint_type = 'PRIMARY KEY';

  SELECT count(*) = 2 INTO pk_is_composite
    FROM information_schema.key_column_usage k
   WHERE k.table_name = 'app_settings' AND k.constraint_name = pk_name
     AND k.column_name IN ('tenant_id', 'key');

  IF pk_name IS NOT NULL AND NOT pk_is_composite THEN
    EXECUTE format('ALTER TABLE app_settings DROP CONSTRAINT %I', pk_name);
    pk_name := NULL;
  END IF;

  IF pk_name IS NULL THEN
    ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);
  END IF;

  -- Trava de segurança: se por qualquer motivo ainda não ficou correta,
  -- derruba o boot em vez de seguir em silêncio (mesma filosofia fail-loud
  -- do restante da migração) — é exatamente esse silêncio que manteve
  -- produção sem PK nenhuma por quem sabe quanto tempo sem ninguém notar.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app_settings'::regclass AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id, key)'
  ) THEN
    RAISE EXCEPTION 'app_settings sem PRIMARY KEY (tenant_id, key) após a migração 0001 — investigar antes de seguir';
  END IF;
END $$;

-- 3b) Sala geral do chat interno: única POR LOJA (antes era global).
DROP INDEX IF EXISTS internal_conversations_general_unique;
CREATE UNIQUE INDEX IF NOT EXISTS internal_conversations_general_by_tenant_unique
  ON internal_conversations (tenant_id, kind) WHERE kind = 'general';

-- 3c) Índices de filtro por loja nas tabelas mais consultadas.
CREATE INDEX IF NOT EXISTS conversations_tenant_idx ON conversations (tenant_id);
CREATE INDEX IF NOT EXISTS attendance_logs_tenant_idx ON attendance_logs (tenant_id);
CREATE INDEX IF NOT EXISTS crm_contacts_tenant_idx ON crm_contacts (tenant_id);
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

COMMIT;
