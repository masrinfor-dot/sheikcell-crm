// Instagram Direct no Atendimento (07/10/2026) — "Instagram API com login do
// Instagram" (graph.instagram.com). Mensagens do Direct caem na mesma lista
// do Atendimento (channel="instagram") e o vendedor responde pela mesma tela.
//
// Regras da Meta que valem aqui:
//   - só dá pra responder depois que o cliente mandou mensagem, e em até 24h
//     da última mensagem dele (fora disso a Meta recusa o envio);
//   - token de acesso dura 60 dias — renovado sozinho (refreshInstagramTokens,
//     chamado pelo scheduler);
//   - o webhook é assinado com a chave secreta do app (X-Hub-Signature-256).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNotNull, lt, or, isNull, sql } from "drizzle-orm";
import {
  db, conversationsTable, messagesTable, sectorsTable, tenantInstagramIntegrationsTable,
  type TenantInstagramIntegration,
} from "@workspace/db";
import { decryptErpSecret, encryptErpSecret } from "./erpCrypto";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { autoAssignOnNewPoolConversation } from "./queueAutoAssign";
import { syncCrmAttendant } from "./crmSync";
import { saveMedia } from "./whatsappInbound";
import { logger } from "./logger";

export const INSTAGRAM_SESSION_KEY = "instagram";
export const INSTAGRAM_PHONE_PREFIX = "ig:";

export function graphBase(): string {
  return (process.env["INSTAGRAM_GRAPH_URL"] ?? "https://graph.instagram.com/v25.0").replace(/\/+$/, "");
}

// ─── Segredos ──────────────────────────────────────────────────────────────

export function encryptForColumns(plain: string) {
  const e = encryptErpSecret(plain);
  return { ciphertext: e.ciphertext, iv: e.iv, authTag: e.authTag, keyVersion: e.keyVersion };
}

export function decryptToken(row: TenantInstagramIntegration): string {
  return decryptErpSecret({
    ciphertext: row.encryptedToken, iv: row.tokenIv, authTag: row.tokenAuthTag, keyVersion: row.tokenKeyVersion,
  });
}

export function decryptAppSecret(row: TenantInstagramIntegration): string | null {
  if (!row.encryptedAppSecret || !row.appSecretIv || !row.appSecretAuthTag || row.appSecretKeyVersion == null) return null;
  return decryptErpSecret({
    ciphertext: row.encryptedAppSecret, iv: row.appSecretIv, authTag: row.appSecretAuthTag, keyVersion: row.appSecretKeyVersion,
  });
}

export function newVerifyToken(): string {
  return `sheikcell-ig-${randomBytes(12).toString("hex")}`;
}

/** Assinatura do webhook da Meta: "sha256=" + HMAC-SHA256(corpo cru, chave secreta do app). */
export function verifyInstagramSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Link público e temporário de mídia (a Meta baixa a foto/áudio por URL) ──

