/**
 * Baileys WhatsApp connection manager.
 * - Loads auth state from PostgreSQL on startup → auto-reconnects without QR
 * - Emits QR code as base64 PNG when not authenticated
 * - Persists credential updates back to DB after every auth update
 * - Reconnects automatically on disconnection using exponential backoff
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

const SESSION_KEY = "default";

const API_SERVER_URL = process.env["API_SERVER_URL"] ?? "http://localhost:80";

const SESSION_SECRET_SEED =
  process.env["SESSION_SECRET"] ??
  (process.env["NODE_ENV"] === "production"
    ? (() => { throw new Error("SESSION_SECRET env var is required in production"); })()
    : "sheikcell-dev-only-secret");
const BRIDGE_SECRET = createHmac("sha256", SESSION_SECRET_SEED)
  .update("whatsapp-bridge-v1")
  .digest("hex");

/**
 * Forwards an inbound Baileys message to the API server's webhook so it gets
 * persisted and broadcast to the attendance UI. Skips own/group/broadcast
 * messages. Downloads image/audio/document media as base64.
 */
async function forwardInboundMessage(m: WAMessage): Promise<void> {
  if (m.key?.fromMe) return;
  const remoteJid = m.key?.remoteJid ?? "";
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;
  const msg = m.message;
  if (!msg) return;

  let mediaBase64: string | undefined;
  let mediaMimeType: string | undefined;
  let mediaType: "image" | "audio" | "doc" | undefined;

  if (msg.imageMessage) {
    mediaType = "image";
    mediaMimeType = msg.imageMessage.mimetype ?? "image/jpeg";
  } else if (msg.audioMessage) {
    mediaType = "audio";
    mediaMimeType = msg.audioMessage.mimetype ?? "audio/ogg";
  } else if (msg.documentMessage) {
    mediaType = "doc";
    mediaMimeType = msg.documentMessage.mimetype ?? "application/octet-stream";
  }

  if (mediaType) {
    try {
      const buffer = await downloadMediaMessage(
        m,
        "buffer",
        {},
        {
          logger: logger.child({ module: "baileys-media" }) as never,
          reuploadRequest: sock!.updateMediaMessage,
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
        { status: res.status, body: body.slice(0, 200) },
        "API rejected forwarded inbound message",
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

let sock: WASocket | null = null;
let currentQR: string | null = null;
let connectionStatus: ConnectionStatus = "connecting";
let connectedPhone: string | null = null;
let lastError: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function persistStatus(
  status: string,
  phoneNumber: string | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    const isConnected = status === "connected";
    await db
      .insert(whatsappSessionsTable)
      .values({
        sessionKey: SESSION_KEY,
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
    logger.warn({ err: e }, "Failed to persist WhatsApp session status to DB");
  }
}

export function getConnectionState(): {
  status: ConnectionStatus;
  qr: string | null;
  phone: string | null;
  error: string | null;
} {
  return {
    status: connectionStatus,
    qr: currentQR,
    phone: connectedPhone,
    error: lastError,
  };
}

export async function disconnectAndReset(): Promise<void> {
  clearReconnectTimer();
  await clearAuthState(SESSION_KEY);
  if (sock) {
    try { sock.end(undefined); } catch { /* ignore */ }
    sock = null;
  }
  currentQR = null;
  connectionStatus = "connecting";
  connectedPhone = null;
  lastError = null;
  reconnectAttempts = 0;
  await persistStatus("disconnected", null, null);
  void connect();
}

export async function connect(): Promise<void> {
  clearReconnectTimer();

  try {
    const { state, saveCreds } = await useDatabaseAuthState(SESSION_KEY);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ module: "baileys" }) as never,
      connectTimeoutMs: 30_000,
    });

    sock.ev.on("creds.update", () => {
      void saveCreds();
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        forwardInboundMessage(m).catch((err) => {
          logger.warn({ err }, "Failed to forward inbound WhatsApp message");
        });
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQR = await toDataURL(qr, { margin: 1 });
          connectionStatus = "qr";
          lastError = null;
          logger.info("QR code generated — scan with WhatsApp");
          await persistStatus("qr", null, null);
        } catch (err) {
          logger.error({ err }, "Failed to generate QR data URL");
        }
      }

      if (connection === "open") {
        currentQR = null;
        connectionStatus = "open";
        reconnectAttempts = 0;
        const phone = (sock?.user?.id ?? "").split(":")[0] ?? null;
        connectedPhone = phone;
        lastError = null;
        logger.info({ phone }, "WhatsApp connected via Baileys");
        await persistStatus("connected", phone, null);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        logger.warn({ statusCode, isLoggedOut }, "WhatsApp connection closed");

        if (isLoggedOut) {
          logger.info("Session logged out — clearing auth state");
          await clearAuthState(SESSION_KEY);
          currentQR = null;
          connectionStatus = "close";
          connectedPhone = null;
          lastError = "Sessão encerrada (logged out). Escaneie o QR novamente.";
          await persistStatus("disconnected", null, lastError);
          reconnectAttempts = 0;
          // Reconnect fresh to get new QR
          reconnectTimer = setTimeout(() => void connect(), 2000);
        } else {
          connectionStatus = "connecting";
          lastError = `Desconectado (código ${statusCode ?? "?"}). Reconectando…`;
          await persistStatus("reconnecting", connectedPhone, lastError);

          const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
          reconnectAttempts++;
          logger.info({ delay, attempt: reconnectAttempts }, "Scheduling reconnect");
          reconnectTimer = setTimeout(() => void connect(), delay);
        }
      }
    });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    connectionStatus = "close";
    logger.error({ err }, "Failed to create WhatsApp socket");
    await persistStatus("error", null, lastError);

    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => void connect(), delay);
  }
}

