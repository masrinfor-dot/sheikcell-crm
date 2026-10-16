-- WhatsApp de Compras e ADM (16/10/2026): puxar o histórico de conversas ao
-- conectar e cadastrar tudo direto em "Ativos" com um responsável fixo.
-- history_import_enabled: ao parear esta linha, o CRM grava as conversas
-- antigas que o celular envia (mensagens recebidas e enviadas, com a data
-- original), sem disparar robô, pesquisa nem notificação.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS history_import_enabled boolean NOT NULL DEFAULT false;
-- direct_assignee_id: conversa nova (ou reaberta) por esta linha entra direto
-- em "Ativos" com este usuário, sem passar por Potenciais/Pendentes/fila.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS direct_assignee_id integer REFERENCES users(id) ON DELETE SET NULL;
