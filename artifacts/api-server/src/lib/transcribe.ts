import { readFile } from "node:fs/promises";
import path from "node:path";
import { db, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai, toFile } from "@workspace/integrations-openai-ai";
import { MEDIA_DIR } from "./whatsappInbound";
import { logger } from "./logger";

// Uma transcrição por vez por mensagem (evita pagar 2x por cliques duplos
// ou pelo robô e o botão dispararem juntos).
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

/**
 * Transcreve o áudio de uma mensagem com o Whisper e grava em
 * messages.transcript. Idempotente: se já foi transcrita, devolve o cache.
 * Lança erro se a mensagem não for um áudio acessível.
 */
export async function transcribeMessage(messageId: number): Promise<string> {
  const existing = inFlight.get(messageId);
  if (existing) return existing;
  const p = doTranscribe(messageId).finally(() => inFlight.delete(messageId));
  inFlight.set(messageId, p);
  return p;
}

async function doTranscribe(messageId: number): Promise<string> {
  const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId)).limit(1);
  if (!msg) throw new Error("Mensagem não encontrada");
  if (msg.transcript) return msg.transcript;
  if (msg.type !== "audio" || !msg.mediaUrl) throw new Error("Esta mensagem não é um áudio");

  // mediaUrl é sempre /api/chat/media/<uuid>.<ext> gerado por nós — ainda
  // assim, valida o basename para nunca ler fora do diretório de mídia.
  const filename = path.basename(msg.mediaUrl);
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/i.test(filename)) throw new Error("Arquivo de áudio inválido");
  const ext = filename.split(".").pop()!.toLowerCase();
  const mime = AUDIO_MIME[ext] ?? "audio/ogg";
  const buf = await readFile(path.join(MEDIA_DIR, filename));

  const r = await openai.audio.transcriptions.create({
    model: "whisper-1",
    // Whisper aceita webm/ogg/mp4; o nome com extensão certa orienta o parser.
    file: await toFile(buf, filename.replace(/\.(weba|oga)$/, ext === "weba" ? ".webm" : ".ogg"), { type: mime }),
    language: "pt",
  });
  const text = (r.text ?? "").trim().slice(0, 4000);
  if (!text) throw new Error("Não consegui entender o áudio");

  await db.update(messagesTable).set({ transcript: text }).where(eq(messagesTable.id, messageId));
  logger.info({ messageId }, "Áudio transcrito");
  return text;
}
