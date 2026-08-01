import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Migrações SQL idempotentes aplicadas no boot, ANTES do seed e de aceitar
// tráfego dependente do novo schema. Fonte: migrations/*.sql na raiz do repo
// (copiadas para a imagem no deploy). Cada arquivo é idempotente (IF NOT
// EXISTS / DO $$ guards), então re-executar a cada boot é seguro.
const MIGRATION_FILES = ["0001_multi_tenant.sql", "0002_saas_owner_panel.sql"] as const;

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
