import { pgTable, serial, text, integer, timestamp, primaryKey, uniqueIndex, boolean, foreignKey, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import type { MessageMetadata } from "./conversations";

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

export const internalMessagesTable = pgTable(
  "internal_messages",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id").notNull().references(() => internalConversationsTable.id, { onDelete: "cascade" }),
    senderId: integer("sender_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    type: text("type").notNull().default("text"), // text | image | audio | doc
    mediaUrl: text("media_url"),
    // Transcrição do áudio (Whisper) — preenchida sob demanda, como no chat de clientes.
    transcript: text("transcript"),
    // Encaminhada de outra conversa: o conteúdo/mídia já vem copiado (mensagem
    // independente), então a origem pode ser apagada sem quebrar o encaminhamento.
    forwarded: boolean("forwarded").notNull().default(false),
    // Responder mensagem (como o WhatsApp): aponta para a mensagem citada, sempre
    // na MESMA conversa (ver validação na rota). Coluna simples + FK via
    // foreignKey() abaixo (em vez de .references() em linha) para evitar
    // referência circular de tipos (a tabela citaria a si mesma na sua própria definição).
    replyToId: integer("reply_to_id"),
    metadata: jsonb("metadata").$type<MessageMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "set null" em vez de cascade: apagar a mensagem original não deve apagar
    // quem a citou, só perder a referência.
    foreignKey({ columns: [t.replyToId], foreignColumns: [t.id], name: "internal_messages_reply_to_id_fk" }).onDelete("set null"),
  ],
);
