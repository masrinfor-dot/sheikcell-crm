-- Link do vendedor (Gerente IA): identifica quem é, pra ele poder agir na tarefa dele.
ALTER TABLE gerente_links ADD COLUMN IF NOT EXISTS user_id integer;
