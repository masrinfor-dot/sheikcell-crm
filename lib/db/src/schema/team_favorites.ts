import { pgTable, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Diretório interno de contatos: colega marcado como favorito — por usuário,
// cada um tem os próprios (mesmo padrão de conversation_pins).
export const teamFavoritesTable = pgTable(
  "team_favorites",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    favoritedUserId: integer("favorited_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    favoritedAt: timestamp("favorited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.favoritedUserId] })],
);
