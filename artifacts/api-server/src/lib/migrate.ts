import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Migrações SQL idempotentes aplicadas no boot, ANTES do seed e de aceitar
// tráfego dependente do novo schema. Fonte: migrations/*.sql na raiz do repo
// (copiadas para a imagem no deploy). Cada arquivo é idempotente (IF NOT
// EXISTS / DO $$ guards), então re-executar a cada boot é seguro.
//
// Lista de arquivos DESCOBERTA automaticamente (não mais hardcoded aqui):
// antes disso, cada migração nova precisava ser adicionada manualmente a um
// array nesse arquivo — e foi exatamente esquecer esse passo (migração
// 0106_conversation_priority.sql criada mas nunca incluída na lista) que
// causou a queda de produção de 11/09 ("atendimentos sumiram"): a coluna
// "priority" nunca era criada porque o arquivo simplesmente nunca rodava,
// e todo select() completo em conversations passou a falhar com "column
// priority does not exist". Descobrir os arquivos por leitura do diretório
// (ordenados pelo prefixo numérico, que já é zero-padded) elimina essa
// classe de bug pra sempre — todo *.sql novo em migrations/ passa a rodar
// automaticamente no próximo boot, sem precisar tocar neste arquivo.
const FIRST_MIGRATION_FILE = "0001_multi_tenant.sql";

function findMigrationsDir(): string | null {
  for (const c of [
    resolve(process.cwd(), "migrations"),
    resolve(process.cwd(), "../../migrations"),
    resolve(import.meta.dirname ?? __dirname, "../../../../migrations"),
  ]) {
    try {
      readFileSync(resolve(c, FIRST_MIGRATION_FILE), "utf8");
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
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = readFileSync(resolve(dir, file), "utf8");
    await db.execute(sql.raw(text));
    logger.info({ file }, "Migration applied (idempotent)");
  }
}
