import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Migrações SQL idempotentes aplicadas no boot, ANTES do seed e de aceitar
// tráfego dependente do novo schema. Fonte: migrations/*.sql na raiz do repo
// (copiadas para a imagem no deploy). Cada arquivo é idempotente (IF NOT
// EXISTS / DO $$ guards), então re-executar a cada boot é seguro.
const MIGRATION_FILES = ["0001_multi_tenant.sql", "0002_saas_owner_panel.sql", "0003_audio_transcript.sql", "0004_chat_notifications.sql", "0005_meetings.sql", "0006_survey_reminder.sql", "0007_sheet_link_access.sql", "0008_finance_bank.sql", "0009_finance_audit_log.sql", "0010_system_board.sql", "0011_message_reactions_edits.sql", "0012_message_reply.sql", "0013_task_comments_media_notifications.sql", "0014_team_directory.sql", "0015_support_tickets.sql", "0016_tenant_modules_cpf_cnpj.sql", "0017_password_reset_tokens.sql", "0018_internal_chat_reply_media.sql", "0019_remove_peliculas_planilhas_financeiro_bancario.sql", "0020_user_whatsapp_session_access.sql", "0021_delete_general_internal_chat_room.sql", "0022_normalize_legacy_attendant_role.sql", "0023_message_deleted.sql", "0024_core_modules_backfill.sql", "0025_message_sender_phone.sql", "0026_user_module_access.sql", "0027_fix_stale_unread_resolved.sql", "0028_ticket_resolution_note.sql", "0029_message_metadata.sql", "0030_relatorios.sql", "0031_ai_credentials.sql", "0032_rh_dp.sql", "0033_rh_dp_flexible_shifts_closures.sql", "0034_task_multi_assignees.sql", "0035_conversation_last_message_sender.sql", "0036_tv_box.sql", "0037_trade_in_close_deal.sql", "0038_internal_chat_pin.sql", "0039_rotinas.sql", "0040_rotinas_responses.sql", "0041_rotinas_urgent_bypass.sql"] as const;

function findMigrationsDir(): string | null {
  for (const c of [
    resolve(process.cwd(), "migrations"),
    resolve(process.cwd(), "../../migrations"),
    resolve(import.meta.dirname ?? __dirname, "../../../../migrations"),
  ]) {
    try {
      readFileSync(resolve(c, MIGRATION_FILES[0]), "utf8");
      return c;
    } catch {
      /* tenta o próximo candidato */
    }
  }
  return null;
}

export async function runMigrations(): Promise<void> {
  const dir = findMigrationsDir();
  if (!dir) {
    // Fail loud: sem migração aplicada, o schema multi-loja pode estar ausente.
    throw new Error("Diretório migrations/ não encontrado — schema pode estar desatualizado");
  }
  for (const file of MIGRATION_FILES) {
    const text = readFileSync(resolve(dir, file), "utf8");
    await db.execute(sql.raw(text));
    logger.info({ file }, "Migration applied (idempotent)");
  }
}
