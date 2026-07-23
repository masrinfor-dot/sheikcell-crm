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
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";
import { createHmac } from "node:crypto";
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

async function persistStatus(
  key: string,
  status: string,
  phoneNumber: string | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    const isConnected = status === "connected";
    await db
      .insert(whatsappSessionsTable)
      .values({
        sessionKey: key,
        status,
        phoneNumber,
        phoneId: null,
        errorMessage,
        lastHeartbeatAt: isConnected ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: whatsappSessionsTable.sessionKey,
        set: {
          status,
          phoneNumber,
          errorMessage,
          lastHeartbeatAt: isConnected ? new Date() : undefined,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    logger.warn({ err: e, sessionKey: key }, "Failed to persist WhatsApp session status to DB");
  }
}

/**
 * Forwards an inbound Baileys message to the API server's webhook so it gets
 * persisted and broadcast to the attendance UI. Includes the sessionKey so the
 * conversation is tied to the WhatsApp number that received it.
 */
async function forwardInboundMessage(s: Session, m: WAMessage): Promise<void> {
  if (m.key?.fromMe) return;
  const remoteJid = m.key?.remoteJid ?? "";
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;
  const msg = m.message;
  if (!msg) return;

  let mediaBase64: string | undefined;
  let mediaMimeType: string | undefined;
  let mediaType: "image" | "video" | "audio" | "doc" | undefined;

  if (msg.imageMessage) {
    mediaType = "image";
    mediaMimeType = msg.imageMessage.mimetype ?? "image/jpeg";
  } else if (msg.videoMessage) {
    mediaType = "video";
    mediaMimeType = msg.videoMessage.mimetype ?? "video/mp4";
  } else if (msg.audioMessage) {
    mediaType = "audio";
    mediaMimeType = msg.audioMessage.mimetype ?? "audio/ogg";
  } else if (msg.documentMessage) {
    mediaType = "doc";
    mediaMimeType = msg.documentMessage.mimetype ?? "application/octet-stream";
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
      logger.warn({ err }, "Failed to download inbound media — forwarding without it");
      mediaType = undefined;
      mediaMimeType = undefined;
    }
  }

  const payload = {
    sessionKey: s.key,
    data: {
      key: { remoteJid, fromMe: false, id: m.key?.id ?? undefined },
      message: msg,
      pushName: m.pushName ?? undefined,
      messageTimestamp:
        typeof m.messageTimestamp === "number" ? m.messageTimestamp : undefined,
      mediaBase64,
      mediaMimeType,
      mediaType,
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
  await clearAuthState(key);
  if (s.sock) {
    try { s.sock.end(undefined); } catch { /* ignore */ }
    s.sock = null;
  }
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

function enqueueSend(s: Session, jid: string, textLength: number, fn: () => Promise<void>): Promise<void> {
  const run = s.sendChain.then(async () => {
    try {
      await withTimeout(
        (async () => {
          await humanPacing(s, jid, textLength);
          await fn();
        })(),
        SEND_JOB_TIMEOUT_MS,
        "Envio WhatsApp",
      );
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

export async function sendMessage(key: string, to: string, text: string): Promise<void> {
  const s = requireOpenSession(key);
  const phone = to.replace(/\D/g, "");
  const jid = `${phone}@s.whatsapp.net`;
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
  const jid = `${phone}@s.whatsapp.net`;
  await enqueueSend(s, jid, caption?.length ?? 30, async () => {
    const cur = requireOpenSession(key);
    if (type === "image") {
      await cur.sock!.sendMessage(jid, { image: buffer, mimetype, caption });
    } else if (type === "video") {
      await cur.sock!.sendMessage(jid, { video: buffer, mimetype, caption });
    } else if (type === "audio") {
      // Nota de voz (ptt): o WhatsApp espera ogg/opus — gravações do navegador
      // são webm/opus, e anunciar como ogg/opus é a prática comum com Baileys.
      await cur.sock!.sendMessage(jid, {
        audio: buffer,
        mimetype: ptt ? "audio/ogg; codecs=opus" : mimetype,
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
