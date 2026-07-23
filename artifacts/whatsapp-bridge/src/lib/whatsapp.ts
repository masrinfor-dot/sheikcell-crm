/**
 * Public interface for WhatsApp status and sending — multi-session.
 * Delegates to the Baileys connection manager (waConnection.ts).
 * The Meta Cloud API is kept as a secondary send path for the DEFAULT session
 * only, when env vars are set and Baileys is not connected.
 */
import { logger } from "./logger";
import {
  getSessionState,
  sendMessage as baileysSend,
  sendMedia as baileysSendMedia,
  DEFAULT_SESSION_KEY,
} from "./waConnection";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

export type WAMode = "baileys" | "meta";

export interface WAState {
  sessionKey: string;
  mode: WAMode;
  status: "connected" | "qr" | "connecting" | "reconnecting" | "disconnected" | "unconfigured";
  phoneNumber: string | null;
  phoneId: string | null;
  qrDataUrl: string | null;
  errorMessage: string | null;
}

function getMetaConfig() {
  return {
    phoneId: process.env["META_WHATSAPP_PHONE_ID"] ?? null,
    accessToken: process.env["META_WHATSAPP_ACCESS_TOKEN"] ?? null,
  };
}

let cachedPhoneNumber: string | null = null;
let phoneCacheExpiry = 0;

async function fetchMetaPhoneNumber(phoneId: string, accessToken: string): Promise<string | null> {
  const now = Date.now();
  if (cachedPhoneNumber !== null && now < phoneCacheExpiry) return cachedPhoneNumber;
  try {
    const res = await fetch(
      `${GRAPH_API_BASE}/${phoneId}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { display_phone_number?: string };
    cachedPhoneNumber = data.display_phone_number ?? null;
    phoneCacheExpiry = now + 5 * 60 * 1000;
    return cachedPhoneNumber;
  } catch {
    return null;
  }
}

export async function getWAState(sessionKey: string = DEFAULT_SESSION_KEY): Promise<WAState> {
  const bail = getSessionState(sessionKey);

  if (!bail) {
    return {
      sessionKey,
      mode: "baileys",
      status: "unconfigured",
      phoneNumber: null,
      phoneId: null,
      qrDataUrl: null,
      errorMessage: "Conexão não encontrada",
    };
  }

  if (bail.status === "open") {
    return {
      sessionKey,
      mode: "baileys",
      status: "connected",
      phoneNumber: bail.phone,
      phoneId: null,
      qrDataUrl: null,
      errorMessage: null,
    };
  }

  if (bail.status === "qr") {
    return {
      sessionKey,
      mode: "baileys",
      status: "qr",
      phoneNumber: null,
      phoneId: null,
      qrDataUrl: bail.qr,
      errorMessage: null,
    };
  }

  if (bail.status === "close") {
    // Meta Cloud API fallback applies only to the default session.
    if (sessionKey === DEFAULT_SESSION_KEY) {
      const { phoneId, accessToken } = getMetaConfig();
      if (phoneId && accessToken) {
        const phoneNumber = await fetchMetaPhoneNumber(phoneId, accessToken);
        if (phoneNumber) {
          return {
            sessionKey,
            mode: "meta",
            status: "connected",
            phoneNumber,
            phoneId,
            qrDataUrl: null,
            errorMessage: null,
          };
        }
      }
    }
    return {
      sessionKey,
      mode: "baileys",
      status: "disconnected",
      phoneNumber: null,
      phoneId: null,
      qrDataUrl: null,
      errorMessage: bail.error,
    };
  }

  // "connecting" / reconnecting state
  return {
    sessionKey,
    mode: "baileys",
    status: "connecting",
    phoneNumber: null,
    phoneId: null,
    qrDataUrl: null,
    errorMessage: bail.error,
  };
}

export async function sendWAMedia(
  sessionKey: string,
  to: string,
  type: "image" | "video" | "audio" | "document",
  buffer: Buffer,
  mimetype: string,
  filename?: string,
  caption?: string,
  ptt?: boolean,
): Promise<void> {
  await baileysSendMedia(sessionKey, to, type, buffer, mimetype, filename, caption, ptt);
}

export async function sendWAMessage(sessionKey: string, to: string, text: string): Promise<void> {
  const bail = getSessionState(sessionKey);

  if (bail?.status === "open") {
    await baileysSend(sessionKey, to, text);
    return;
  }

  // Fallback to Meta Cloud API — default session only.
  if (sessionKey !== DEFAULT_SESSION_KEY) {
    throw new Error(`WhatsApp não está conectado (conexão "${sessionKey}")`);
  }
  const { phoneId, accessToken } = getMetaConfig();
  if (!phoneId || !accessToken) {
    throw new Error("WhatsApp não está conectado (Baileys desconectado e Meta API não configurada)");
  }
  const phone = to.replace(/\D/g, "");
  const url = `${GRAPH_API_BASE}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Meta API error ${res.status}: ${body}`);
  }
  logger.info({ phone }, "WhatsApp message sent via Meta Cloud API (Baileys fallback)");
}
