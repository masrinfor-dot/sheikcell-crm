/**
 * Public interface for WhatsApp status and sending.
 * Delegates to the Baileys connection manager (waConnection.ts).
 * The Meta Cloud API is kept as a secondary send path when env vars are set
 * and Baileys is not connected, so the system degrades gracefully.
 */
import { logger } from "./logger";
import { getConnectionState, sendMessage as baileysSend, sendMedia as baileysSendMedia } from "./waConnection";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

export type WAMode = "baileys" | "meta";

export interface WAState {
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

export async function getWAState(): Promise<WAState> {
  const bail = getConnectionState();

  if (bail.status === "open") {
    return {
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
      mode: "baileys",
      status: "qr",
      phoneNumber: null,
      phoneId: null,
      qrDataUrl: bail.qr,
      errorMessage: null,
    };
  }

  if (bail.status === "connecting") {
    return {
      mode: "baileys",
      status: "connecting",
      phoneNumber: null,
      phoneId: null,
      qrDataUrl: null,
      errorMessage: bail.error,
    };
  }

  if (bail.status === "close") {
    // Check if Meta Cloud API can cover
    const { phoneId, accessToken } = getMetaConfig();
    if (phoneId && accessToken) {
      const phoneNumber = await fetchMetaPhoneNumber(phoneId, accessToken);
      if (phoneNumber) {
        return {
          mode: "meta",
          status: "connected",
          phoneNumber,
          phoneId,
          qrDataUrl: null,
          errorMessage: null,
        };
      }
    }
    return {
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
    mode: "baileys",
    status: "connecting",
    phoneNumber: null,
    phoneId: null,
    qrDataUrl: null,
    errorMessage: bail.error,
  };
}

export async function sendWAMedia(
  to: string,
  type: "image" | "document",
  buffer: Buffer,
  mimetype: string,
  filename?: string,
): Promise<void> {
  const bail = getConnectionState();
  if (bail.status !== "open") {
    throw new Error("WhatsApp não está conectado (Baileys). Envio de mídia requer conexão Baileys ativa.");
  }
  await baileysSendMedia(to, type, buffer, mimetype, filename);
}

export async function sendWAMessage(to: string, text: string): Promise<void> {
  const bail = getConnectionState();

  if (bail.status === "open") {
    await baileysSend(to, text);
    return;
  }

  // Fallback to Meta Cloud API
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