function mediaSigningKey(): string {
  return createHmac("sha256", process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret").update("instagram-media-v1").digest("hex");
}

export function signMediaPath(filename: string, nowMs = Date.now(), ttlMs = 60 * 60_000): { exp: number; sig: string } {
  const exp = Math.floor((nowMs + ttlMs) / 1000);
  const sig = createHmac("sha256", mediaSigningKey()).update(`${filename}.${exp}`).digest("hex");
  return { exp, sig };
}

export function verifyMediaSignature(filename: string, exp: number, sig: string, nowMs = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const expected = createHmac("sha256", mediaSigningKey()).update(`${filename}.${exp}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Webhook: leitura do corpo ─────────────────────────────────────────────

export type InstagramAttachment = { type: string; payload?: { url?: string; title?: string } };
export type InstagramEvent = {
  accountId: string; // conta profissional da loja (entry.id)
  senderId: string;
  recipientId: string;
  mid: string | null;
  text: string;
  attachments: InstagramAttachment[];
  isEcho: boolean;
  isDeleted: boolean;
  timestamp: number | null;
};

type RawMessaging = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    attachments?: InstagramAttachment[];
  };
};

/** Lê o corpo do webhook do Instagram e devolve só as mensagens (ignora lido, reação, etc.). */
export function parseInstagramWebhook(body: unknown): InstagramEvent[] {
  const b = (body ?? {}) as { object?: string; entry?: { id?: string; messaging?: RawMessaging[] }[] };
  if (b.object !== "instagram" || !Array.isArray(b.entry)) return [];
  const out: InstagramEvent[] = [];
  for (const entry of b.entry) {
    const accountId = entry?.id ? String(entry.id) : "";
    for (const m of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      if (!m?.message || !m.sender?.id || !m.recipient?.id) continue;
      out.push({
        accountId: accountId || (m.message.is_echo ? String(m.sender.id) : String(m.recipient.id)),
        senderId: String(m.sender.id),
        recipientId: String(m.recipient.id),
        mid: m.message.mid ?? null,
        text: typeof m.message.text === "string" ? m.message.text : "",
        attachments: Array.isArray(m.message.attachments) ? m.message.attachments : [],
        isEcho: m.message.is_echo === true,
        isDeleted: m.message.is_deleted === true,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : null,
      });
    }
  }
  return out;
}

/** Tipo de mensagem do CRM + texto da lista, a partir do primeiro anexo. */
export function describeAttachment(a: InstagramAttachment | undefined): { msgType: string; label: string } {
  switch (a?.type) {
    case "image": return { msgType: "image", label: "📷 Foto" };
    case "video": return { msgType: "video", label: "🎥 Vídeo" };
    case "audio": return { msgType: "audio", label: "🎵 Áudio" };
    case "file": return { msgType: "doc", label: "📄 Arquivo" };
    case "story_mention": return { msgType: "text", label: "📣 Mencionou a loja no story" };
    case "share":
    case "ig_reel":
    case "reel": return { msgType: "text", label: "🔗 Compartilhou uma publicação" };
    default: return { msgType: "text", label: "(anexo)" };
  }
}

/** Texto amigável pros erros mais comuns da Meta no envio. */
export function friendlySendError(raw: unknown): string {
  const e = (raw ?? {}) as { error?: { message?: string; code?: number; error_subcode?: number } };
  const code = e.error?.code;
  const sub = e.error?.error_subcode;
  if (sub === 2534022 || code === 10 || /24.?hour|outside of allowed window/i.test(e.error?.message ?? "")) {
    return "Fora da janela de 24h do Instagram: o cliente precisa mandar mensagem de novo antes de você responder.";
  }
  if (code === 190) return "Token do Instagram expirado ou inválido — gere um novo em Configurações › Integrações › Instagram.";
  return e.error?.message ?? "Instagram recusou o envio";
}

// ─── Banco ─────────────────────────────────────────────────────────────────

export async function integrationByAccount(igUserId: string): Promise<TenantInstagramIntegration | null> {
  const [row] = await db.select().from(tenantInstagramIntegrationsTable)
    .where(eq(tenantInstagramIntegrationsTable.igUserId, igUserId)).limit(1);
  return row ?? null;
}

export async function integrationByTenant(tenantId: number): Promise<TenantInstagramIntegration | null> {
  const [row] = await db.select().from(tenantInstagramIntegrationsTable)
    .where(eq(tenantInstagramIntegrationsTable.tenantId, tenantId)).limit(1);
  return row ?? null;
}

async function graphGet<T>(pathAndQuery: string, token: string): Promise<{ ok: true; data: T } | { ok: false; error: unknown; status: number }> {
  try {
    const r = await fetch(`${graphBase()}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: data as T } : { ok: false, error: data, status: r.status };
  } catch (err) {
    return { ok: false, error: { error: { message: err instanceof Error ? err.message : String(err) } }, status: 0 };
  }
}

export async function fetchInstagramMe(token: string) {
  return graphGet<{ id?: string; user_id?: string; username?: string; name?: string }>(
    "/me?fields=user_id,username,name", token,
  );
}

