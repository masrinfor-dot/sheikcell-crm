import { db, conversationsTable, messagesTable, sectorsTable, attendanceLogsTable, whatsappSessionsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { classifyText } from "./autoRouter";
import { ensureCrmContactForConversation, syncCrmAttendant } from "./crmSync";
import { getSurveySettings, SURVEY_DEFAULTS, surveyScaleMin, buildThankYouMessage } from "./surveySettings";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

export const MEDIA_DIR = path.resolve(process.cwd(), "media");

// Sessão padrão/legada pertence à loja 1 (dados legados). Chaves novas de
// sessão são prefixadas t{tenantId}- (ver routes/whatsapp.ts).
const DEFAULT_SESSION_KEY = "default";
const LEGACY_TENANT_ID = 1;

// Multi-loja: resolve a loja (tenant) dona da sessão de WhatsApp pela
// sessionKey do webhook. FAIL CLOSED: só a chave legada "default" mapeia para
// a loja 1; qualquer outra chave sem linha em whatsapp_sessions é rejeitada
// (retorna null e a mensagem é descartada) — nunca cai em outra loja.
async function resolveTenantForSession(sessionKey: string): Promise<number | null> {
  if (sessionKey === DEFAULT_SESSION_KEY) return LEGACY_TENANT_ID;
  const [row] = await db
    .select({ tenantId: whatsappSessionsTable.tenantId })
    .from(whatsappSessionsTable)
    .where(eq(whatsappSessionsTable.sessionKey, sessionKey))
    .limit(1);
  return row?.tenantId ?? null;
}

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
  liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number; caption?: string };
  stickerMessage?: object;
  pollCreationMessage?: { name?: string; options?: Array<{ optionName?: string }> };
  pollCreationMessageV2?: { name?: string; options?: Array<{ optionName?: string }> };
  pollCreationMessageV3?: { name?: string; options?: Array<{ optionName?: string }> };
  ptvMessage?: { caption?: string };
  buttonsResponseMessage?: { selectedDisplayText?: string; selectedButtonId?: string };
  listResponseMessage?: { title?: string; singleSelectReply?: { selectedRowId?: string } };
  templateButtonReplyMessage?: { selectedDisplayText?: string };
  interactiveResponseMessage?: { body?: { text?: string } };
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
    mediaType?: "image" | "video" | "audio" | "doc" | "sticker";
    avatarUrl?: string;
    // Reação/edição a uma mensagem já existente — atualiza em vez de criar.
    reaction?: { targetId: string; emoji: string };
    edit?: { targetId: string; message?: InboundWAMessageContent };
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
  tenantId: number,
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
  // contacted. Multi-loja: sempre escopado pela loja (tenant) da sessão.
  let [conv] = await db
    .select()
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.phone, phone),
      eq(conversationsTable.sessionKey, sessionKey),
      eq(conversationsTable.isArchived, false),
    ))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(1);

  if (!conv) {
    // Roteamento automático só considera regras e setores DESTA loja.
    const classified = displayContent ? await classifyText(displayContent, tenantId) : null;
    const [first] = await db
      .select()
      .from(sectorsTable)
      .where(and(eq(sectorsTable.isActive, true), eq(sectorsTable.tenantId, tenantId)))
      .limit(1);
    const targetSectorId = classified?.sectorId ?? first?.id ?? 1;
    [conv] = await db
      .insert(conversationsTable)
      .values({
        tenantId,
        phone,
        name: pushName,
        avatarUrl: avatarUrl ?? null,
        channel: "whatsapp",
        sessionKey,
        sectorId: targetSectorId,
        status: "open",
        lastMessage: displayContent,
        lastMessageDirection: "inbound",
        lastMessageAt: new Date(),
        unreadCount: 1,
      })
      .returning();
    broadcast("conversation_new", conv, { tenantId: conv.tenantId, sectorId: conv.sectorId, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
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
        lastMessageDirection: "inbound",
        lastMessageAt: new Date(),
        unreadCount: sql`${conversationsTable.unreadCount} + 1`,
        updatedAt: new Date(),
        ...(reopen ? { status: "open", assigneeId: null, attendanceStartedAt: null } : {}),
        ...(avatarUrl && avatarUrl !== conv.avatarUrl ? { avatarUrl } : {}),
        ...(syncName && pushName && pushName !== conv.name ? { name: pushName } : {}),
      })
      .where(eq(conversationsTable.id, conv.id))
      .returning();
    if (updated) conv = updated;
    if (reopen && updated) {
      broadcast("conversation_updated", updated, { tenantId: updated.tenantId, sectorId: updated.sectorId, isPotential: isPotentialConversation(updated), restrictedTo: await restrictedRecipients(updated) });
      // Cliente voltou: cartão do CRM volta para "Potenciais" e perde o atendente.
      await syncCrmAttendant(updated);
    }
  }

  return conv;
}

