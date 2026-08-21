import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, conversationsTable, messagesTable } from "@workspace/db";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";

/**
 * Envia texto puro pelo bridge, sem gravar mensagem/conversa — uso para
 * respostas que não devem virar atendimento (ex.: confirmação de check-in de
 * ponto). sendOutboundText (abaixo) é a versão que grava tudo; esta é o
 * primitivo que ela usa por baixo.
 */
export async function sendRawWhatsAppText(phone: string, sessionKey: string, text: string): Promise<boolean> {
  const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
  const bridgeSecret = createHmac(
    "sha256",
    process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
  ).update("whatsapp-bridge-v1").digest("hex");
  try {
    const r = await fetch(`${bridgeUrl}/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret },
      body: JSON.stringify({ to: phone, text, session: sessionKey }),
      signal: AbortSignal.timeout(60_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Envia um texto para o cliente de uma conversa (mesmo caminho do envio manual):
 * grava a mensagem, atualiza a conversa, avisa via SSE e encaminha ao bridge.
 * Retorna true se o bridge aceitou o envio.
 */
export async function sendOutboundText(conversationId: number, content: string, senderName: string): Promise<boolean> {
  const [conv] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId)).limit(1);
  if (!conv || !conv.phone) return false;

  const [msg] = await db.insert(messagesTable).values({
    tenantId: conv.tenantId,
    conversationId: conv.id,
    content,
    direction: "outbound",
    type: "text",
    status: "sent",
    senderName,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: content,
    lastMessageDirection: "outbound",
    lastMessageSenderName: senderName,
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, conv.id));

  broadcast("message", { conversationId: conv.id, message: msg },
    { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });

  let delivered = true;
  if (conv.channel === "whatsapp") {
    delivered = await sendRawWhatsAppText(conv.phone, conv.sessionKey, content);
    if (!delivered && msg) {
      const [failedMsg] = await db.update(messagesTable).set({ status: "failed" })
        .where(eq(messagesTable.id, msg.id)).returning();
      if (failedMsg) {
        broadcast("message_updated", { conversationId: conv.id, message: failedMsg },
          { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
      }
    }
  }
  return delivered;
}