/** Liga o envio de mensagens desta conta pro webhook do app (exigido pela Meta). */
export async function subscribeInstagramWebhook(igUserId: string, token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${graphBase()}/${encodeURIComponent(igUserId)}/subscribed_apps?subscribed_fields=messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: friendlySendError(await r.json().catch(() => ({}))) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchProfile(igsid: string, token: string): Promise<{ name: string | null; avatarUrl: string | null }> {
  const r = await graphGet<{ name?: string; username?: string; profile_pic?: string }>(
    `/${encodeURIComponent(igsid)}?fields=name,username,profile_pic`, token,
  );
  if (!r.ok) return { name: null, avatarUrl: null };
  const display = r.data.name && r.data.username ? `${r.data.name} (@${r.data.username})`
    : r.data.username ? `@${r.data.username}` : r.data.name ?? null;
  return { name: display, avatarUrl: r.data.profile_pic ?? null };
}

async function downloadAttachment(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    const buf = Buffer.from(await r.arrayBuffer());
    return { base64: buf.toString("base64"), mime };
  } catch {
    return null;
  }
}

/**
 * Acha (ou cria) a conversa do Instagram desse cliente na loja. Mesma lógica
 * do WhatsApp (upsertConversation em whatsappInbound.ts) no que importa:
 * trava contra duas mensagens chegando juntas, reabre conversa resolvida e
 * entra no pool da fila. O setor é o configurado na integração.
 */
