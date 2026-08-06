import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Fixa o fuso da sessão explicitamente: sem isso, date_trunc('month', ...) e
// afins dependem do timezone padrão do servidor Postgres (que em produção,
// diferente desta máquina de dev, pode vir em UTC e desalinhar "hoje"/"este
// mês" perto da virada de dia — sempre o horário do Brasil, nunca "o que o
// ambiente calhar de ter configurado".
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'America/Sao_Paulo'").catch(() => {});
});
export const db = drizzle(pool, { schema });

export * from "./schema";
