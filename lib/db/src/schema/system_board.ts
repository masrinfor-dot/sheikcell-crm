import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Quadro interno de desenvolvimento do sistema (não é sobre o negócio do
// lojista, é sobre o próprio software). Onde o admin e os devs com acesso
// liberado registram problemas, atualizações e implementações do sheikcell-crm,
// com responsável e prazo — visível na aba "Sistema (Dev)" do painel admin.
export const systemBoardItemsTable = pgTable("system_board_items", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("implementacao"), // problema | atualizacao | implementacao
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("aberto"),     // aberto | andamento | concluido
  priority: text("priority").notNull().default("media"),  // baixa | media | alta
  responsibleId: integer("responsible_id").references(() => usersTable.id),
  createdById: integer("created_by_id").references(() => usersTable.id),
  dueDate: timestamp("due_date", { withTimezone: true }),
  position: integer("position").notNull().default(0),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Chat do item: comentários entre o admin e os devs para esclarecer o problema,
// dar andamento ou registrar como foi resolvido.
export const systemBoardCommentsTable = pgTable("system_board_comments", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => systemBoardItemsTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").references(() => usersTable.id, { onDelete: "set null" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
