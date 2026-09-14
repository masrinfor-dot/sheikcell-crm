-- Snapshot de conversations.origin em cada attendance_logs — permite filtrar
-- o relatório detalhado de atendimentos por "iniciado manualmente x vindo da
-- fila" sem depender da conversa (que pode já ter sido arquivada/excluída).
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS origin text;
