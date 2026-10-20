import { readFile } from "node:fs/promises";
import path from "node:path";
import { db, erpForwardQueueTable, tenantErpIntegrationsTable, whatsappSessionsTable, type ErpForwardPayload } from "@workspace/db";
import { and, eq, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { decryptErpSecret } from "./erpCrypto";
import { MEDIA_DIR } from "./whatsappInbound";

/**
 * WhatsApp de compras → ERP (Prumo), 19/10/2026.
 *
 * Toda mensagem recebida numa conexão marcada como "WhatsApp de compras"
 * (whatsapp_sessions.forward_to_erp) é mandada ao ERP, que lê a lista de
 * preço do fornecedor com IA (`POST /integrations/supplier-price-lists`,
 * cabeçalho X-Api-Key com acesso "Listas de preço dos fornecedores").
 *
 * Desenho: outbox. O webhook do WhatsApp só grava a linha na fila
 * (erp_forward_queue) e tenta mandar em seguida, sem esperar; o agendador
 * (scheduler.ts) tenta de novo o que falhou, com espera crescente. Nada é
 * perdido se o ERP estiver fora do ar.
 *
 * Credenciais (por loja): primeiro a integração com o ERP gravada em
 * Administração › Integrações (tenant_erp_integrations — endereço da API e
 * chave cifrada, a mesma usada pelas mensagens das OS e pelo RH); na falta
 * dela, as variáveis do servidor ERP_API_URL (ex.:
 * https://api.sheikcell.com.br/api/v1) e ERP_API_KEY (chave gerada no ERP em
 * Auxiliares › Integrações). Em qualquer caso a chave precisa do acesso
 * "Listas de preço dos fornecedores (WhatsApp de compras)".
 */

const ENV_URL = (process.env["ERP_API_URL"] ?? "").trim().replace(/\/+$/, "");
const ENV_KEY = (process.env["ERP_API_KEY"] ?? "").trim();
const MAX_ATTEMPTS = 30;
/** Espera entre tentativas: 1 min, 5 min, 15 min, 1 h, depois 6 h. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
/** Sem credencial do ERP a linha fica esperando (não conta como tentativa). */
const UNCONFIGURED_WAIT_MS = 60 * 60_000;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export interface ErpCredentials {
  baseUrl: string;
  apiKey: string;
  source: "tenant" | "env";
}

/**
 * Credenciais do ERP para a loja: integração de Administração › Integrações
 * (cofre) ou, na falta dela, ERP_API_URL/ERP_API_KEY do servidor. null = não
 * configurado (nada é enfileirado nem enviado).
 */
export async function resolveErpCredentials(tenantId: number): Promise<ErpCredentials | null> {
  const [row] = await db
    .select({
      baseUrl: tenantErpIntegrationsTable.baseUrl,
      encryptedApiKey: tenantErpIntegrationsTable.encryptedApiKey,
      iv: tenantErpIntegrationsTable.iv,
      authTag: tenantErpIntegrationsTable.authTag,
      keyVersion: tenantErpIntegrationsTable.keyVersion,
    })
    .from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId))
    .limit(1);
  if (row) {
    try {
      const apiKey = decryptErpSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
      return { baseUrl: row.baseUrl.replace(/\/+$/, ""), apiKey, source: "tenant" };
    } catch (err) {
      logger.warn({ err, tenantId }, "ERP (listas de compras): chave da integração ilegível; tentando ERP_API_URL/ERP_API_KEY");
    }
  }
  if (ENV_URL && ENV_KEY) return { baseUrl: ENV_URL, apiKey: ENV_KEY, source: "env" };
  return null;
}

/** A loja tem como falar com o ERP (integração ou variáveis do servidor)? */
export async function erpForwardConfigured(tenantId: number): Promise<boolean> {
  return (await resolveErpCredentials(tenantId)) != null;
}

/** A conexão está marcada como WhatsApp de compras? */
export async function sessionForwardsToErp(sessionKey: string, tenantId: number): Promise<boolean> {
  const [row] = await db
    .select({ forwardToErp: whatsappSessionsTable.forwardToErp })
    .from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.sessionKey, sessionKey), eq(whatsappSessionsTable.tenantId, tenantId)))
    .limit(1);
  return row?.forwardToErp ?? false;
}

export interface EnqueueInput {
  tenantId: number;
  sessionKey: string;
  externalId: string;
  conversationId: number | null;
  senderPhone: string;
  senderName: string | null;
  receivedAt: Date;
  text: string | null;
  fileName: string | null;
  mimeType: string | null;
  /** URL que o saveMedia devolveu (/api/chat/media/<arquivo>), se guardou. */
  mediaUrl: string | null;
  /** Base64 vindo do bridge — só fica na fila se o arquivo NÃO foi guardado. */
  mediaBase64: string | null;
}

/** Grava na fila e tenta mandar em seguida (sem esperar). */
export async function enqueueErpForward(input: EnqueueInput): Promise<void> {
  const mediaPath = input.mediaUrl ? path.join(MEDIA_DIR, path.basename(input.mediaUrl)) : null;
  const payload: ErpForwardPayload = {
    senderPhone: input.senderPhone,
    senderName: input.senderName,
    receivedAt: input.receivedAt.toISOString(),
    text: input.text,
    fileName: input.fileName,
    mimeType: input.mimeType,
    mediaPath,
    mediaBase64: !mediaPath && input.mediaBase64 ? input.mediaBase64 : null,
  };
  if (!payload.text && !mediaPath && !payload.mediaBase64) return; // nada para o ERP ler
  const [row] = await db
    .insert(erpForwardQueueTable)
    .values({
      tenantId: input.tenantId,
      sessionKey: input.sessionKey,
      externalId: input.externalId,
      conversationId: input.conversationId,
      payload,
    })
    .onConflictDoNothing()
    .returning();
  if (row) void sendOne(row.id).catch(() => {});
}

