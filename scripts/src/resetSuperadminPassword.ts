/**
 * Recuperação de acesso do Super Admin (item da MISSÃO — "Recuperar Super
 * Admin"). Não existe hoje nenhum jeito de resetar a senha do Super Admin
 * pelo próprio sistema: o "Esqueci minha senha" (routes/auth.ts) manda
 * e-mail via Resend, e RESEND_API_KEY/EMAIL_FROM nem aparecem documentados
 * em deploy/.env.example — ou seja, é bem provável que essa etapa esteja
 * silenciosamente sem efeito em produção (o endpoint sempre responde "ok"
 * mesmo se o envio falhar, de propósito, pra não vazar quais e-mails
 * existem — mas isso também esconde a falha de configuração de quem
 * está tentando recuperar o próprio acesso).
 *
 * Este script faz a MESMA coisa que o fluxo de reset via e-mail faria
 * (gera uma senha nova, grava o hash com bcrypt, força troca no próximo
 * login) só que rodado localmente contra o Postgres de produção — sem
 * tocar em nenhuma outra coluna, sem apagar nada, sem editar SQL à mão.
 *
 * Uso:
 *   DATABASE_URL="postgres://...produção..." \
 *   pnpm --filter @workspace/scripts run reset-superadmin-password -- seu-email@exemplo.com
 *
 * O script SÓ atua em contas com role = 'superadmin'. Se o e-mail não for
 * encontrado como superadmin, ele lista (só e-mail + status ativo/inativo,
 * nunca a senha) quem existe com essa role, pra ajudar a achar o e-mail
 * certo.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("ERRO: variável de ambiente DATABASE_URL não definida.");
  console.error("Aponte para o Postgres de produção (a mesma connection string do EasyPanel), não para o banco local de dev.");
  process.exit(1);
}

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Uso: pnpm --filter @workspace/scripts run reset-superadmin-password -- email@do-superadmin.com");
  process.exit(1);
}

// Espelho mínimo de usersTable (lib/db/src/schema/users.ts) — só as colunas
// que este script realmente lê/grava, pra não precisar do build do pacote @workspace/db.
const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  isActive: boolean("is_active").notNull(),
  mustChangePassword: boolean("must_change_password").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

function generateTempPassword(): string {
  // 12 bytes = 16 chars em base64url, sem caracteres ambíguos de URL (+/=).
  return randomBytes(12).toString("base64url");
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: { usersTable } });

  try {
    const { eq, and } = await import("drizzle-orm");
    const [target] = await db.select().from(usersTable)
      .where(and(eq(usersTable.email, email!), eq(usersTable.role, "superadmin")));

    if (!target) {
      console.error(`Nenhuma conta com role "superadmin" e e-mail "${email}" foi encontrada.`);
      const others = await db.select({ email: usersTable.email, isActive: usersTable.isActive })
        .from(usersTable).where(eq(usersTable.role, "superadmin"));
      if (others.length === 0) {
        console.error("Não existe NENHUMA conta com role \"superadmin\" no banco — o registro pode ter perdido a role, não só a senha.");
      } else {
        console.error("Contas com role \"superadmin\" existentes no banco:");
        for (const o of others) console.error(`  - ${o.email} (${o.isActive ? "ativa" : "INATIVA"})`);
      }
      process.exit(1);
    }

    console.log(`Conta encontrada: ${target.name} <${target.email}> — ativa: ${target.isActive ? "sim" : "NÃO (será reativada)"}`);

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await db.update(usersTable)
      .set({ passwordHash, mustChangePassword: true, isActive: true, updatedAt: new Date() })
      .where(eq(usersTable.id, target.id));

    console.log("\nSenha redefinida com sucesso.");
    console.log(`Senha temporária (use só uma vez, o sistema vai pedir troca no primeiro login):\n\n  ${tempPassword}\n`);
    console.log("Guarde/anote agora — ela não fica salva em nenhum lugar e não será mostrada de novo.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Falha ao resetar a senha:", err);
  process.exit(1);
});
