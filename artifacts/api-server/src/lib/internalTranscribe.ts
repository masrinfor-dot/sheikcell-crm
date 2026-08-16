import { readFile } from "node:fs/promises";
import path from "node:path";
import { db, internalMessagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { toFile } from "@workspace/integrations-openai-ai";
import { getOpenAiClientForTenant } from "./aiClient";
import { MEDIA_DIR } from "./whatsappInbound";
import { logger } from "./logger";

// Mesmo padrão de lib/transcribe.ts (chat de clientes), aplicado às
// mensagens do chat interno da equipe.
const inFlight = new Map<number, Promise<string>>();

const AUDIO_MIME: Record<string, string> = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  weba: "audio/webm",
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  wav: "audio/wav",
};

export async function transcribeInternalMessage(messageId: number): Promise<string> {
  const existing = inFlight.get(messageId);
  if (existing) return existing;
  const p = doTranscribe(messageId).finally(() => inFlight.delete(messageId));
  inFlight.set(messageId, p);
  return p;
}

async function doTranscribe(messageId: number): Promise<string> {
  const [msg] = await db.select().from(internalMessagesTable).where(eq(internalMessagesTable.id, messageId)).limit(1);
  if (!msg) throw new Error("Mensagem não encontrada");
  if (msg.transcript) return msg.transcript;
  if (msg.type !== "audio" || !msg.mediaUrl) throw new Error("Esta mensagem não é um áudio");

  const filename = path.basename(msg.mediaUrl);
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/i.test(filename)) throw new Error("Arquivo de áudio inválido");
  const ext = filename.split(".").pop()!.toLowerCase();
  const mime = AUDIO_MIME[ext] ?? "audio/ogg";
  const buf = await readFile(path.join(MEDIA_DIR, filename));
  const openai = await getOpenAiClientForTenant(msg.tenantId);

  const r = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: await toFile(buf, filename.replace(/\.(weba|oga)$/, ext === "weba" ? ".webm" : ".ogg"), { type: mime }),
    language: "pt",
  });
  const text = (r.text ?? "").trim().slice(0, 4000);
  if (!text) throw new Error("Não consegui entender o áudio");

  await db.update(internalMessagesTable).set({ transcript: text }).where(eq(internalMessagesTable.id, messageId));
  logger.info({ messageId }, "Áudio do chat interno transcrito");
  return text;
}
