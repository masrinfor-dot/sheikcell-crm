import { and, desc, eq, inArray } from "drizzle-orm";
import { db, conversationsTable, tenantErpIntegrationsTable } from "@workspace/db";
import { decryptErpSecret } from "./erpCrypto";
import { erpFetch } from "./erpOsMessages";
import { normalizePhone, phoneVariants } from "./phone";
import { sendOutboundText } from "./outbound";
import { tenantsWithRafflesMoved } from "./rafflesMoved";
import { logger } from "./logger";

// Avisos aos ganhadores dos sorteios do ERP Prumo (17/10/2026): os sorteios
// passaram pro ERP, mas o WhatsApp continua aqui. A cada minuto, para cada
// loja que DESLIGOU os sorteios no CRM e tem a integração com o ERP, busca a
// fila de avisos (GET /integrations/raffles/messages/due), manda na conversa
// do cliente (a mais recente; sem conversa, cria uma) e devolve SENT/FAILED.
// A chave do ERP precisa do acesso "Sorteios" (raffles.send); sem ele o ERP
// responde 403 e aqui só registra no log (não mexe no status da integração).

const BATCH = 20;

export interface ErpRaffleMessage {
  id: string;
  idempotencyKey: string;
  attempt: number;
  phone: string;
  text: string;
  customerName: string | null;
  raffleName: string | null;
}

/** Nome que aparece como remetente na conversa. */
export function raffleSenderName(raffleName: string | null | undefined): string {
  const n = (raffleName ?? "").trim();
  return n ? `ERP · Sorteio ${n}`.slice(0, 80) : "ERP · Sorteio";
}

/** Conversa do cliente: a mais recente (qualquer setor) ou uma nova. */
async function conversationFor(tenantId: number, phone: string, name: string): Promise<number> {
  const [existing] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      inArray(conversationsTable.phone, phoneVariants(phone)),
      eq(conversationsTable.isArchived, false),
    ))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(conversationsTable).values({
    tenantId,
    phone: normalizePhone(phone) || phone,
    name: name || phone,
    channel: "whatsapp",
    status: "open",
  }).returning({ id: conversationsTable.id });
  return created!.id;
}

let running = false;
const lastWarn = new Map<number, number>();

export async function runErpRaffleMessages(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const moved = await tenantsWithRafflesMoved();
    if (moved.size === 0) return;
    const rows = await db.select().from(tenantErpIntegrationsTable)
      .where(inArray(tenantErpIntegrationsTable.tenantId, [...moved]));
    for (const row of rows) {
      let apiKey: string;
      try {
        apiKey = decryptErpSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
      } catch {
        continue; // a integração das OS já registra a chave ilegível
      }
      try {
        const due = await erpFetch(row.baseUrl, apiKey, `/integrations/raffles/messages/due?limit=${BATCH}`) as { items: ErpRaffleMessage[] };
        for (const item of due.items ?? []) {
          let status: "SENT" | "FAILED" = "FAILED";
          let error: string | undefined;
          let externalId: string | undefined;
          try {
            const conversationId = await conversationFor(row.tenantId, item.phone, item.customerName ?? "");
            const ok = await sendOutboundText(conversationId, item.text, raffleSenderName(item.raffleName));
            status = ok ? "SENT" : "FAILED";
            error = ok ? undefined : "WhatsApp não aceitou o envio (sessão desconectada?).";
            externalId = String(conversationId);
          } catch (err) {
            error = String(err).slice(0, 400);
          }
          await erpFetch(row.baseUrl, apiKey, `/integrations/raffles/messages/${item.id}/result`, {
            method: "POST",
            body: JSON.stringify({ status, ...(error ? { error } : {}), ...(externalId ? { externalId } : {}) }),
          }).catch((err) => logger.warn({ err, id: item.id }, "ERP: não deu para avisar o resultado do sorteio"));
        }
      } catch (err) {
        // Sem o acesso "Sorteios" na chave (403) ou ERP fora: avisa no log no máximo 1x/hora.
        const at = lastWarn.get(row.tenantId) ?? 0;
        if (Date.now() - at > 3_600_000) {
          lastWarn.set(row.tenantId, Date.now());
          logger.warn({ err, tenantId: row.tenantId }, "ERP: falha ao buscar avisos dos sorteios");
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "ERP: tick dos avisos de sorteio falhou");
  } finally {
    running = false;
  }
}
