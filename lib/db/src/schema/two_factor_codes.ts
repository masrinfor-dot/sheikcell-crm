import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// 2FA por e-mail — só pro login de role "superadmin" (o papel mais
// sensível do sistema: enxerga/mexe em todas as lojas). Ver
// POST /auth/login (intercepta antes de abrir a sessão) e
// POST /auth/login/2fa (confirma o código). Guardamos só o hash do código,
// nunca o valor puro — mesmo padrão de password_reset_tokens.ts. Expira em
// 10 minutos, no máximo 5 tentativas erradas, uso único.
export const twoFactorCodesTable = pgTable(
  "two_factor_codes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("two_factor_codes_user_id_idx").on(t.userId)],
);

export type TwoFactorCode = typeof twoFactorCodesTable.$inferSelect;
