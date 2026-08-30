-- Módulos opcionais habilitados por SETOR (item 1h do backlog): setores que
-- só fazem comunicação interna não precisam de Atendimento nem de outras
-- funções do sistema. Um admin pode restringir, por setor, quais módulos
-- aparecem — sem coluna nova em outra tabela, só esta.
--
-- NULL (padrão, todo setor já existente) = sem restrição adicional: continua
-- exatamente como está hoje, valendo só o teto da loja (tenants.enabled_modules)
-- e o grant por usuário (users.module_access). Nenhuma conta perde acesso
-- por causa desta migração.
ALTER TABLE sectors ADD COLUMN IF NOT EXISTS enabled_modules jsonb;