async function upsertInstagramConversation(
  integ: TenantInstagramIntegration,
  igsid: string,
  displayContent: string,
  direction: "inbound" | "outbound",
) {
  const tenantId = integ.tenantId;
  const phone = `${INSTAGRAM_PHONE_PREFIX}${igsid}`;
  const conditions = [
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.channel, "instagram"),
    eq(conversationsTable.phone, phone),
    eq(conversationsTable.isArchived, false),
  ];
  let [conv] = await db.select().from(conversationsTable).where(and(...conditions))
    .orderBy(desc(conversationsTable.lastMessageAt)).limit(1);

  if (!conv) {
    let sectorId = integ.sectorId;
    if (sectorId == null) {
      const [first] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
        .where(and(eq(sectorsTable.isActive, true), eq(sectorsTable.tenantId, tenantId))).limit(1);
      sectorId = first?.id ?? null;
    }
    const profile = await fetchProfile(igsid, decryptToken(integ));
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${tenantId}, hashtext(${phone}))`);
      const [already] = await tx.select().from(conversationsTable).where(and(...conditions))
        .orderBy(desc(conversationsTable.lastMessageAt)).limit(1);
      if (already) return { row: already, isNew: false };
      const [inserted] = await tx.insert(conversationsTable).values({
        tenantId,
        phone,
        name: profile.name ?? "Cliente do Instagram",
        avatarUrl: profile.avatarUrl,
        channel: "instagram",
        sessionKey: INSTAGRAM_SESSION_KEY,
        sectorId,
        status: "open",
        lastMessage: displayContent,
        lastMessageDirection: direction,
        lastMessageAt: new Date(),
        unreadCount: direction === "inbound" ? 1 : 0,
      }).returning();
      return { row: inserted!, isNew: true };
    });
    conv = created.row;
    if (created.isNew) {
      broadcast("conversation_new", conv, { tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
      if (direction === "inbound") void autoAssignOnNewPoolConversation(conv);
      return conv;
    }
  }

  const reopen = direction === "inbound" && (conv.status === "resolved" || conv.status === "archived");
  const [updated] = await db.update(conversationsTable).set({
    lastMessage: displayContent,
    lastMessageDirection: direction,
    lastMessageSenderName: null,
    lastMessageAt: new Date(),
    updatedAt: new Date(),
    ...(direction === "inbound" ? { unreadCount: sql`${conversationsTable.unreadCount} + 1` } : {}),
    ...(reopen ? { status: "open", assigneeId: null, attendanceStartedAt: null } : {}),
  }).where(eq(conversationsTable.id, conv.id)).returning();
  if (updated) conv = updated;
  if (reopen && updated) {
    broadcast("conversation_updated", updated, { tenantId, sectorId: updated.sectorId, sessionKey: updated.sessionKey, isPotential: isPotentialConversation(updated), restrictedTo: await restrictedRecipients(updated) });
    await syncCrmAttendant(updated);
    void autoAssignOnNewPoolConversation(updated);
  }
  return conv;
}

/** Processa um webhook já autenticado. Mensagens de contas sem integração ativa são ignoradas. */
export async function processInstagramEvents(events: InstagramEvent[]): Promise<number> {
  let saved = 0;
  for (const ev of events) {
    const integ = await integrationByAccount(ev.accountId);
    if (!integ || !integ.enabled) continue;
    if (ev.isDeleted) continue;

    // Dedup: a Meta reentrega webhook; e as respostas enviadas pelo CRM voltam
    // como "eco" com o mesmo mid que já gravamos no envio.
    if (ev.mid) {
      const [dup] = await db.select({ id: messagesTable.id }).from(messagesTable)
        .where(and(eq(messagesTable.tenantId, integ.tenantId), eq(messagesTable.externalId, ev.mid))).limit(1);
      if (dup) continue;
    }

    const customerId = ev.isEcho ? ev.recipientId : ev.senderId;
    const first = ev.attachments[0];
    const { msgType: attType, label } = describeAttachment(first);
    let msgType = first ? attType : "text";
    let mediaUrl: string | null = null;
    let text = ev.text;
    if (first && (first.type === "share" || first.type === "story_mention" || first.type === "ig_reel" || first.type === "reel")) {
      text = [ev.text, label, first.payload?.url].filter(Boolean).join("\n");
    } else if (first?.payload?.url && ["image", "video", "audio", "doc"].includes(attType)) {
      const dl = await downloadAttachment(first.payload.url);
      if (dl) {
        try { mediaUrl = await saveMedia(dl.base64, dl.mime); } catch (err) {
          logger.warn({ err, mime: dl.mime }, "Instagram: mídia não suportada");
          mediaUrl = null;
          msgType = "text";
          text = [ev.text, label].filter(Boolean).join("\n");
        }
      }
    }
    const displayContent = text || (first ? label : "(mensagem vazia)");
    const direction = ev.isEcho ? "outbound" : "inbound";

    const conv = await upsertInstagramConversation(integ, customerId, displayContent, direction);
    const [row] = await db.insert(messagesTable).values({
      tenantId: conv.tenantId,
      conversationId: conv.id,
      content: displayContent,
      direction,
      type: msgType,
      status: direction === "inbound" ? "delivered" : "sent",
      // Eco = alguém respondeu direto pelo app do Instagram, fora do CRM.
      senderName: ev.isEcho ? "Instagram (app)" : conv.name,
      externalId: ev.mid,
      mediaUrl,
    }).onConflictDoNothing().returning();
    if (!row) continue;
    saved += 1;
    broadcast("message", { conversationId: conv.id, message: row }, { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  }
  if (events.length > 0) {
    const accounts = [...new Set(events.map((e) => e.accountId))];
    for (const acc of accounts) {
      await db.update(tenantInstagramIntegrationsTable).set({ lastWebhookAt: new Date() })
        .where(eq(tenantInstagramIntegrationsTable.igUserId, acc));
    }
  }
  return saved;
}

// ─── Envio ─────────────────────────────────────────────────────────────────

export type InstagramSendResult = { ok: true; messageId: string | null } | { ok: false; error: string };

async function postMessage(integ: TenantInstagramIntegration, recipientId: string, message: unknown): Promise<InstagramSendResult> {
  const token = decryptToken(integ);
  const target = integ.igUserId ? encodeURIComponent(integ.igUserId) : "me";
  try {
    const r = await fetch(`${graphBase()}/${target}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipient: { id: recipientId }, message }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await r.json().catch(() => ({}))) as { message_id?: string };
    if (!r.ok) return { ok: false, error: friendlySendError(data) };
    return { ok: true, messageId: data.message_id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function recipientOf(conv: { phone: string }): string | null {
  return conv.phone.startsWith(INSTAGRAM_PHONE_PREFIX) ? conv.phone.slice(INSTAGRAM_PHONE_PREFIX.length) : null;
}

export async function sendInstagramText(conv: { tenantId: number; phone: string }, text: string): Promise<InstagramSendResult> {
  const integ = await integrationByTenant(conv.tenantId);
  const to = recipientOf(conv);
  if (!integ || !integ.enabled) return { ok: false, error: "Instagram não está conectado nesta loja" };
  if (!to) return { ok: false, error: "Conversa sem identificador do Instagram" };
  return postMessage(integ, to, { text: text.slice(0, 1000) });
}

/** Mídia vai por link público temporário (a Meta baixa do nosso servidor). */
export async function sendInstagramMedia(
  conv: { tenantId: number; phone: string },
  filename: string,
  kind: "image" | "video" | "audio" | "file",
  publicApiBase: string,
): Promise<InstagramSendResult> {
  const integ = await integrationByTenant(conv.tenantId);
  const to = recipientOf(conv);
  if (!integ || !integ.enabled) return { ok: false, error: "Instagram não está conectado nesta loja" };
  if (!to) return { ok: false, error: "Conversa sem identificador do Instagram" };
  const { exp, sig } = signMediaPath(filename);
  const url = `${publicApiBase.replace(/\/+$/, "")}/instagram/media/${encodeURIComponent(filename)}?exp=${exp}&sig=${sig}`;
  return postMessage(integ, to, { attachment: { type: kind, payload: { url } } });
}

/** Grava o id da Meta na mensagem enviada (pra o eco do webhook não duplicar). */
export async function markSentExternalId(messageId: number, externalId: string | null): Promise<void> {
  if (!externalId) return;
  await db.update(messagesTable).set({ externalId }).where(eq(messagesTable.id, messageId));
}

export function publicApiBaseFromRequest(req: { protocol: string; get(name: string): string | undefined; headers: Record<string, unknown> }): string {
  const configured = process.env["PUBLIC_API_URL"]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"].split(",")[0]!.trim() : "") || req.protocol;
  const host = (typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].split(",")[0]!.trim() : "") || req.get("host") || "";
  return `${proto}://${host}/api`;
}

