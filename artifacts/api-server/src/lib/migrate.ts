import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Migrações SQL idempotentes aplicadas no boot, ANTES do seed e de aceitar
// tráfego dependente do novo schema. Fonte: migrations/*.sql na raiz do repo
// (copiadas para a imagem no deploy). Cada arquivo é idempotente (IF NOT
// EXISTS / DO $$ guards), então re-executar a cada boot é seguro.
const MIGRATION_FILES = ["0001_multi_tenant.sql", "0002_saas_owner_panel.sql", "0003_audio_transcript.sql", "0004_chat_notifications.sql", "0005_meetings.sql", "0006_survey_reminder.sql", "0007_sheet_link_access.sql", "0008_finance_bank.sql", "0009_finance_audit_log.sql", "0010_system_board.sql", "0011_message_reactions_edits.sql", "0012_message_reply.sql", "0013_task_comments_media_notifications.sql", "0014_team_directory.sql", "0015_support_tickets.sql", "0016_tenant_modules_cpf_cnpj.sql", "0017_password_reset_tokens.sql", "0018_internal_chat_reply_media.sql", "0019_remove_peliculas_planilhas_financeiro_bancario.sql"] as const;

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
