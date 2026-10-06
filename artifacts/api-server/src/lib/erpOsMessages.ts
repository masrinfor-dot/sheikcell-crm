import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, conversationsTable, sectorsTable, tenantErpIntegrationsTable } from "@workspace/db";
import { decryptSecret } from "./aiCredentialsCrypto";
import { normalizePhone, phoneVariants } from "./phone";
import { sendOutboundText } from "./outbound";
import { logger } from "./logger";

// Mensagens das OS do ERP Prumo (06/10/2026): a cada minuto, para cada loja
// com a integração ligada, busca no ERP a fila de mensagens das ordens de
// serviço (situação, peças e valores, laudo e link), manda pelo WhatsApp —
// gravando na conversa do cliente no setor "Assistência Técnica", o que já
// abre o atendimento — e avisa o ERP se foi (SENT) ou não (FAILED). O ERP
// nunca chama o CRM; se o CRM cair, a fila espera no ERP.

const ASSIST_SECTOR_NAME = "Assistência Técnica";
const FETCH_TIMEOUT_MS = 15_000;
const BATCH = 20;

export interface ErpDueMessage {
  id: string;
  idempotencyKey: string;
  attempt: number;
  phone: string;
  text: string;
  trigger: string;
  serviceOrderId: string;
  serviceOrderNumber: string | null;
  store: { id: string; name: string; code: string } | null;
  customerName: string | null;
}

export function erpUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function erpFetch(baseUrl: string, apiKey: string, path: string, init?: RequestInit) {
  const res = await fetch(erpUrl(baseUrl, path), {
    ...init,
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ERP respondeu ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

/** Testa a chave no ERP (GET /integrations/ping). */
export async function pingErp(baseUrl: string, apiKey: string) {
  return erpFetch(baseUrl, apiKey, "/integrations/ping") as Promise<{
    ok: boolean;
    tenant: string;
    key: { name: string; prefix: string; scopes: string[] };
  }>;
}

async function ensureAssistSector(tenantId: number): Promise<number> {
  const [existing] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
    .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.name, ASSIST_SECTOR_NAME))).limit(1);
  if (existing) return existing.id;
  await db.insert(sectorsTable)
    .values({ tenantId, name: ASSIST_SECTOR_NAME, icon: "wrench", color: "#f2c230" })
    .onConflictDoNothing();
  const [row] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
    .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.name, ASSIST_SECTOR_NAME))).limit(1);
  return row!.id;
}

/** Conversa do cliente no setor da assistência (acha a aberta ou cria) — abre o atendimento. */
async function findOrCreateConversation(tenantId: number, phone: string, name: string, sectorId: number) {
  const [existing] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      inArray(conversationsTable.phone, phoneVariants(phone)),
      eq(conversationsTable.sectorId, sectorId),
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
    sectorId,
    status: "open",
  }).returning({ id: conversationsTable.id });
  return created!.id;
}

let running = false;

export async function runErpOsMessages(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await db.select().from(tenantErpIntegrationsTable)
      .where(eq(tenantErpIntegrationsTable.osMessagesEnabled, true));
    for (const row of rows) {
      let apiKey: string;
      try {
        apiKey = decryptSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
      } catch (err) {
        await db.update(tenantErpIntegrationsTable).set({ lastError: "Não foi possível ler a chave do ERP (cofre).", lastPollAt: new Date() })
          .where(eq(tenantErpIntegrationsTable.tenantId, row.tenantId));
        logger.warn({ err, tenantId: row.tenantId }, "ERP: chave ilegível");
        continue;
      }
      try {
        const due = await erpFetch(row.baseUrl, apiKey, `/integrations/service-orders/messages/due?limit=${BATCH}`) as { items: ErpDueMessage[] };
        let sent = 0;
        if (due.items.length > 0) {
          const sectorId = await ensureAssistSector(row.tenantId);
          for (const item of due.items) {
            let status: "SENT" | "FAILED" = "FAILED";
            let error: string | undefined;
            let externalId: string | undefined;
            try {
              const conversationId = await findOrCreateConversation(row.tenantId, item.phone, item.customerName ?? "", sectorId);
              const ok = await sendOutboundText(conversationId, item.text, `ERP · OS ${item.serviceOrderNumber ?? ""}`.trim());
              status = ok ? "SENT" : "FAILED";
              error = ok ? undefined : "WhatsApp não aceitou o envio (sessão desconectada?).";
              externalId = String(conversationId);
              if (ok) sent++;
            } catch (err) {
              error = String(err).slice(0, 400);
            }
            await erpFetch(row.baseUrl, apiKey, `/integrations/service-orders/messages/${item.id}/result`, {
              method: "POST",
              body: JSON.stringify({ status, ...(error ? { error } : {}), ...(externalId ? { externalId } : {}) }),
            }).catch((err) => logger.warn({ err, id: item.id }, "ERP: não deu para avisar o resultado"));
          }
        }
        await db.update(tenantErpIntegrationsTable).set({
          lastPollAt: new Date(),
          lastError: null,
          ...(sent > 0 ? { sentCount: sql`${tenantErpIntegrationsTable.sentCount} + ${sent}` } : {}),
        }).where(eq(tenantErpIntegrationsTable.tenantId, row.tenantId));
      } catch (err) {
        await db.update(tenantErpIntegrationsTable).set({ lastPollAt: new Date(), lastError: String(err).slice(0, 400) })
          .where(eq(tenantErpIntegrationsTable.tenantId, row.tenantId));
        logger.warn({ err, tenantId: row.tenantId }, "ERP: falha ao buscar mensagens das OS");
      }
    }
  } catch (err) {
    logger.warn({ err }, "ERP: tick das mensagens das OS falhou");
  } finally {
    running = false;
  }
}