export function instagramMediaKind(msgType: string): "image" | "video" | "audio" | "file" {
  return msgType === "image" ? "image" : msgType === "video" ? "video" : msgType === "audio" ? "audio" : "file";
}

// ─── Renovação do token (60 dias) ──────────────────────────────────────────

/** Renova tokens que vencem em menos de 15 dias. Chamado 1x por dia pelo scheduler. */
export async function refreshInstagramTokens(now = new Date()): Promise<number> {
  const limit = new Date(now.getTime() + 15 * 24 * 3600_000);
  const rows = await db.select().from(tenantInstagramIntegrationsTable).where(and(
    eq(tenantInstagramIntegrationsTable.enabled, true),
    isNotNull(tenantInstagramIntegrationsTable.igUserId),
    or(isNull(tenantInstagramIntegrationsTable.tokenExpiresAt), lt(tenantInstagramIntegrationsTable.tokenExpiresAt, limit)),
  ));
  let refreshed = 0;
  for (const row of rows) {
    try {
      const token = decryptToken(row);
      const base = graphBase().replace(/\/v\d+(\.\d+)?$/, "");
      const r = await fetch(`${base}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (!r.ok || !data.access_token) {
        await db.update(tenantInstagramIntegrationsTable).set({ lastError: `Renovação do token: ${friendlySendError(data)}` })
          .where(eq(tenantInstagramIntegrationsTable.tenantId, row.tenantId));
        continue;
      }
      const enc = encryptForColumns(data.access_token);
      await db.update(tenantInstagramIntegrationsTable).set({
        encryptedToken: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, tokenKeyVersion: enc.keyVersion,
        tokenLast4: data.access_token.slice(-4),
        tokenExpiresAt: new Date(now.getTime() + (data.expires_in ?? 60 * 24 * 3600) * 1000),
        lastError: null,
      }).where(eq(tenantInstagramIntegrationsTable.tenantId, row.tenantId));
      refreshed += 1;
    } catch (err) {
      logger.warn({ err, tenantId: row.tenantId }, "Instagram: falha ao renovar token");
    }
  }
  return refreshed;
}
