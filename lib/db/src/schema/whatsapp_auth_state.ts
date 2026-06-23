import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const whatsappAuthStateTable = pgTable(
  "whatsapp_auth_state",
  {
    sessionKey: text("session_key").notNull(),
    dataKey: text("data_key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionKey, t.dataKey] })],
);
