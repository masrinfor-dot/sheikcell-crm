/**
 * Baileys WhatsApp connection manager — MULTI-SESSION.
 * - Each session (numbered WhatsApp connection) has its own socket, QR,
 *   reconnect state and anti-ban send queue.
 * - Auth state is loaded from PostgreSQL per sessionKey → auto-reconnects without QR.
 * - Sessions are discovered from the whatsapp_sessions table at startup;
 *   a "default" session is created if none exist.
 */
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  proto,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { logger } from "./logger";
import { useDatabaseAuthState, clearAuthState } from "./dbAuthState";
import { db, whatsappSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

type ConnectionStatus = "connecting" | "open" | "close" | "qr";

export const DEFAULT_SESSION_KEY = "default";

const API_SERVER_URL = process.env["API_SERVER_URL"] ?? "http://localhost:80";

const SESSION_SECRET_SEED =
  process.env["SESSION_SECRET"] ??
  (process.env["NODE_ENV"] === "production"
    ? (() => { throw new Error("SESSION_SECRET env var is required in production"); })()
    : "sheikcell-dev-only-secret");
const BRIDGE_SECRET = createHmac("sha256", SESSION_SECRET_SEED)
  .update("whatsapp-bridge-v1")
  .digest("hex");

// ─── Anti-ban pacing constants (per session) ────────────────────────────────
const MIN_GAP_BASE_MS = 1500;   // intervalo mínimo entre envios
const MIN_GAP_JITTER_MS = 1500; // + variação aleatória (1.5s a 3s no total)
const TYPING_MS_PER_CHAR = 45;  // velocidade de "digitação" simulada
const TYPING_MAX_MS = 4000;     // teto para não travar a fila
const SEND_JOB_TIMEOUT_MS = 45_000; // watchdog: um envio travado não pode parar a fila

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: tempo esgotado (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

interface Session {
  key: string;
  sock: WASocket | null;
  status: ConnectionStatus;
  qr: string | null;
  phone: string | null;
  error: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  stopped: boolean; // removed sessions must not reconnect
  // Anti-ban send queue — one chain per session so one number's pacing
  // never delays another number's sends.
  sendChain: Promise<void>;
  lastSendAt: number;
}

const sessions = new Map<string, Session>();

function newSession(key: string): Session {
  return {
    key,
    sock: null,
    status: "connecting",
    qr: null,
    phone: null,
    error: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    stopped: false,
    sendChain: Promise.resolve(),
    lastSendAt: 0,
  };
}

function clearReconnectTimer(s: Session) {
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
}

// Multi-loja: a loja dona da sessão é derivada da PRÓPRIA chave — "default"
// pertence à loja 1 (legado) e chaves novas são "t{tenantId}-...". Chave fora
// desses formatos não tem dono verificável → null (nunca cai na loja 1).
function tenantOfSessionKey(key: string): number | null {
  if (key === "default") return 1;
  const m = /^t(\d+)-/.exec(key);
  if (!m) return null;
  const t = Number(m[1]);
  return Number.isInteger(t) && t > 0 ? t : null;
}

async function persistStatus(
  key: string,
  status: string,
  phoneNumber: string | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    const isConnected = status === "connected";
    const set = {
      status,
      phoneNumber,
      errorMessage,
      lastHeartbeatAt: isConnected ? new Date() : undefined,
      updatedAt: new Date(),
    };
    const tenantId = tenantOfSessionKey(key);
    if (tenantId == null) {
      // Dono não verificável pela chave: NUNCA insere (o default do schema
      // atribuiria a loja 1 — vazamento). Só atualiza a linha existente, e o
      // update não toca tenant_id, preservando a posse registrada pela API.
      await db.update(whatsappSessionsTable).set(set)
        .where(eq(whatsappSessionsTable.sessionKey, key));
      return;
    }
    await db
      .insert(whatsappSessionsTable)
      .values({ sessionKey: key, tenantId, phoneId: null, ...set })
      .onConflictDoUpdate({
        target: whatsappSessionsTable.sessionKey,
        // tenant_id fica FORA do set: um upsert jamais transfere a sessão de loja.
        set,
      });
  } catch (e) {
    logger.warn({ err: e, sessionKey: key }, "Failed to persist WhatsApp session status to DB");
  }
}

// Cache da foto de perfil por JID (6h) — evita consultar o WhatsApp a cada
// mensagem recebida do mesmo contato.
const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;
const avatarCache = new Map<string, { url: string | undefined; at: number }>();

async function getProfilePicture(s: Session, jid: string): Promise<string | undefined> {
  const hit = avatarCache.get(jid);
  if (hit && Date.now() - hit.at < AVATAR_TTL_MS) return hit.url;
  let url: string | undefined;
  try {
    // Timeout curto: buscar a foto nunca pode atrasar/travar a entrega da
    // mensagem recebida.
    url = (await Promise.race([
      s.sock?.profilePictureUrl(jid, "image"),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ])) ?? undefined;
  } catch {
    // sem foto ou privacidade restrita — segue sem avatar
  }
  avatarCache.set(jid, { url, at: Date.now() });
  return url;
}

// Cache do nome (subject) do grupo por JID (6h) — evita consultar os metadados
// do grupo a cada mensagem recebida.
const groupSubjectCache = new Map<string, { subject: string | undefined; at: number }>();

async function getGroupSubject(s: Session, jid: string): Promise<string | undefined> {
  const hit = groupSubjectCache.get(jid);
  if (hit && Date.now() - hit.at < AVATAR_TTL_MS) return hit.subject;
  let subject: string | undefined;
  try {
    // Timeout curto: buscar o nome do grupo nunca pode atrasar a entrega.
    subject = (await Promise.race([
      s.sock?.groupMetadata(jid).then((meta) => meta?.subject || undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ])) ?? undefined;
  } catch {
    // sem acesso aos metadados — segue sem nome; a Central usa um rótulo padrão
  }
  groupSubjectCache.set(jid, { subject, at: Date.now() });
  return subject;
}

/**
 * Forwards an inbound Baileys message to the API server's webhook so it gets
 * persisted and broadcast to the attendance UI. Includes the sessionKey so the
 * conversation is tied to the WhatsApp number that received it.
 */
async function forwardInboundMessage(s: Session, m: WAMessage): Promise<void> {
  if (m.key?.fromMe) return;
  let remoteJid = m.key?.remoteJid ?? "";
  // Status e canais (newsletter) ficam de fora; grupos e comunidades (@g.us)
  // agora são encaminhados para a Central de Atendimento.
  if (!remoteJid || remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@newsletter")) return;
  const isGroup = remoteJid.endsWith("@g.us");

  // WhatsApp está migrando contatos para JIDs "@lid" (ID interno, não é o
  // telefone). Se o JID vier como @lid, resolve para o número real (PN);
  // sem isso a resposta seria enviada para um número inexistente.
  if (remoteJid.endsWith("@lid")) {
    const alt = (m.key as { remoteJidAlt?: string } | undefined)?.remoteJidAlt;
    if (alt && alt.endsWith("@s.whatsapp.net")) {
      remoteJid = alt;
    } else {
      try {
        const mapping = (s.sock as unknown as {
          signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } };
        })?.signalRepository?.lidMapping;
        const pn = await mapping?.getPNForLID?.(remoteJid);
        if (pn && pn.endsWith("@s.whatsapp.net")) remoteJid = pn;
      } catch {
        // mantém o @lid — o envio de resposta tratará esse formato
      }
    }
    if (remoteJid.endsWith("@lid")) {
      logger.warn({ remoteJid, sessionKey: s.key }, "Inbound LID sem mapeamento para telefone — usando @lid");
    }
  }
  const msg = m.message;
  if (!msg) return;

  // Reação, edição e apagar (revoke) atualizam a mensagem original em vez de
  // criar uma nova — tratadas à parte do filtro de "invisíveis" abaixo.
  const isReaction = !!msg.reactionMessage;
  const isEdit = msg.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
  const isRevoke = msg.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;

  if (!isReaction && !isEdit && !isRevoke) {
    // Eventos SEM conteúdo visível (voto em enquete, recibos, chaves de
    // criptografia) não viram mensagem — antes chegavam na Central como
    // "(mensagem não suportada)" em cima de qualquer reação. 🙅
    const keys = Object.keys(msg).filter((k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage");
    const INVISIBLE = new Set(["reactionMessage", "protocolMessage", "pollUpdateMessage", "keepInChatMessage", "pinInChatMessage"]);
    if (keys.length === 0 || keys.every((k) => INVISIBLE.has(k))) return;
  }

  const reaction = isReaction && msg.reactionMessage?.key?.id
    ? { targetId: msg.reactionMessage.key.id, emoji: msg.reactionMessage.text ?? "" }
    : undefined;
  const edit = isEdit && msg.protocolMessage?.key?.id
    ? { targetId: msg.protocolMessage.key.id, message: msg.protocolMessage.editedMessage ?? undefined }
    : undefined;
  const revoke = isRevoke && msg.protocolMessage?.key?.id
    ? { targetId: msg.protocolMessage.key.id }
    : undefined;

  // Mídia pode vir embrulhada (mensagem temporária / visualização única /
  // documento com legenda — documentWithCaptionMessage embrulha um
  // documentMessage comum do mesmo jeito que os outros wrappers abaixo).
  const inner = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ?? msg.viewOnceMessageV2?.message ?? msg.documentWithCaptionMessage?.message ?? msg;

  let mediaBase64: string | undefined;
  let mediaMimeType: string | undefined;
  let mediaType: "image" | "video" | "audio" | "doc" | "sticker" | undefined;

  if (inner.imageMessage) {
    mediaType = "image";
    mediaMimeType = inner.imageMessage.mimetype ?? "image/jpeg";
  } else if (inner.stickerMessage) {
    mediaType = "sticker";
    mediaMimeType = inner.stickerMessage.mimetype ?? "image/webp";
  } else if (inner.videoMessage) {
    mediaType = "video";
    mediaMimeType = inner.videoMessage.mimetype ?? "video/mp4";
  } else if (inner.ptvMessage) {
    // Vídeo redondo (nota de vídeo) — é um vídeo comum para o painel.
    mediaType = "video";
    mediaMimeType = inner.ptvMessage.mimetype ?? "video/mp4";
  } else if (inner.audioMessage) {
    mediaType = "audio";
    mediaMimeType = inner.audioMessage.mimetype ?? "audio/ogg";
  } else if (inner.documentMessage) {
    mediaType = "doc";
    mediaMimeType = inner.documentMessage.mimetype ?? "application/octet-stream";
  }

  if (mediaType && s.sock) {
    try {
      const buffer = await downloadMediaMessage(
        m,
        "buffer",
        {},
        {
          logger: logger.child({ module: "baileys-media" }) as never,
          reuploadRequest: s.sock.updateMediaMessage,
        },
      );
      mediaBase64 = (buffer as Buffer).toString("base64");
    } catch (err) {
      // Mantém o TIPO mesmo sem o arquivo: o painel mostra "🎵 Áudio"/"📷 Foto"
      // em vez de "(mensagem não suportada)".
      logger.warn({ err, mediaType }, "Failed to download inbound media — forwarding type without file");
      mediaBase64 = undefined;
    }
  }

  const avatarUrl = await getProfilePicture(s, remoteJid);
  const groupSubject = isGroup ? await getGroupSubject(s, remoteJid) : undefined;

  const payload = {
    sessionKey: s.key,
    isGroupMsg: isGroup,
    data: {
      key: { remoteJid, fromMe: false, id: m.key?.id ?? undefined },
      message: msg,
      pushName: m.pushName ?? undefined,
      groupSubject,
      messageTimestamp:
        typeof m.messageTimestamp === "number" ? m.messageTimestamp : undefined,
      mediaBase64,
      mediaMimeType,
      mediaType,
      avatarUrl,
      reaction,
      edit,
      revoke,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${API_SERVER_URL}/api/chat/webhook/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Secret": BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: body.slice(0, 200), sessionKey: s.key },
        "API rejected forwarded inbound message",
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export interface SessionState {
  sessionKey: string;
  status: ConnectionStatus;
  qr: string | null;
  phone: string | null;
  error: string | null;
}

export function getSessionState(key: string): SessionState | null {
  const s = sessions.get(key);
  if (!s) return null;
  return { sessionKey: s.key, status: s.status, qr: s.qr, phone: s.phone, error: s.error };
}

export function getAllSessionStates(): SessionState[] {
  return [...sessions.values()].map((s) => ({
    sessionKey: s.key,
    status: s.status,
    qr: s.qr,
    phone: s.phone,
    error: s.error,
  }));
}

/** Starts a session. Creates it if it doesn't exist yet. Idempotent: no-op
 *  when the session already has a live socket (open, waiting for QR or
 *  connecting) so repeated calls never spawn parallel sockets. */
export async function startSession(key: string): Promise<void> {
  let s = sessions.get(key);
  if (!s) {
    s = newSession(key);
    sessions.set(key, s);
  }
  s.stopped = false;
  // Already has a live socket (open, showing QR, or handshake in progress) —
  // never spawn a second parallel socket for the same key.
  if (s.sock) return;
  await connectSession(s);
}

/** Disconnects, clears auth and reconnects fresh (new QR) — "trocar número". */
export async function disconnectAndReset(key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) {
    await startSession(key);
    return;
  }
  clearReconnectTimer(s);
  if (s.sock) {
    // Logout first (while creds still exist) so o aparelho antigo é
    // desvinculado no WhatsApp — sem isso, parear um número novo pode falhar.
    try { await Promise.race([s.sock.logout(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* ignore */ }
    try { s.sock.end(undefined); } catch { /* ignore */ }
    s.sock = null;
  }
  await clearAuthState(key);
  s.qr = null;
  s.status = "connecting";
  s.phone = null;
  s.error = null;
  s.reconnectAttempts = 0;
  s.stopped = false;
  await persistStatus(key, "disconnected", null, null);
  void connectSession(s);
}

/** Permanently removes a session: stop socket, clear auth, delete DB row. */
export async function removeSession(key: string): Promise<void> {
  const s = sessions.get(key);
  if (s) {
    s.stopped = true;
    clearReconnectTimer(s);
    if (s.sock) {
      try { s.sock.logout().catch(() => {}); } catch { /* ignore */ }
      try { s.sock.end(undefined); } catch { /* ignore */ }
      s.sock = null;
    }
    sessions.delete(key);
  }
  await clearAuthState(key);
  try {
    await db.delete(whatsappSessionsTable).where(eq(whatsappSessionsTable.sessionKey, key));
  } catch (e) {
    logger.warn({ err: e, sessionKey: key }, "Failed to delete WhatsApp session row");
  }
}

async function connectSession(s: Session): Promise<void> {
  clearReconnectTimer(s);
  if (s.stopped) return;

  try {
    const { state, saveCreds } = await useDatabaseAuthState(s.key);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ module: "baileys", sessionKey: s.key }) as never,
      connectTimeoutMs: 30_000,
    });
    s.sock = sock;

    sock.ev.on("creds.update", () => {
      void saveCreds();
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        forwardInboundMessage(s, m).catch((err) => {
          logger.warn({ err, sessionKey: s.key }, "Failed to forward inbound WhatsApp message");
        });
      }
    });

    sock.ev.on("connection.update", async (update) => {
      // Ignore events from a socket that has been replaced/removed.
      if (s.sock !== sock || s.stopped) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          s.qr = await toDataURL(qr, { margin: 1 });
          s.status = "qr";
          s.error = null;
          logger.info({ sessionKey: s.key }, "QR code generated — scan with WhatsApp");
          await persistStatus(s.key, "qr", null, null);
        } catch (err) {
          logger.error({ err }, "Failed to generate QR data URL");
        }
      }

      if (connection === "open") {
        s.qr = null;
        s.status = "open";
        s.reconnectAttempts = 0;
        const phone = (sock.user?.id ?? "").split(":")[0] ?? null;
        s.phone = phone;
        s.error = null;
        logger.info({ phone, sessionKey: s.key }, "WhatsApp connected via Baileys");
        await persistStatus(s.key, "connected", phone, null);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        logger.warn({ statusCode, isLoggedOut, sessionKey: s.key }, "WhatsApp connection closed");

        if (isLoggedOut) {
          logger.info({ sessionKey: s.key }, "Session logged out — clearing auth state");
          await clearAuthState(s.key);
          s.qr = null;
          s.status = "close";
          s.phone = null;
          s.error = "Sessão encerrada (logged out). Escaneie o QR novamente.";
          await persistStatus(s.key, "disconnected", null, s.error);
          s.reconnectAttempts = 0;
          // Reconnect fresh to get new QR
          s.reconnectTimer = setTimeout(() => void connectSession(s), 2000);
        } else {
          s.status = "connecting";
          s.error = `Desconectado (código ${statusCode ?? "?"}). Reconectando…`;
          await persistStatus(s.key, "reconnecting", s.phone, s.error);

          const delay = Math.min(1000 * 2 ** s.reconnectAttempts, 30_000);
          s.reconnectAttempts++;
          logger.info({ delay, attempt: s.reconnectAttempts, sessionKey: s.key }, "Scheduling reconnect");
          s.reconnectTimer = setTimeout(() => void connectSession(s), delay);
        }
      }
    });
  } catch (err) {
    s.error = err instanceof Error ? err.message : String(err);
    s.status = "close";
    logger.error({ err, sessionKey: s.key }, "Failed to create WhatsApp socket");
    await persistStatus(s.key, "error", null, s.error);

    const delay = Math.min(1000 * 2 ** s.reconnectAttempts, 30_000);
    s.reconnectAttempts++;
    s.reconnectTimer = setTimeout(() => void connectSession(s), delay);
  }
}

/**
 * Starts every session registered in whatsapp_sessions. If none exist,
 * creates and starts the "default" session (backwards compatible).
 */
export async function connectAll(): Promise<void> {
  let keys: string[] = [];
  try {
    const rows = await db.select({ sessionKey: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable);
    keys = rows.map((r) => r.sessionKey);
  } catch (e) {
    logger.warn({ err: e }, "Failed to load WhatsApp sessions from DB — starting default only");
  }
  if (keys.length === 0) keys = [DEFAULT_SESSION_KEY];
  for (const key of keys) {
    void startSession(key);
  }
}

// ─── Anti-ban: fila de envio com ritmo humano (por sessão) ──────────────────
async function humanPacing(s: Session, jid: string, textLength: number): Promise<void> {
  const sinceLast = Date.now() - s.lastSendAt;
  const minGap = MIN_GAP_BASE_MS + Math.random() * MIN_GAP_JITTER_MS;
  if (sinceLast < minGap) await sleep(minGap - sinceLast);

  // Simula "digitando…" — ignora falhas de presença (não são críticas).
  try {
    if (s.sock && s.status === "open") {
      await s.sock.presenceSubscribe(jid);
      await s.sock.sendPresenceUpdate("composing", jid);
      const typing = Math.min(textLength * TYPING_MS_PER_CHAR, TYPING_MAX_MS);
      await sleep(400 + typing * (0.6 + Math.random() * 0.4));
      await s.sock.sendPresenceUpdate("paused", jid);
    }
  } catch {
    /* presença é opcional */
  }
}

// Se o job ficar tempo demais esperando na fila, o api-server já desistiu
// (timeout de 60s) e marcou a mensagem como falha — o atendente vai reenviar.
// Enviar mesmo assim geraria mensagem DUPLICADA no cliente. Melhor descartar.
const QUEUE_WAIT_MAX_MS = 50_000;

/**
 * Conexão "zumbi": o status fica "open" mas o WebSocket por baixo já morreu
 * (rede caiu sem o evento de close chegar). Sintoma: painel mostra
 * "Conectado" mas nenhuma mensagem sai. Aqui detectamos e reconectamos.
 */
function bounceSession(s: Session, reason: string): void {
  logger.warn({ sessionKey: s.key, reason }, "Reiniciando socket do WhatsApp (conexão zumbi?)");
  clearReconnectTimer(s);
  if (s.sock) {
    try { s.sock.end(undefined); } catch { /* ignore */ }
    s.sock = null;
  }
  s.status = "connecting";
  s.error = "Reconectando após falha de envio…";
  void persistStatus(s.key, "reconnecting", s.phone, s.error).catch(() => {});
  s.reconnectTimer = setTimeout(() => void connectSession(s), 1000);
}

function ensureSocketAlive(s: Session): void {
  const ws = (s.sock as unknown as { ws?: { isOpen?: boolean } } | null)?.ws;
  if (!s.sock || (ws && ws.isOpen === false)) {
    bounceSession(s, "WebSocket fechado detectado antes do envio");
    throw new Error("WhatsApp caiu e está reconectando — tente novamente em instantes.");
  }
}

function enqueueSend(s: Session, jid: string, textLength: number, fn: () => Promise<void>): Promise<void> {
  const enqueuedAt = Date.now();
  const run = s.sendChain.then(async () => {
    if (Date.now() - enqueuedAt > QUEUE_WAIT_MAX_MS) {
      throw new Error("Envio descartado: esperou tempo demais na fila (evita duplicar mensagem)");
    }
    try {
      await withTimeout(
        (async () => {
          await ensureSocketAlive(s);
          await humanPacing(s, jid, textLength);
          // Checagem final: se entre a fila e a "digitação" o prazo total estourou,
          // o api-server já marcou como falha — não envia para não duplicar.
          if (Date.now() - enqueuedAt > QUEUE_WAIT_MAX_MS) {
            throw new Error("Envio descartado: prazo total excedido (evita duplicar mensagem)");
          }
          await fn();
        })(),
        SEND_JOB_TIMEOUT_MS,
        "Envio WhatsApp",
      );
    } catch (err) {
      // Envio expirou com status "open"? Provável conexão zumbi — derruba e reconecta.
      if (err instanceof Error && err.message.includes("tempo esgotado") && s.status === "open") {
        bounceSession(s, "envio expirou com conexão aparentemente aberta");
      }
      throw err;
    } finally {
      s.lastSendAt = Date.now();
    }
  });
  // A fila nunca deve travar por causa de um envio que falhou ou expirou.
  s.sendChain = run.catch(() => {});
  return run;
}

function requireOpenSession(key: string): Session {
  const s = sessions.get(key);
  if (!s || !s.sock || s.status !== "open") {
    throw new Error(`WhatsApp não está conectado (conexão "${key}")`);
  }
  return s;
}

/**
 * Monta o JID de destino. Contatos migrados pelo WhatsApp podem estar salvos
 * como ID interno ("...@lid"); nesse caso o envio precisa usar o formato @lid —
 * transformar em número comum enviaria para um telefone inexistente.
 * (ver toJid abaixo)
 *
 * Converte qualquer áudio para ogg/opus mono 48kHz via ffmpeg — o único
 * formato que o WhatsApp reproduz de forma confiável como nota de voz.
 */
function toOggOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-ac", "1",
      "-ar", "48000",
      "-f", "ogg",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => errChunks.push(c));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0 && out.length > 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg saiu com código ${code}: ${Buffer.concat(errChunks).toString().slice(-400)}`));
    });
    const t = setTimeout(() => { ff.kill("SIGKILL"); reject(new Error("ffmpeg timeout (20s)")); }, 20_000);
    ff.on("close", () => clearTimeout(t));
    ff.stdin.on("error", () => { /* EPIPE se o ffmpeg morrer antes */ });
    ff.stdin.end(input);
  });
}

function toJid(to: string): string {
  // Grupos/comunidades: o "telefone" da conversa é o próprio JID completo.
  if (to.includes("@g.us")) return to.trim();
  const digits = to.replace(/\D/g, "");
  if (!digits) throw new Error(`Destino de envio inválido: "${to}"`);
  return to.includes("@lid") ? `${digits}@lid` : `${digits}@s.whatsapp.net`;
}

// Números digitados à mão (atendimento criado manualmente) muitas vezes não
// batem com o JID real: nono dígito brasileiro a mais/a menos, DDI faltando…
// Enviar para digits@s.whatsapp.net inexistente FALHA EM SILÊNCIO no Baileys.
// Por isso, para números simples, confirmamos com o WhatsApp qual é o JID
// certo via onWhatsApp() — e recusamos com erro claro se o número não existir.
const jidCache = new Map<string, string>();

async function resolveJid(s: Session, to: string): Promise<string> {
  // Grupos e @lid já vêm em formato final — não passam por onWhatsApp.
  if (to.includes("@g.us") || to.includes("@lid")) return toJid(to);
  const digits = to.replace(/\D/g, "");
  if (!digits) throw new Error(`Destino de envio inválido: "${to}"`);
  const cached = jidCache.get(digits);
  if (cached) return cached;
  const candidates = [digits];
  // Brasil sem DDI: usuário digitou só DDD+número (10–11 dígitos) → tenta com 55.
  if (digits.length === 10 || digits.length === 11) candidates.push(`55${digits}`);
  for (const cand of candidates) {
    try {
      const results = await s.sock!.onWhatsApp(cand);
      const hit = results?.find((r) => r.exists && r.jid);
      if (hit?.jid) {
        jidCache.set(digits, hit.jid);
        if (hit.jid !== `${cand}@s.whatsapp.net`) {
          logger.info({ typed: digits, resolved: hit.jid, sessionKey: s.key }, "JID resolvido via onWhatsApp (número normalizado)");
        }
        return hit.jid;
      }
    } catch (err) {
      // onWhatsApp indisponível: cai no formato direto em vez de bloquear tudo.
      logger.warn({ err, cand, sessionKey: s.key }, "onWhatsApp falhou — enviando no formato direto");
      return toJid(to);
    }
  }
  throw new Error(`O número ${digits} não está no WhatsApp — confira o DDD/DDI e o nono dígito`);
}

/**
 * Verifica se um número existe no WhatsApp (usado ao criar atendimento manual).
 * Lança erro se a sessão não estiver conectada ou o onWhatsApp falhar — o
 * chamador decide se bloqueia ou libera nesses casos.
 */
export async function checkNumber(key: string, to: string): Promise<{ exists: boolean; jid?: string }> {
  const s = requireOpenSession(key);
  const digits = to.replace(/\D/g, "");
  if (!digits) return { exists: false };
  const cached = jidCache.get(digits);
  if (cached) return { exists: true, jid: cached };
  const candidates = [digits];
  if (digits.length === 10 || digits.length === 11) candidates.push(`55${digits}`);
  for (const cand of candidates) {
    const results = await s.sock!.onWhatsApp(cand);
    const hit = results?.find((r) => r.exists && r.jid);
    if (hit?.jid) {
      jidCache.set(digits, hit.jid);
      return { exists: true, jid: hit.jid };
    }
  }
  return { exists: false };
}

export async function sendMessage(key: string, to: string, text: string): Promise<void> {
  const s = requireOpenSession(key);
  const phone = to.replace(/\D/g, "");
  const jid = await resolveJid(s, to);
  await enqueueSend(s, jid, text.length, async () => {
    const cur = requireOpenSession(key);
    await cur.sock!.sendMessage(jid, { text });
  });
  logger.info({ phone, sessionKey: key }, "WhatsApp message sent via Baileys");
}

export async function sendMedia(
  key: string,
  to: string,
  type: "image" | "video" | "audio" | "document",
  buffer: Buffer,
  mimetype: string,
  filename?: string,
  caption?: string,
  ptt?: boolean,
): Promise<void> {
  const s = requireOpenSession(key);
  const phone = to.replace(/\D/g, "");
  const jid = await resolveJid(s, to);
  await enqueueSend(s, jid, caption?.length ?? 30, async () => {
    const cur = requireOpenSession(key);
    if (type === "image") {
      await cur.sock!.sendMessage(jid, { image: buffer, mimetype, caption });
    } else if (type === "video") {
      await cur.sock!.sendMessage(jid, { video: buffer, mimetype, caption });
    } else if (type === "audio") {
      // O WhatsApp só toca áudio de forma confiável em ogg/opus. Gravações do
      // navegador vêm em webm/mp4 — apenas renomear o tipo corrompe o arquivo
      // ("algo errado com o arquivo de áudio"). Converte de verdade com ffmpeg.
      let audio = buffer;
      let audioMime = mimetype;
      const alreadyOgg = /audio\/ogg/i.test(mimetype);
      if (!alreadyOgg) {
        try {
          audio = await toOggOpus(buffer);
          audioMime = "audio/ogg; codecs=opus";
        } catch (err) {
          logger.warn({ err }, "ffmpeg falhou ao converter áudio — enviando original");
        }
      } else {
        audioMime = "audio/ogg; codecs=opus";
      }
      await cur.sock!.sendMessage(jid, {
        audio,
        mimetype: audioMime,
        ptt: ptt ?? false,
      });
    } else {
      await cur.sock!.sendMessage(jid, {
        document: buffer,
        mimetype,
        fileName: filename ?? "documento",
        caption,
      });
    }
  });
  logger.info({ phone, type, sessionKey: key }, "WhatsApp media sent via Baileys");
}
