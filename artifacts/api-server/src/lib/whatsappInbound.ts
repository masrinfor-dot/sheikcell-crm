import { db, conversationsTable, messagesTable, sectorsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation } from "./conversationScope";
import { classifyText } from "./autoRouter";
import { ensureCrmContactForConversation } from "./crmSync";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

export const MEDIA_DIR = path.resolve(process.cwd(), "media");

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/aac", "audio/amr", "audio/wav",
  "video/mp4", "video/3gpp", "video/webm", "video/quicktime",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface InboundWAMessageContent {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  audioMessage?: { caption?: string };
  documentMessage?: { caption?: string; fileName?: string };
  contactMessage?: { displayName?: string; vcard?: string };
  contactsArrayMessage?: { displayName?: string; contacts?: Array<{ displayName?: string; vcard?: string }> };
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string };
  stickerMessage?: object;
  // Wrappers used by disappearing/view-once chats — the real content is nested.
  ephemeralMessage?: { message?: InboundWAMessageContent };
  viewOnceMessage?: { message?: InboundWAMessageContent };
  viewOnceMessageV2?: { message?: InboundWAMessageContent };
}

export interface InboundWAPayload {
  event?: string;
  sessionKey?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: InboundWAMessageContent;
    pushName?: string;
    groupSubject?: string;
    messageTimestamp?: number;
    mediaBase64?: string;
    mediaMimeType?: string;
    mediaType?: "image" | "video" | "audio" | "doc";
    avatarUrl?: string;
  };
  phone?: string;
  text?: { message?: string };
  senderName?: string;
  messageId?: string;
  isGroupMsg?: boolean;
  fromMe?: boolean;
}

export interface MetaInboundWAPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
          image?: { id: string; mime_type: string; caption?: string; sha256?: string };
          video?: { id: string; mime_type: string; caption?: string };
          audio?: { id: string; mime_type: string };
          document?: { id: string; mime_type: string; filename?: string; caption?: string };
          sticker?: { id: string; mime_type: string };
        }>;
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
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
    // "weba" para áudio webm — a extensão "webm" fica reservada para vídeo,
    // assim o GET /chat/media devolve o Content-Type certo para cada um.
    "audio/webm": "weba",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
  };
  return map[mime] ?? mime.split("/")[1] ?? "bin";
}

async function saveMedia(
  base64: string,
  rawMime: string,
): Promise<string> {
  // WhatsApp envia tipos com parâmetros, ex. "audio/ogg; codecs=opus" —
  // normaliza para o tipo base antes de validar.
  const mime = rawMime.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) {
    throw new Error(`Unsupported media MIME type: ${rawMime}`);
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

async function downloadMetaMedia(
  mediaId: string,
  accessToken: string,
): Promise<{ base64: string; mime: string } | null> {
  try {
    const infoRes = await fetch(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!infoRes.ok) return null;
    const { url, mime_type } = (await infoRes.json()) as { url: string; mime_type: string };
    const mediaRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!mediaRes.ok) return null;
    const buf = Buffer.from(await mediaRes.arrayBuffer());
    return { base64: buf.toString("base64"), mime: mime_type };
  } catch {
    return null;
  }
}

async function upsertConversation(
  phone: string,
  pushName: string,
  displayContent: string,
  sessionKey: string = "default",
  avatarUrl?: string,
  // Grupos: mantém o nome da conversa sincronizado com o nome do grupo.
  syncName: boolean = false,
) {
  // Same customer talking to two different WhatsApp numbers = two separate
  // conversations, so replies always go out through the number the customer
  // contacted.
  let [conv] = await db
    .select()
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.phone, phone),
      eq(conversationsTable.sessionKey, sessionKey),
      eq(conversationsTable.isArchived, false),
    ))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(1);

  if (!conv) {
    const classified = displayContent ? await classifyText(displayContent) : null;
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
        avatarUrl: avatarUrl ?? null,
        channel: "whatsapp",
        sessionKey,
        sectorId: targetSectorId,
        status: "open",
        lastMessage: displayContent,
        lastMessageAt: new Date(),
        unreadCount: 1,
      })
      .returning();
    broadcast("conversation_new", conv, conv.sectorId, isPotentialConversation(conv));
    // Keep the CRM in sync with atendimentos: register the customer as soon as
    // the conversation starts, not only when it is resolved.
    await ensureCrmContactForConversation(conv);
  } else {
    // Se o atendimento já foi finalizado (resolvido/arquivado) e o cliente volta
    // a mandar mensagem, reabrimos a conversa para "Potenciais": status "open" e
    // sem responsável, para que volte à triagem.
    const reopen = conv.status === "resolved" || conv.status === "archived";
    const [updated] = await db
      .update(conversationsTable)
      .set({
        lastMessage: displayContent,
        lastMessageAt: new Date(),
        unreadCount: sql`${conversationsTable.unreadCount} + 1`,
        updatedAt: new Date(),
        ...(reopen ? { status: "open", assigneeId: null } : {}),
        ...(avatarUrl && avatarUrl !== conv.avatarUrl ? { avatarUrl } : {}),
        ...(syncName && pushName && pushName !== conv.name ? { name: pushName } : {}),
      })
      .where(eq(conversationsTable.id, conv.id))
      .returning();
    if (updated) conv = updated;
    if (reopen && updated) {
      broadcast("conversation_updated", updated, updated.sectorId, isPotentialConversation(updated));
    }
  }

  return conv;
}

