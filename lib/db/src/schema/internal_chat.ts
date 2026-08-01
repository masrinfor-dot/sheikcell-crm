import { pgTable, serial, text, integer, timestamp, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Internal team chat — communication between admins, supervisors and vendedores.
// Separate from the customer-facing "conversations" (Central de Atendimento).

export const internalConversationsTable = pgTable(
  "internal_conversations",
  {
  tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    kind: text("kind").notNull().default("direct"), // direct | general
    name: text("name"), // used for the general/team room
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Guarantee at most one shared general/team room, even under concurrent creation.
  // No máximo UMA sala geral por loja (tenant), mesmo sob criação concorrente.
  (t) => [uniqueIndex("internal_conversations_general_by_tenant_unique").on(t.tenantId, t.kind).where(sql`${t.kind} = 'general'`)],
);

export const internalConversationMembersTable = pgTable(
  "internal_conversation_members",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    conversationId: integer("conversation_id").notNull().references(() => internalConversationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const internalMessagesTable = pgTable("internal_messages", {
  tenantId: integer("tenant_id").notNull().default(1),
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => internalConversationsTable.id, { onDelete: "cascade" }),
  senderId: integer("sender_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
