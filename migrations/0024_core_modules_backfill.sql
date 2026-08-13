-- Chat, CRM, Chat Interno, Financeiro, Diretório, Tarefas, Resultados e
-- Histórico deixaram de ser "núcleo sempre ligado" e passaram a ser módulos
-- opcionais contratáveis por loja (mesmo mecanismo de enabled_modules que já
-- existia pra Avaliação/Financeiras/RH/etc.). Lojas criadas ANTES dessa
-- mudança têm enabled_modules sem essas 8 chaves novas — sem este backfill,
-- elas perderiam acesso a Atendimento/CRM/etc. da noite pro dia.
UPDATE tenants
SET enabled_modules = (
  SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
  FROM jsonb_array_elements_text(
    enabled_modules || '["chat","crm","equipe","financeiro","diretorio","tarefas","resultados","history"]'::jsonb
  ) AS elem
)
WHERE NOT (enabled_modules ?& array['chat','crm','equipe','financeiro','diretorio','tarefas','resultados','history']);