export async function processInboundWA(body: InboundWAPayload): Promise<void> {
  const fromMe = body.data?.key?.fromMe ?? body.fromMe ?? false;
  if (fromMe) return;
  const isGroup = body.isGroupMsg ?? (body.data?.key?.remoteJid?.includes("@g.us") ?? false);

  const remoteJid =
    body.data?.key?.remoteJid ?? (body.phone ? `${body.phone}@s.whatsapp.net` : null);
  // Grupos/comunidades: o identificador da conversa é o JID completo do grupo
  // (não há telefone). Contatos 1:1 continuam usando só os dígitos.
  const phone = isGroup
    ? (remoteJid ?? "unknown")
    : remoteJid?.replace("@s.whatsapp.net", "").replace("@c.us", "") ?? "unknown";
  const pushName = body.data?.pushName ?? body.senderName ?? phone;
  // Nome da conversa: nome do grupo (subject) para grupos; nome do contato para 1:1.
  const convName = isGroup ? (body.data?.groupSubject || "Grupo do WhatsApp") : pushName;

  const mediaType = body.data?.mediaType ?? null;
  const mediaBase64 = body.data?.mediaBase64 ?? null;
  const mediaMimeType = body.data?.mediaMimeType ?? null;

  // Unwrap disappearing/view-once wrappers so nested content is not lost.
  const rawMsg = body.data?.message;
  const msgContent: InboundWAMessageContent | undefined =
    rawMsg?.ephemeralMessage?.message ??
    rawMsg?.viewOnceMessage?.message ??
    rawMsg?.viewOnceMessageV2?.message ??
    rawMsg;

  const text =
    msgContent?.conversation ??
    msgContent?.extendedTextMessage?.text ??
    msgContent?.imageMessage?.caption ??
    msgContent?.videoMessage?.caption ??
    msgContent?.audioMessage?.caption ??
    msgContent?.documentMessage?.caption ??
    body.text?.message ??
    "";

  // Shared contact(s): render name + phone extracted from the vCard so the
  // attendant sees the contact instead of a message that never shows up.
  let contactText = "";
  const vcardPhone = (vcard?: string): string | null => {
    if (!vcard) return null;
    const m = vcard.match(/waid=(\d+)/) ?? vcard.match(/TEL[^:]*:([+\d][\d\s()+-]+)/i);
    return m?.[1]?.trim() ?? null;
  };
  if (msgContent?.contactMessage) {
    const c = msgContent.contactMessage;
    const phoneStr = vcardPhone(c.vcard);
    contactText = `👤 Contato compartilhado: ${c.displayName ?? "Sem nome"}${phoneStr ? ` — ${phoneStr}` : ""}`;
  } else if (msgContent?.contactsArrayMessage) {
    const list = (msgContent.contactsArrayMessage.contacts ?? [])
      .map((c) => {
        const phoneStr = vcardPhone(c.vcard);
        return `${c.displayName ?? "Sem nome"}${phoneStr ? ` — ${phoneStr}` : ""}`;
      });
    contactText = `👤 Contatos compartilhados:\n${list.join("\n")}`;
  }

  // Shared location: render coordinates + a maps link.
  let locationText = "";
  if (msgContent?.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng, name, address } = msgContent.locationMessage;
    const label = [name, address].filter(Boolean).join(" — ");
    const link = lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : "";
    locationText = `📍 Localização${label ? `: ${label}` : ""}${link ? `\n${link}` : ""}`;
  }

  const externalId = body.data?.key?.id ?? body.messageId ?? null;

  // Dedup: em reconexões o Baileys pode reentregar a mesma mensagem
  // (messages.upsert repetido). Se já gravamos esse ID, ignora.
  if (externalId) {
    const [dup] = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.externalId, externalId), eq(messagesTable.direction, "inbound")))
      .limit(1);
    if (dup) return;
  }

  let mediaUrl: string | null = null;
  if (mediaBase64 && mediaMimeType) {
    try {
      mediaUrl = await saveMedia(mediaBase64, mediaMimeType);
    } catch {
      mediaUrl = null;
    }
  }

  const msgType: string = mediaType ?? "text";
  const docFileName = msgContent?.documentMessage?.fileName ?? null;

  const displayContent =
    text ||
    contactText ||
    locationText ||
    (mediaType === "image" ? "📷 Foto"
      : mediaType === "video" ? "🎥 Vídeo"
      : mediaType === "audio" ? "🎵 Áudio"
      : mediaType === "doc" ? `📄 ${docFileName ?? "Documento"}`
      : msgContent?.stickerMessage ? "🙂 Figurinha"
      : "(mensagem não suportada)");

  const sessionKey =
    typeof body.sessionKey === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(body.sessionKey)
      ? body.sessionKey
      : "default";
  // Só sincroniza o nome quando o subject real do grupo veio na mensagem —
  // nunca sobrescreve um nome existente com o rótulo genérico.
  const conv = await upsertConversation(
    phone, convName, displayContent, sessionKey, body.data?.avatarUrl,
    isGroup && !!body.data?.groupSubject,
  );

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
    .onConflictDoNothing()
    .returning();

  // Conflito = mensagem duplicada chegando em paralelo; não notifica de novo.
  if (!msg) return;
  broadcast("message", { conversationId: conv.id, message: msg }, conv.sectorId, isPotentialConversation(conv));
}