// ─── Anti-ban: fila de envio com ritmo humano ────────────────────────────────
// Números que disparam mensagens em rajada (sem intervalo e sem "digitando")
// são sinalizados como automação e podem ser banidos. Todo envio passa por uma
// fila única que:
//   1. garante um intervalo mínimo aleatório entre envios consecutivos;
//   2. simula presença ("digitando…") proporcional ao tamanho do texto.
const MIN_GAP_BASE_MS = 1500;   // intervalo mínimo entre envios
const MIN_GAP_JITTER_MS = 1500; // + variação aleatória (1.5s a 3s no total)
const TYPING_MS_PER_CHAR = 45;  // velocidade de "digitação" simulada
const TYPING_MAX_MS = 4000;     // teto para não travar a fila

let sendChain: Promise<void> = Promise.resolve();
let lastSendAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanPacing(jid: string, textLength: number): Promise<void> {
  const sinceLast = Date.now() - lastSendAt;
  const minGap = MIN_GAP_BASE_MS + Math.random() * MIN_GAP_JITTER_MS;
  if (sinceLast < minGap) await sleep(minGap - sinceLast);

  // Simula "digitando…" — ignora falhas de presença (não são críticas).
  try {
    if (sock && connectionStatus === "open") {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);
      const typing = Math.min(textLength * TYPING_MS_PER_CHAR, TYPING_MAX_MS);
      await sleep(400 + typing * (0.6 + Math.random() * 0.4));
      await sock.sendPresenceUpdate("paused", jid);
    }
  } catch {
    /* presença é opcional */
  }
}

const SEND_JOB_TIMEOUT_MS = 45_000; // watchdog: um envio travado não pode parar a fila

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: tempo esgotado (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function enqueueSend(jid: string, textLength: number, fn: () => Promise<void>): Promise<void> {
  const run = sendChain.then(async () => {
    try {
      await withTimeout(
        (async () => {
          await humanPacing(jid, textLength);
          await fn();
        })(),
        SEND_JOB_TIMEOUT_MS,
        "Envio WhatsApp",
      );
    } finally {
      lastSendAt = Date.now();
    }
  });
  // A fila nunca deve travar por causa de um envio que falhou ou expirou.
  sendChain = run.catch(() => {});
  return run;
}

export async function sendMessage(to: string, text: string): Promise<void> {
  if (!sock || connectionStatus !== "open") {
    throw new Error("WhatsApp não está conectado");
  }
  const phone = to.replace(/\D/g, "");
  const jid = `${phone}@s.whatsapp.net`;
  await enqueueSend(jid, text.length, async () => {
    if (!sock || connectionStatus !== "open") {
      throw new Error("WhatsApp não está conectado");
    }
    await sock.sendMessage(jid, { text });
  });
  logger.info({ phone }, "WhatsApp message sent via Baileys");
}

export async function sendMedia(
  to: string,
  type: "image" | "document",
  buffer: Buffer,
  mimetype: string,
  filename?: string,
  caption?: string,
): Promise<void> {
  if (!sock || connectionStatus !== "open") {
    throw new Error("WhatsApp não está conectado");
  }
  const phone = to.replace(/\D/g, "");
  const jid = `${phone}@s.whatsapp.net`;
  await enqueueSend(jid, caption?.length ?? 30, async () => {
    if (!sock || connectionStatus !== "open") {
      throw new Error("WhatsApp não está conectado");
    }
    if (type === "image") {
      await sock.sendMessage(jid, { image: buffer, mimetype, caption });
    } else {
      await sock.sendMessage(jid, {
        document: buffer,
        mimetype,
        fileName: filename ?? "documento",
        caption,
      });
    }
  });
  logger.info({ phone, type }, "WhatsApp media sent via Baileys");
}