// ── Pesquisa de satisfação: primeira resposta após a pesquisa ────────────────
// Se a conversa está aguardando a nota (pendingSurveyLogId) e a resposta
// chega DENTRO do prazo configurado, ela é SEMPRE tratada como resposta da
// pesquisa — nota extraída quando possível ("5", "5 estrelas, adorei!"),
// senão gravada como feedback sem nota — e a conversa NUNCA reabre nem
// rebaixa o estágio no funil por causa disso (é só um feedback pós-
// atendimento, não uma nova interação). Só quando o prazo já expirou é que a
// resposta segue o fluxo normal (reabertura, robô etc.) — aí sim é uma nova
// interação de verdade. Compartilhado pelos dois caminhos de entrada
// (Baileys e Meta). Retorna true quando a mensagem foi totalmente tratada aqui.
async function tryConsumeSurveyReply(input: {
  tenantId: number;
  phone: string;
  sessionKey: string;
  text: string;
  msgType: string;
  displayContent: string;
  pushName: string;
  externalId: string | null;
}): Promise<boolean> {
  const { tenantId, phone, sessionKey, text, msgType, displayContent, pushName, externalId } = input;

  // Configuração da pesquisa (escala, prazo, recompensa) — lida antes da
  // transação; falha na leitura cai nos padrões (nunca perde a nota por isso).
  const cfg = await getSurveySettings(tenantId).catch(() => ({ ...SURVEY_DEFAULTS }));
  const surveyCfg = {
    scaleMin: surveyScaleMin(cfg),
    scaleMax: cfg.scaleMax,
    windowHours: cfg.responseWindowHours,
    rewardEnabled: cfg.rewardEnabled,
    rewardText: cfg.rewardText,
  };

  const outcome = await db.transaction(async (tx) => {
    // Trava a conversa: webhooks concorrentes/reentregues serializam aqui, e
    // só o primeiro encontra a pesquisa pendente (consumo atômico). Escopado
    // pela loja (tenant) da sessão.
    const [conv] = await tx
      .select()
      .from(conversationsTable)
      .where(and(
        eq(conversationsTable.tenantId, tenantId),
        eq(conversationsTable.phone, phone),
        eq(conversationsTable.sessionKey, sessionKey),
        eq(conversationsTable.isArchived, false),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt))
      .limit(1)
      .for("update");
    if (!conv) return null;

    // Perdeu a corrida para uma reentrega da MESMA mensagem que já foi
    // consumida como avaliação: trata como duplicada (não reabre nada).
    if (conv.pendingSurveyLogId == null) {
      if (externalId) {
        const [dup] = await tx.select({ id: messagesTable.id }).from(messagesTable)
          .where(and(eq(messagesTable.externalId, externalId), eq(messagesTable.direction, "inbound")))
          .limit(1);
        if (dup) return { conv, rating: null as number | null, msg: null, duplicate: true };
      }
      return null;
    }

    const surveyLogId = conv.pendingSurveyLogId;
    // Escala/prazo/recompensa do RETRATO gravado no envio da pesquisa: mudar a
    // configuração depois não afeta pesquisas já enviadas. Pesquisas antigas
    // (sem retrato) caem na configuração atual.
    const scaleMax = conv.surveyScaleMax ?? surveyCfg.scaleMax;
    const scaleMin = scaleMax === 10 ? 0 : 1;
    const windowHours = conv.surveyWindowHours ?? surveyCfg.windowHours;
    const rewardText = conv.surveyRewardText
      ?? (surveyCfg.rewardEnabled && surveyCfg.rewardText.trim() ? surveyCfg.rewardText.trim() : null);
    // Extrai a nota mesmo quando vem junto de texto ("5 estrelas, adorei!",
    // "nota 5", "5 ⭐") — só exige que seja a única sequência de dígitos de
    // um texto curto, pra não confundir com outro número que aparecesse
    // solto numa mensagem longa sem relação com a pesquisa.
    const numMatch = msgType === "text" && text.length <= 60 ? /\b(10|[0-9])\b/u.exec(text) : null;
    const num = numMatch ? parseInt(numMatch[1]!, 10) : null;
    const inScale = num != null && num >= scaleMin && num <= scaleMax;
    const sentAt = conv.surveySentAt?.getTime() ?? 0;
    const fresh = Date.now() - sentAt <= windowHours * 3_600_000;

    // Em qualquer resposta, a pesquisa deixa de esperar (evita que um "5"
    // solto dias depois vire avaliação).
    await tx.update(conversationsTable)
      .set({ pendingSurveyLogId: null, surveySentAt: null, surveyScaleMax: null, surveyWindowHours: null, surveyRewardText: null, surveyReminderSentAt: null })
      .where(eq(conversationsTable.id, conv.id));

    // Fora do prazo: não é mais resposta de pesquisa, é uma interação nova de
    // verdade — segue o fluxo normal (pode reabrir, é o comportamento certo
    // aqui). DENTRO do prazo, qualquer formato de resposta (nota, texto
    // livre, áudio, figurinha) é tratado como feedback e NUNCA reabre a
    // conversa nem rebaixa o estágio no funil — só extrai a nota quando dá.
    if (!fresh) return null;

    const rating = inScale ? num : null;
    if (rating != null) {
      await tx.update(attendanceLogsTable)
        .set({ satisfactionRating: rating })
        .where(eq(attendanceLogsTable.id, surveyLogId));
    }

    // Grava a resposta como mensagem da conversa (sem reabrir o atendimento).
    // Conflito de externalId = reentrega duplicada: mantém a nota, sem
    // broadcast/agradecimento repetidos.
    const [msg] = await tx.insert(messagesTable).values({
      tenantId: conv.tenantId,
      conversationId: conv.id,
      content: displayContent,
      direction: "inbound",
      type: msgType,
      status: "delivered",
      senderName: pushName,
      externalId,
    }).onConflictDoNothing().returning();
    if (msg) {
      await tx.update(conversationsTable).set({
        lastMessage: displayContent,
        lastMessageDirection: "inbound",
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(conversationsTable.id, conv.id));
    }
    return { conv, rating, msg: msg ?? null, duplicate: false, rewardText };
  });

  if (!outcome) return false;
  if (outcome.duplicate) return true;

  if (outcome.msg) {
    broadcast(
      "message",
      { conversationId: outcome.conv.id, message: outcome.msg },
      {
        tenantId: outcome.conv.tenantId,
        sectorId: outcome.conv.sectorId,
        isPotential: isPotentialConversation(outcome.conv),
        restrictedTo: await restrictedRecipients(outcome.conv),
      },
    );
    // Agradece pelo mesmo caminho anti-ban do bridge (melhor esforço) e, se
    // configurado, entrega a recompensa (cupom/voucher) a quem respondeu com
    // uma nota. Resposta sem nota extraível (texto livre, áudio, figurinha)
    // ainda é feedback válido — só não dá pra render a recompensa "por nota".
    const { sendOutboundText } = await import("./outbound");
    if (outcome.rating != null) {
      const reward = "rewardText" in outcome && outcome.rewardText
        ? `\n\n🎁 ${outcome.rewardText}`
        : "";
      void sendOutboundText(
        outcome.conv.id,
        `${buildThankYouMessage(cfg.thankYouMessage, outcome.rating)}${reward}`,
        "Pesquisa de satisfação",
      ).catch(() => {});
    } else {
      void sendOutboundText(outcome.conv.id, "Obrigado pelo seu feedback! 🙏", "Pesquisa de satisfação").catch(() => {});
    }
  }
  return true;
}

async function broadcastMessageUpdated(updated: typeof messagesTable.$inferSelect): Promise<void> {
  const [conv] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.id, updated.conversationId)).limit(1);
  if (!conv) return;
  broadcast("message_updated", { conversationId: conv.id, message: updated }, {
    tenantId: conv.tenantId, sectorId: conv.sectorId,
    isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv),
  });
}

