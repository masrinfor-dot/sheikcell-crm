import { pgTable, serial, text, integer, timestamp, boolean, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";

export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  channel: text("channel").notNull().default("whatsapp"), // whatsapp | instagram | manual
  sessionKey: text("session_key").notNull().default("default"), // qual conexão de WhatsApp recebeu a conversa
  sectorId: integer("sector_id").references(() => sectorsTable.id),
  assigneeId: integer("assignee_id").references(() => usersTable.id),
  status: text("status").notNull().default("open"), // open | pending | resolved | archived
  labels: text("labels"), // comma-separated
  unreadCount: integer("unread_count").notNull().default(0),
  lastMessage: text("last_message"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationParticipantsTable = pgTable(
  "conversation_participants",
  {
    conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id),
    content: text("content").notNull(),
    direction: text("direction").notNull().default("inbound"), // inbound | outbound
    type: text("type").notNull().default("text"), // text | image | audio | doc | system
    status: text("status").notNull().default("sent"), // sent | delivered | read | failed
    senderName: text("sender_name"),
    mediaUrl: text("media_url"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Garante no banco que a MESMA mensagem recebida (mesmo ID do WhatsApp)
  // nunca é gravada duas vezes, mesmo com webhooks simultâneos.
  (t) => [
    uniqueIndex("messages_external_id_inbound_uniq")
      .on(t.externalId)
      .where(sql`${t.direction} = 'inbound' AND ${t.externalId} IS NOT NULL`),
  ],
);
