/**
 * Baileys WhatsApp connection manager.
 * - Loads auth state from PostgreSQL on startup → auto-reconnects without QR
 * - Emits QR code as base64 PNG when not authenticated
 * - Persists credential updates back to DB after every auth update
 * - Reconnects automatically on disconnection using exponential backoff
 */
import makeWASocket, { DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";
import { logger } from "./logger";
import { useDatabaseAuthState, clearAuthState } from "./dbAuthState";
import { db, whatsappSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

type ConnectionStatus = "connecting" | "open" | "close" | "qr";

const SESSION_KEY = "default";

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

export async function sendMessage(to: string, text: string): Promise<void> {
  if (!sock || connectionStatus !== "open") {
    throw new Error("WhatsApp não está conectado");
  }
  const phone = to.replace(/\D/g, "");
  const jid = `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  logger.info({ phone }, "WhatsApp message sent via Baileys");
}

export async function sendMedia(
  to: string,
  type: "image" | "document",
  buffer: Buffer,
  mimetype: string,
  filename?: string,
): Promise<void> {
  if (!sock || connectionStatus !== "open") {
    throw new Error("WhatsApp não está conectado");
  }
  const phone = to.replace(/\D/g, "");
  const jid = `${phone}@s.whatsapp.net`;
  if (type === "image") {
    await sock.sendMessage(jid, { image: buffer, mimetype });
  } else {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype,
      fileName: filename ?? "documento",
    });
  }
  logger.info({ phone, type }, "WhatsApp media sent via Baileys");
}
