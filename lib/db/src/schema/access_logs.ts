import { pgTable, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Registro de cada login no sistema — alimenta o painel "quem está online"
// e o histórico de horários de acesso de cada usuário.
export const accessLogsTable = pgTable("access_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  loggedInAt: timestamp("logged_in_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("access_logs_user_time_idx").on(t.userId, t.loggedInAt.desc()),
]);
