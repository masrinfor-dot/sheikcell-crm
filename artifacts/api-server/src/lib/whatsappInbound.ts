import { db, conversationsTable, messagesTable, sectorsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { classifyText } from "./autoRouter";

export interface InboundWAPayload {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string };
    };
    pushName?: string;
    messageTimestamp?: number;
  };
  phone?: string;
  text?: { message?: string };
  senderName?: string;
  messageId?: string;
  isGroupMsg?: boolean;
  fromMe?: boolean;
}

export async function processInboundWA(body: InboundWAPayload): Promise<void> {
  const fromMe = body.data?.key?.fromMe ?? body.fromMe ?? false;
  const isGroup = body.isGroupMsg ?? (body.data?.key?.remoteJid?.includes("@g.us") ?? false);
  if (fromMe || isGroup) return;

  const remoteJid =
    body.data?.key?.remoteJid ?? (body.phone ? `${body.phone}@s.whatsapp.net` : null);
  const phone = remoteJid?.replace("@s.whatsapp.net", "").replace("@c.us", "") ?? "unknown";
  const pushName = body.data?.pushName ?? body.senderName ?? phone;
  const text =
    body.data?.message?.conversation ??
    body.data?.message?.extendedTextMessage?.text ??
    body.data?.message?.imageMessage?.caption ??
    body.text?.message ??
    "";
  const externalId = body.data?.key?.id ?? body.messageId ?? null;

  let [conv] = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.phone, phone), eq(conversationsTable.isArchived, false)))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(1);

  if (!conv) {
    const classified = text ? await classifyText(text) : null;
    const [first] = await db
      .select()
      .from(sectorsTable)
      .where(eq(sectorsTable.isActive, true))
      .limit(1);
    const targetSectorId = classified?.sectorId ?? first?.id ?? 1;
    [conv] = await db
      .insert(conversationsTable)
      .values({
        phone,
        name: pushName,
        channel: "whatsapp",
        sectorId: targetSectorId,
        status: "open",
        lastMessage: text,
        lastMessageAt: new Date(),
        unreadCount: 1,
      })
      .returning();
    broadcast("conversation_new", conv);
  } else {
    await db
      .update(conversationsTable)
      .set({
        lastMessage: text,
        lastMessageAt: new Date(),
        unreadCount: sql`${conversationsTable.unreadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(conversationsTable.id, conv.id));
  }

  const [msg] = await db
    .insert(messagesTable)
    .values({
      conversationId: conv.id,
      content: text || "(mídia)",
      direction: "inbound",
      type: "text",
      status: "delivered",
      senderName: pushName,
      externalId,
    })
    .returning();

  broadcast("message", { conversationId: conv.id, message: msg });
}
