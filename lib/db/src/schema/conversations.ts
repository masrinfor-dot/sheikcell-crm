import { pgTable, serial, text, integer, timestamp, boolean, primaryKey, uniqueIndex, jsonb, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sectorsTable } from "./sectors";
import { usersTable } from "./users";
import { storesTable } from "./stores";

// Extras que não cabem nas colunas fixas de mensagem — hoje cobre nome/tamanho
// real de documento (o mediaUrl salvo usa nome aleatório) e o preview de link
// (OG tags) buscado sob demanda pra mensagens de texto com URL. Ambos os usos
// são opcionais e cacheados aqui pra não precisar refazer o parsing/fetch a
// cada exibição. Compartilhado com internal_messages (mesma forma, chats
// diferentes).
export type MessageMetadata = {
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  linkPreview?: {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  } | null;
};

export const conversationsTable = pgTable("conversations", {
  tenantId: integer("tenant_id").notNull().default(1),
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
  // "inbound" = cliente falou por último (não respondida); "outbound" = já respondida.
  lastMessageDirection: text("last_message_direction"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  // Momento em que um vendedor assumiu o atendimento (assigneeId saiu de null).
  // Limpo quando a conversa volta para a fila/potenciais (perde o responsável).
  attendanceStartedAt: timestamp("attendance_started_at", { withTimezone: true }),
  // Loja de quem está (ou esteve por último) com o atendimento — snapshot no
  // momento da atribuição (mesmo padrão de surveyScaleMax abaixo), nunca um
  // JOIN ao vivo em users.store_name (texto livre). Ao contrário de
  // attendanceStartedAt, NÃO é zerado ao perder o responsável — mantém a
  // última loja conhecida, pra relatório de "não resolvidos" ainda conseguir
  // localizar a loja mesmo sem atendente atual.
  storeId: integer("store_id").references(() => storesTable.id),
  // Pesquisa de satisfação: aponta o attendance_log aguardando a nota do
  // cliente (setado quando a pesquisa foi enviada; limpo na primeira resposta).
  pendingSurveyLogId: integer("pending_survey_log_id"),
  surveySentAt: timestamp("survey_sent_at", { withTimezone: true }),
  // Retrato da configuração NO MOMENTO do envio da pesquisa: mudar a escala,
  // o prazo ou o cupom depois não muda as pesquisas já enviadas.
  surveyScaleMax: integer("survey_scale_max"),
  surveyWindowHours: integer("survey_window_hours"),
  surveyRewardText: text("survey_reward_text"),
  // Lembrete único da pesquisa: marcado quando o lembrete foi enviado (ou
  // reivindicado pelo agendador). Nunca é enviado mais de um por atendimento.
  surveyReminderSentAt: timestamp("survey_reminder_sent_at", { withTimezone: true }),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationParticipantsTable = pgTable(
  "conversation_participants",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

// Conversas fixadas — por usuário: cada um fixa as suas, sem afetar os colegas.
export const conversationPinsTable = pgTable(
  "conversation_pins",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

// Mensagens fixadas — compartilhado (como o "fixar" do WhatsApp): qualquer
// participante fixa/desafixa e todo mundo na conversa vê o destaque no topo.
// Diferente de conversationPinsTable acima, que é por usuário.
export const messagePinsTable = pgTable("message_pins", {
  tenantId: integer("tenant_id").notNull().default(1),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  messageId: integer("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }).primaryKey(),
  pinnedBy: integer("pinned_by").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messagesTable = pgTable(
  "messages",
  {
    tenantId: integer("tenant_id").notNull().default(1),
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id),
    content: text("content").notNull(),
    direction: text("direction").notNull().default("inbound"), // inbound | outbound
    // text | image | audio | video | doc | sticker | contact | location | poll
    // | product | payment | group_invite | note | system
    type: text("type").notNull().default("text"),
    status: text("status").notNull().default("sent"), // sent | delivered | read | failed
    senderName: text("sender_name"),
    // Telefone de quem mandou DENTRO de um grupo do WhatsApp (participante),
    // extraído do key.participant do Baileys — diferente do "phone" da
    // conversa (que é o JID do grupo). Permite abrir uma conversa 1:1 com
    // aquele participante a partir do balão. Sempre null fora de grupo.
    senderPhone: text("sender_phone"),
    mediaUrl: text("media_url"),
    // Transcrição do áudio (Whisper) — preenchida sob demanda ou pelo robô.
    transcript: text("transcript"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Preenchido quando o cliente edita a mensagem original no WhatsApp
    // (o conteúdo já foi sobrescrito com o texto novo).
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // Preenchido quando o cliente apaga a mensagem original no WhatsApp
    // ("apagar para todos" — protocolMessage REVOKE). O conteúdo é
    // sobrescrito com um texto de placeholder, como no WhatsApp oficial.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Reações de emoji do WhatsApp (cliente reagindo a esta mensagem).
    // Uma entrada por remetente — reenviar com o mesmo emoji atualiza, texto
    // vazio remove (comportamento nativo do WhatsApp).
    reactions: jsonb("reactions").$type<Array<{ emoji: string; senderName: string | null }>>().notNull().default([]),
    // Responder mensagem (estilo WhatsApp): aponta a mensagem citada, na MESMA
    // conversa. FK fora de linha porque a tabela referencia a própria id.
    replyToId: integer("reply_to_id"),
    metadata: jsonb("metadata").$type<MessageMetadata>(),
  },
  // Garante no banco que a MESMA mensagem recebida (mesmo ID do WhatsApp)
  // nunca é gravada duas vezes, mesmo com webhooks simultâneos.
  (t) => [
    uniqueIndex("messages_external_id_inbound_uniq")
      .on(t.externalId)
      .where(sql`${t.direction} = 'inbound' AND ${t.externalId} IS NOT NULL`),
    foreignKey({ columns: [t.replyToId], foreignColumns: [t.id], name: "messages_reply_to_id_fk" }).onDelete("set null"),
  ],
);