export async function processMetaInboundWA(body: MetaInboundWAPayload): Promise<void> {
  if (body.object !== "whatsapp_business_account") return;

  const accessToken = process.env["META_WHATSAPP_ACCESS_TOKEN"] ?? null;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const { messages = [], contacts = [] } = change.value;

      for (const msg of messages) {
        const phone = msg.from;
        const contact = contacts.find((c) => c.wa_id === phone);
        const pushName = contact?.profile?.name ?? phone;
        const externalId = msg.id;

        // Dedup: Meta pode reentregar o mesmo webhook (retry). Ignora IDs já gravados.
        if (externalId) {
          const [dup] = await db
            .select({ id: messagesTable.id })
            .from(messagesTable)
            .where(and(eq(messagesTable.externalId, externalId), eq(messagesTable.direction, "inbound")))
            .limit(1);
          if (dup) continue;
        }

        let text = "";
        let msgType = "text";
        let mediaUrl: string | null = null;

        if (msg.type === "text" && msg.text) {
          text = msg.text.body;
          msgType = "text";
        } else if (msg.type === "image") {
          msgType = "image";
          text = msg.image?.caption ?? "";
          if (accessToken && msg.image?.id) {
            const dl = await downloadMetaMedia(msg.image.id, accessToken);
            if (dl) {
              try { mediaUrl = await saveMedia(dl.base64, dl.mime); } catch { mediaUrl = null; }
            }
          }
        } else if (msg.type === "video") {
          msgType = "video";
          text = msg.video?.caption ?? "";
          if (accessToken && msg.video?.id) {
            const dl = await downloadMetaMedia(msg.video.id, accessToken);
            if (dl) {
              try { mediaUrl = await saveMedia(dl.base64, dl.mime); } catch { mediaUrl = null; }
            }
          }
        } else if (msg.type === "audio") {
          msgType = "audio";
          if (accessToken && msg.audio?.id) {
            const dl = await downloadMetaMedia(msg.audio.id, accessToken);
            if (dl) {
              try { mediaUrl = await saveMedia(dl.base64, dl.mime); } catch { mediaUrl = null; }
            }
          }
        } else if (msg.type === "document") {
          msgType = "doc";
          text = msg.document?.caption ?? msg.document?.filename ?? "";
          if (accessToken && msg.document?.id) {
            const dl = await downloadMetaMedia(msg.document.id, accessToken);
            if (dl) {
              try { mediaUrl = await saveMedia(dl.base64, dl.mime); } catch { mediaUrl = null; }
            }
          }
        } else if (msg.type === "sticker") {
          msgType = "image";
        }

        const displayContent =
          text ||
          (msgType === "image" ? "📷 Foto" :
           msgType === "video" ? "🎥 Vídeo" :
           msgType === "audio" ? "🎵 Áudio" :
           msgType === "doc" ? "📄 Documento" : "(mídia)");

        const conv = await upsertConversation(phone, pushName, displayContent);

        const [saved] = await db
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
          .onConflictDoNothing()
          .returning();

        // Conflito = mensagem duplicada chegando em paralelo; não notifica de novo.
        if (!saved) continue;
        broadcast("message", { conversationId: conv.id, message: saved }, conv.sectorId, isPotentialConversation(conv));
      }
    }
  }
}
