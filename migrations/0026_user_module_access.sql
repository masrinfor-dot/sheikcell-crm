-- Substitui admin_access (6 chaves) + as chaves de "aba inteira" que viviam
-- soltas dentro de permissions (crm, tarefas, equipe, financeiras,
-- avaliacao, treinamentos) por um único campo module_access, com o mesmo
-- vocabulário de módulo já usado em tenants.enabled_modules. Sem este
-- backfill, todo vendedor/supervisor já cadastrado perderia essas abas no
-- dia em que o enforcement novo (requireModuleAccess) entrar no ar — o
-- campo novo nasce vazio (null) por padrão, e módulo ausente = sem acesso.
ALTER TABLE users ADD COLUMN IF NOT EXISTS module_access jsonb;

UPDATE users u
SET module_access = (
  SELECT jsonb_object_agg(m.k, 'edit')
  FROM (
    VALUES
      -- Diretório, Resultados, Histórico e Documentos nunca tiveram gate
      -- por usuário (só por loja) — todo vendedor/supervisor já os via.
      ('diretorio'), ('resultados'), ('history'), ('documentos'),
      -- Vinham de admin_access (fail closed — precisava estar no array).
      ('financeiro'), ('sorteios'), ('robo'), ('rh'), ('questionarios'),
      -- Vinham de permissions (fail open — ausência ou != false = liberado).
      ('crm'), ('tarefas'), ('equipe'), ('financeiras'), ('avaliacao'), ('treinamentos')
  ) AS m(k)
  WHERE
    m.k IN ('diretorio', 'resultados', 'history', 'documentos')
    OR (m.k IN ('financeiro', 'sorteios', 'robo', 'rh', 'questionarios') AND u.admin_access ? m.k)
    OR (
      m.k IN ('crm', 'tarefas', 'equipe', 'financeiras', 'avaliacao', 'treinamentos')
      AND COALESCE((u.permissions ->> m.k)::boolean, true) = true
    )
)
WHERE u.module_access IS NULL AND u.role IN ('vendedor', 'supervisor');
