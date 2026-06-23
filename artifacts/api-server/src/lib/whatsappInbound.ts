import { db, conversationsTable, messagesTable, sectorsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { classifyText } from "./autoRouter";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

export const MEDIA_DIR = path.resolve(process.cwd(), "media");

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB

const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface InboundWAPayload {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string };
      audioMessage?: { caption?: string };
      documentMessage?: { caption?: string; fileName?: string };
    };
    pushName?: string;
    messageTimestamp?: number;
    mediaBase64?: string;
    mediaMimeType?: string;
    mediaType?: "image" | "audio" | "doc";
  };
  phone?: string;
  text?: { message?: string };
  senderName?: string;
  messageId?: string;
  isGroupMsg?: boolean;
  fromMe?: boolean;
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "application/pdf": "pdf",
  };
  return map[mime] ?? mime.split("/")[1] ?? "bin";
}

async function saveMedia(
  base64: string,
  mime: string,
): Promise<string> {
  if (!ALLOWED_MIMES.has(mime)) {
    throw new Error(`Unsupported media MIME type: ${mime}`);
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`Media file too large: ${buf.byteLength} bytes (max ${MAX_MEDIA_BYTES})`);
  }
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = mimeToExt(mime);
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(MEDIA_DIR, filename), buf);
  return `/api/chat/media/${filename}`;
}

export async function processInboundWA(body: InboundWAPayload): Promise<void> {
  const fromMe = body.data?.key?.fromMe ?? body.fromMe ?? false;
  const isGroup = body.isGroupMsg ?? (body.data?.key?.remoteJid?.includes("@g.us") ?? false);
  if (fromMe || isGroup) return;

  const remoteJid =
    body.data?.key?.remoteJid ?? (body.phone ? `${body.phone}@s.whatsapp.net` : null);
  const phone = remoteJid?.replace("@s.whatsapp.net", "").replace("@c.us", "") ?? "unknown";
  const pushName = body.data?.pushName ?? body.senderName ?? phone;

  const mediaType = body.data?.mediaType ?? null;
  const mediaBase64 = body.data?.mediaBase64 ?? null;
  const mediaMimeType = body.data?.mediaMimeType ?? null;

  const text =
    body.data?.message?.conversation ??
    body.data?.message?.extendedTextMessage?.text ??
    body.data?.message?.imageMessage?.caption ??
    body.data?.message?.audioMessage?.caption ??
    body.data?.message?.documentMessage?.caption ??
    body.text?.message ??
    "";

  const externalId = body.data?.key?.id ?? body.messageId ?? null;

  let mediaUrl: string | null = null;
  if (mediaBase64 && mediaMimeType) {
    try {
      mediaUrl = await saveMedia(mediaBase64, mediaMimeType);
    } catch {
      mediaUrl = null;
    }
  }

  const msgType: string = mediaType ?? "text";
  const docFileName = body.data?.message?.documentMessage?.fileName ?? null;

  const displayContent = text || (mediaType === "image" ? "📷 Foto" : mediaType === "audio" ? "🎵 Áudio" : mediaType === "doc" ? `📄 ${docFileName ?? "Documento"}` : "(mídia)");

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
        lastMessage: displayContent,
        lastMessageAt: new Date(),
        unreadCount: 1,
      })
      .returning();
    broadcast("conversation_new", conv);
  } else {
    await db
      .update(conversationsTable)
      .set({
        lastMessage: displayContent,
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
      content: displayContent,
      direction: "inbound",
      type: msgType,
      status: "delivered",
      senderName: pushName,
      externalId,
      mediaUrl,
    })
    .returning();

  broadcast("message", { conversationId: conv.id, message: msg });
}