async function applyReaction(targetId: string, emoji: string, senderName: string): Promise<void> {
  const [target] = await db.select().from(messagesTable)
    .where(eq(messagesTable.externalId, targetId)).limit(1);
  if (!target) return;
  const current = (target.reactions ?? []).filter((r) => r.senderName !== senderName);
  const next = emoji ? [...current, { emoji, senderName }] : current;
  const [updated] = await db.update(messagesTable).set({ reactions: next })
    .where(eq(messagesTable.id, target.id)).returning();
  if (updated) await broadcastMessageUpdated(updated);
}

async function applyEdit(targetId: string, newContent: string): Promise<void> {
  const [target] = await db.select().from(messagesTable)
    .where(eq(messagesTable.externalId, targetId)).limit(1);
  if (!target) return;
  const [updated] = await db.update(messagesTable)
    .set({ content: newContent, editedAt: new Date() })
    .where(eq(messagesTable.id, target.id)).returning();
  if (updated) await broadcastMessageUpdated(updated);
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

  // Reação a uma mensagem existente: atualiza a lista de reações da
  // mensagem-alvo em vez de criar uma mensagem nova. Emoji vazio = reação
  // removida (comportamento nativo do WhatsApp).
  if (body.data?.reaction) {
    await applyReaction(body.data.reaction.targetId, body.data.reaction.emoji, pushName);
    return;
  }

  // Edição de mensagem: sobrescreve o conteúdo da mensagem original e marca
  // o horário da edição (exibida como "editado" na Central).
  if (body.data?.edit) {
    const edited = body.data.edit.message;
    const newText = edited?.conversation ?? edited?.extendedTextMessage?.text ?? "";
    if (newText) await applyEdit(body.data.edit.targetId, newText);
    return;
  }

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
  } else if (msgContent?.liveLocationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng, caption } = msgContent.liveLocationMessage;
    const link = lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : "";
    locationText = `📍 Localização em tempo real compartilhada${caption ? `: ${caption}` : ""}${link ? `\n${link}` : ""}`;
  }

  // Respostas de botão/lista/template/fluxo interativo (WhatsApp Business).
  const interactiveText =
    (msgContent?.buttonsResponseMessage?.selectedDisplayText
      ? `🔘 ${msgContent.buttonsResponseMessage.selectedDisplayText}`
      : null) ??
    (msgContent?.listResponseMessage?.title
      ? `🔘 ${msgContent.listResponseMessage.title}`
      : null) ??
    (msgContent?.templateButtonReplyMessage?.selectedDisplayText
      ? `🔘 ${msgContent.templateButtonReplyMessage.selectedDisplayText}`
      : null) ??
    (msgContent?.interactiveResponseMessage?.body?.text
      ? `🔘 ${msgContent.interactiveResponseMessage.body.text}`
      : null) ??
    "";

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

  // Enquete: mostra a pergunta e as opções.
  const poll = msgContent?.pollCreationMessage ?? msgContent?.pollCreationMessageV2 ?? msgContent?.pollCreationMessageV3;
  const pollText = poll
    ? `📊 Enquete: ${poll.name ?? ""}${(poll.options ?? []).length ? `\n${(poll.options ?? []).map((o) => `• ${o.optionName ?? ""}`).join("\n")}` : ""}`.trim()
    : "";

  // Fallback genérico para qualquer tipo realmente não mapeado: em vez de um
  // texto sem informação nenhuma, mostra pelo menos o nome do campo bruto do
  // WhatsApp recebido (ajuda a diagnosticar e já é mais útil que um erro).
  const NOISE_KEYS = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);
  const rawKeys = msgContent
    ? Object.keys(msgContent).filter((k) => !NOISE_KEYS.has(k) && (msgContent as Record<string, unknown>)[k] != null)
    : [];
  const unknownKind = rawKeys[0];

  const displayContent =
    text ||
    contactText ||
    locationText ||
    pollText ||
    interactiveText ||
    (mediaType === "image" ? "📷 Foto"
      : mediaType === "video" ? "🎥 Vídeo"
      : mediaType === "audio" ? "🎵 Áudio"
      : mediaType === "doc" ? `📄 ${docFileName ?? "Documento"}`
      : mediaType === "sticker" ? "🙂 Figurinha"
      : unknownKind ? `⚠️ Tipo de mensagem não suportado (${unknownKind})`
      : "⚠️ Tipo de mensagem não suportado");

  const sessionKey =
    typeof body.sessionKey === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(body.sessionKey)
      ? body.sessionKey
      : "default";
  // Multi-loja: resolve a loja dona desta sessão de WhatsApp. Sessão
  // desconhecida = descarta (fail closed — nunca grava na loja errada).
  const tenantId = await resolveTenantForSession(sessionKey);
  if (tenantId == null) {
    console.warn(`[whatsapp] Mensagem descartada: sessão desconhecida "${sessionKey}"`);
    return;
  }
  // Pesquisa de satisfação: se a resposta consumiu a pesquisa, não reabre a
  // conversa nem aciona o robô.
  if (!isGroup) {
    const handled = await tryConsumeSurveyReply({
      tenantId, phone, sessionKey, text, msgType, displayContent, pushName, externalId,
    });
    if (handled) return;
  }

  // Só sincroniza o nome quando o subject real do grupo veio na mensagem —
  // nunca sobrescreve um nome existente com o rótulo genérico.
  const conv = await upsertConversation(
    tenantId, phone, convName, displayContent, sessionKey, body.data?.avatarUrl,
    isGroup && !!body.data?.groupSubject,
  );

  const [msg] = await db
    .insert(messagesTable)
    .values({
      tenantId: conv.tenantId,
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
  broadcast("message", { conversationId: conv.id, message: msg }, { tenantId: conv.tenantId, sectorId: conv.sectorId, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

  // Robô de pré-atendimento (assíncrono: nunca atrasa nem derruba o webhook)
  if (msgType === "text") {
    void import("./bot").then((m) => m.handleBotInbound(conv, displayContent)).catch(() => {});
  } else if (msgType === "audio") {
    // Áudio: transcreve com o Whisper e entrega o texto ao robô, como se o
    // cliente tivesse digitado. Falha de transcrição não derruba o webhook.
    void transcribeAndBot(conv, msg.id);
  }
}

/** Transcreve um áudio recém-chegado, avisa as telas e aciona o robô. */
async function transcribeAndBot(conv: typeof conversationsTable.$inferSelect, messageId: number): Promise<void> {
  try {
    // Só paga a transcrição se o robô fosse mesmo responder (ligado, conversa
    // sem responsável, dentro do modo configurado). Senão, o vendedor usa o
    // botão "Transcrever" manualmente quando precisar.
    const bot = await import("./bot");
    if (!(await bot.botWouldHandle(conv))) return;

    const { transcribeMessage } = await import("./transcribe");
    const transcript = await transcribeMessage(messageId);

    // Estado FRESCO da conversa: durante a transcrição ela pode ter sido
    // assumida/finalizada — o aviso SSE e o robô usam o retrato atual, nunca
    // o antigo (senão a transcrição vaza para quem perdeu o acesso).
    const [freshConv] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.id, conv.id)).limit(1);
    if (!freshConv) return;
    const [updated] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).limit(1);
    if (updated) {
      broadcast("message_updated", { conversationId: freshConv.id, message: updated }, { tenantId: freshConv.tenantId, sectorId: freshConv.sectorId, isPotential: isPotentialConversation(freshConv), restrictedTo: await restrictedRecipients(freshConv) });
    }
    // Recheca a elegibilidade com o estado atual antes do robô falar.
    if (await bot.botWouldHandle(freshConv)) {
      await bot.handleBotInbound(freshConv, transcript);
    }
  } catch (err) {
    const { logger } = await import("./logger");
    logger.warn({ err, messageId }, "Falha ao transcrever áudio inbound");
  }
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

        // Pesquisa de satisfação: mesma regra do caminho Baileys — se a
        // resposta consumiu a pesquisa, não reabre a conversa nem aciona o robô.
        // Meta Cloud API usa a conexão padrão → loja 1 (legado).
        const tenantId = LEGACY_TENANT_ID;
        const surveyHandled = await tryConsumeSurveyReply({
          tenantId,
          phone,
          sessionKey: "default",
          text,
          msgType,
          displayContent,
          pushName,
          externalId: externalId ?? null,
        });
        if (surveyHandled) continue;

        const conv = await upsertConversation(tenantId, phone, pushName, displayContent);

        const [saved] = await db
          .insert(messagesTable)
          .values({
            tenantId: conv.tenantId,
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
        broadcast("message", { conversationId: conv.id, message: saved }, { tenantId: conv.tenantId, sectorId: conv.sectorId, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

        // Robô de pré-atendimento (assíncrono)
        if (saved.type === "text") {
          const convRef = conv;
          const textRef = saved.content;
          void import("./bot").then((m) => m.handleBotInbound(convRef, textRef)).catch(() => {});
        } else if (saved.type === "audio") {
          void transcribeAndBot(conv, saved.id);
        }
      }
    }
  }
}
