import { logger } from "./logger";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

export interface WAState {
  status: "configured" | "unconfigured";
  phoneNumber: string | null;
  phoneId: string | null;
}

function getMetaConfig() {
  return {
    phoneId: process.env["META_WHATSAPP_PHONE_ID"] ?? null,
    accessToken: process.env["META_WHATSAPP_ACCESS_TOKEN"] ?? null,
  };
}

let cachedPhoneNumber: string | null = null;
let phoneCacheExpiry = 0;

async function fetchDisplayPhoneNumber(phoneId: string, accessToken: string): Promise<string | null> {
  const now = Date.now();
  if (cachedPhoneNumber !== null && now < phoneCacheExpiry) {
    return cachedPhoneNumber;
  }
  try {
    const res = await fetch(
      `${GRAPH_API_BASE}/${phoneId}?fields=display_phone_number,verified_name`,
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
  const { phoneId, accessToken } = getMetaConfig();
  if (!phoneId || !accessToken) {
    return { status: "unconfigured", phoneNumber: null, phoneId: null };
  }
  const phoneNumber = await fetchDisplayPhoneNumber(phoneId, accessToken);
  return { status: "configured", phoneNumber, phoneId };
}

export async function sendWAMessage(to: string, text: string): Promise<void> {
  const { phoneId, accessToken } = getMetaConfig();
  if (!phoneId || !accessToken) {
    throw new Error(
      "Meta WhatsApp API não configurada — defina META_WHATSAPP_PHONE_ID e META_WHATSAPP_ACCESS_TOKEN",
    );
  }
  const phone = to.replace(/\D/g, "");
  const url = `${GRAPH_API_BASE}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
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
  logger.info({ phone }, "WhatsApp message sent via Meta Cloud API");
}
