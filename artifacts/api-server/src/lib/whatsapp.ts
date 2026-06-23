import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import { rm } from "fs/promises";
import { logger } from "./logger";
import { processInboundWA } from "./whatsappInbound";

export interface WAState {
  status: "disconnected" | "qr" | "connecting" | "connected";
  qr: string | null;
  phoneNumber: string | null;
}

const state: WAState = {
  status: "disconnected",
  qr: null,
  phoneNumber: null,
};

let sock: WASocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isStarting = false;
let rawQRString: string | null = null;

const artifactDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSION_DIR = path.resolve(artifactDir, "sessions", "default");

export async function startSession(): Promise<void> {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const baileysLogger = logger.child({ module: "baileys" });

    sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: baileysLogger as unknown as Parameters<typeof makeWASocket>[0]["logger"],
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          rawQRString = qr;
          state.qr = await QRCode.toDataURL(qr);
          state.status = "qr";
          logger.info("WhatsApp QR code generated");
        } catch (err) {
          logger.error({ err }, "Failed to generate QR code");
        }
      }

      if (connection === "close") {
        const errorCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = errorCode !== DisconnectReason.loggedOut;
        state.status = "disconnected";
        state.qr = null;
        state.phoneNumber = null;
        rawQRString = null;
        logger.info({ errorCode, shouldReconnect }, "WhatsApp connection closed");

        if (shouldReconnect) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(async () => {
            isStarting = false;
            await startSession();
          }, 5000);
        } else {
          isStarting = false;
        }
      } else if (connection === "connecting") {
        state.status = "connecting";
      } else if (connection === "open") {
        state.status = "connected";
        state.qr = null;
        state.phoneNumber = sock?.user?.id?.split(":")[0]?.split("@")[0] ?? null;
        logger.info({ phone: state.phoneNumber }, "WhatsApp connected");
        isStarting = false;
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;

        try {
          await processInboundWA({
            event: "messages.upsert",
            data: {
              key: {
                remoteJid: msg.key.remoteJid ?? undefined,
                fromMe: msg.key.fromMe ?? undefined,
                id: msg.key.id ?? undefined,
              },
              message: msg.message as {
                conversation?: string;
                extendedTextMessage?: { text?: string };
                imageMessage?: { caption?: string };
              },
              pushName: msg.pushName ?? "",
              messageTimestamp: typeof msg.messageTimestamp === "number"
                ? msg.messageTimestamp
                : Number(msg.messageTimestamp ?? 0),
            },
          });
        } catch (err) {
          logger.error({ err }, "Failed to process inbound WhatsApp message");
        }
      }
    });
  } catch (err) {
    logger.error({ err }, "WhatsApp startSession error");
    isStarting = false;
  }
}

export function getWAState(): WAState {
  return { ...state };
}

export function getRawQR(): string | null {
  return rawQRString;
}

export async function sendWAMessage(to: string, text: string): Promise<void> {
  if (!sock || state.status !== "connected") {
    throw new Error("WhatsApp não conectado");
  }
  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

export async function disconnectWA(andRestart = false): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try {
      await sock.logout();
    } catch {
      try { sock.end(undefined); } catch { /* ignore */ }
    }
    sock = null;
  }
  state.status = "disconnected";
  state.qr = null;
  state.phoneNumber = null;
  isStarting = false;

  try {
    await rm(SESSION_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }

  logger.info("WhatsApp disconnected and session cleared");

  if (andRestart) {
    setTimeout(() => void startSession(), 500);
  }
}