interface ErpResponse {
  lists?: Array<{ id: string; status: string; duplicate: boolean }>;
  message?: string;
}

/** Manda uma linha da fila ao ERP. Devolve true se o ERP aceitou. */
export async function sendOne(id: number, creds?: ErpCredentials | null): Promise<boolean> {
  // Reivindica a linha (um processo por vez): pending → processing. O
  // next_attempt_at vira "reivindicada em" — é por ele que o tick devolve à
  // fila uma linha presa em processing (processo caiu no meio).
  const [row] = await db
    .update(erpForwardQueueTable)
    .set({ status: "processing", nextAttemptAt: new Date() })
    .where(and(eq(erpForwardQueueTable.id, id), eq(erpForwardQueueTable.status, "pending")))
    .returning();
  if (!row) return false;
  const credentials = creds === undefined ? await resolveErpCredentials(row.tenantId) : creds;
  if (!credentials) {
    // Integração desligada depois de enfileirar: devolve para a fila e espera
    // (não conta como tentativa — a mensagem não se perde).
    await db
      .update(erpForwardQueueTable)
      .set({ status: "pending", lastError: "ERP não configurado (Administração › Integrações ou ERP_API_URL/ERP_API_KEY)", nextAttemptAt: new Date(Date.now() + UNCONFIGURED_WAIT_MS) })
      .where(eq(erpForwardQueueTable.id, row.id));
    return false;
  }
  const p = row.payload;
  try {
    const attachments: Array<{ fileName: string; mimeType: string; dataBase64: string }> = [];
    let dataBase64: string | null = p.mediaBase64;
    if (p.mediaPath) {
      const buf = await readFile(p.mediaPath);
      if (buf.byteLength > MAX_MEDIA_BYTES) throw new Error("Arquivo maior que 15 MB (limite do ERP)");
      dataBase64 = buf.toString("base64");
    }
    if (dataBase64) {
      attachments.push({
        fileName: p.fileName ?? `lista.${(p.mimeType ?? "bin").split("/")[1]?.split(";")[0] ?? "bin"}`,
        mimeType: (p.mimeType ?? "application/octet-stream").split(";")[0].trim(),
        dataBase64,
      });
    }
    const r = await fetch(`${credentials.baseUrl}/integrations/supplier-price-lists`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": credentials.apiKey },
      body: JSON.stringify({
        externalId: row.externalId,
        senderPhone: p.senderPhone,
        senderName: p.senderName ?? undefined,
        receivedAt: p.receivedAt,
        text: p.text ?? undefined,
        conversationRef: row.conversationId != null ? String(row.conversationId) : undefined,
        sessionKey: row.sessionKey,
        attachments: attachments.length ? attachments : undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await r.json().catch(() => ({}))) as ErpResponse;
    if (!r.ok) {
      // 400 = o ERP recusou o conteúdo (não vai mudar); 403 = chave sem o
      // acesso "Listas de preço dos fornecedores": não insiste.
      const final = r.status === 400 || r.status === 403;
      throw Object.assign(new Error(`ERP respondeu ${r.status}: ${body.message ?? ""}`), { final });
    }
    await db
      .update(erpForwardQueueTable)
      .set({ status: "sent", sentAt: new Date(), erpListId: body.lists?.[0]?.id ?? null, lastError: null })
      .where(eq(erpForwardQueueTable.id, row.id));
    return true;
  } catch (err) {
    const attempts = row.attempts + 1;
    const final = (err as { final?: boolean }).final === true || attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    await db
      .update(erpForwardQueueTable)
      .set({
        status: final ? "failed" : "pending",
        attempts,
        lastError: String((err as Error).message ?? err).slice(0, 500),
        nextAttemptAt: new Date(Date.now() + wait),
      })
      .where(eq(erpForwardQueueTable.id, row.id));
    logger.warn({ err, id: row.id, tenantId: row.tenantId, attempts, final }, "Encaminhamento ao ERP falhou");
    return false;
  }
}

let running = false;

/** Tick do agendador: manda o que está pendente e vencido. */
export async function runErpForwardQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Linhas presas em "processing" por mais de 10 min (processo caiu no meio) voltam para a fila.
    await db
      .update(erpForwardQueueTable)
      .set({ status: "pending" })
      .where(and(eq(erpForwardQueueTable.status, "processing"), lte(erpForwardQueueTable.nextAttemptAt, sql`now() - interval '10 minutes'`)));
    const due = await db
      .select({ id: erpForwardQueueTable.id, tenantId: erpForwardQueueTable.tenantId })
      .from(erpForwardQueueTable)
      .where(and(eq(erpForwardQueueTable.status, "pending"), lte(erpForwardQueueTable.nextAttemptAt, new Date())))
      .orderBy(erpForwardQueueTable.id)
      .limit(20);
    // Credenciais resolvidas uma vez por loja dentro do tick.
    const credsByTenant = new Map<number, ErpCredentials | null>();
    for (const row of due) {
      if (!credsByTenant.has(row.tenantId)) credsByTenant.set(row.tenantId, await resolveErpCredentials(row.tenantId));
      await sendOne(row.id, credsByTenant.get(row.tenantId) ?? null);
    }
  } catch (err) {
    logger.warn({ err }, "Tick da fila do ERP falhou");
  } finally {
    running = false;
  }
}
