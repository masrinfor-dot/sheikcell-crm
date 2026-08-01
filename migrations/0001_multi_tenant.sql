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

-- 3a) app_settings: PK passa de (key) para (tenant_id, key) — configurações
-- por loja. Só migra se a PK antiga (1 coluna) ainda existir.
DO $$
DECLARE pk_cols int;
BEGIN
  SELECT count(*) INTO pk_cols
    FROM information_schema.key_column_usage k
    JOIN information_schema.table_constraints c
      ON c.constraint_name = k.constraint_name AND c.table_name = k.table_name
   WHERE c.table_name = 'app_settings' AND c.constraint_type = 'PRIMARY KEY';
  IF pk_cols = 1 THEN
    ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
    ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);
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
