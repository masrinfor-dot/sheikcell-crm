import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  db, erpForwardQueueTable, tenantErpIntegrationsTable, whatsappSessionsTable, conversationsTable, messagesTable,
  type ErpForwardPayload,
} from "@workspace/db";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, max, notLike, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { decryptErpSecret } from "./erpCrypto";
import { MEDIA_DIR } from "./whatsappInbound";
import { normalizePhone } from "./phone";

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

type QueueInsert = typeof erpForwardQueueTable.$inferInsert;

/** Linha da fila a partir da mensagem; null quando não há nada para o ERP ler. */
function toQueueRow(input: EnqueueInput): QueueInsert | null {
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
  if (!payload.text && !mediaPath && !payload.mediaBase64) return null;
  return {
    tenantId: input.tenantId,
    sessionKey: input.sessionKey,
    externalId: input.externalId,
    conversationId: input.conversationId,
    payload,
  };
}

/** Grava na fila e tenta mandar em seguida (sem esperar). */
export async function enqueueErpForward(input: EnqueueInput): Promise<void> {
  const values = toQueueRow(input);
  if (!values) return; // nada para o ERP ler
  const [row] = await db.insert(erpForwardQueueTable).values(values).onConflictDoNothing().returning();
  if (row) void sendOne(row.id).catch(() => {});
}

/**
 * Grava várias linhas de uma vez SEM disparar envio — quem esvazia é o tick
 * do agendador, no ritmo dele (conversas anteriores podem ser milhares de
 * mensagens; mandar tudo de uma vez derrubaria o ERP). Mensagem que já está
 * na fila (mesmo externalId) não duplica: conta em `alreadyQueued`.
 */
export async function enqueueErpForwardMany(inputs: EnqueueInput[]): Promise<{ queued: number; alreadyQueued: number }> {
  const rows = inputs.map(toQueueRow).filter((r): r is QueueInsert => r != null);
  let queued = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = await db
      .insert(erpForwardQueueTable)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ id: erpForwardQueueTable.id });
    queued += inserted.length;
  }
  return { queued, alreadyQueued: rows.length - queued };
}

// ─── Conversas anteriores (histórico já gravado no CRM) ─────────────────────
// Pedido 19/10/2026: além das mensagens novas, mandar ao ERP o que os
// fornecedores já mandaram antes (histórico importado ou recebido antes de
// marcar a conexão). Mesmo filtro do webhook (processInboundWA): recebida,
// com id do WhatsApp, não apagada, texto/foto/documento (áudio, vídeo,
// figurinha, contato etc. não são listas), fora de grupo/comunidade.

export const HISTORY_MAX_DAYS = 180;
export const HISTORY_DEFAULT_DAYS = 30;
/** Teto por chamada — quem quiser mais chama de novo (o que já entrou não duplica). */
export const HISTORY_MAX_MESSAGES = 5000;

const CANDIDATE_TYPES = ["text", "image", "doc"];

/** Conteúdo gravado quando a mídia veio sem legenda ("📷 Foto", "📄 arquivo.pdf") — não é texto para o ERP. */
function isMediaPlaceholder(type: string, content: string): boolean {
  return (type === "image" && content === "📷 Foto") || (type === "doc" && content.startsWith("📄 "));
}

/** Mesma regra de isMediaPlaceholder, em SQL (para contar sem carregar as mensagens). */
const mediaPlaceholderSql = sql`((${messagesTable.type} = 'image' AND ${messagesTable.content} = '📷 Foto') OR (${messagesTable.type} = 'doc' AND ${messagesTable.content} LIKE '📄 %'))`;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", txt: "text/plain",
};

function mimeFromMediaUrl(mediaUrl: string | null): string | null {
  if (!mediaUrl) return null;
  const ext = path.extname(mediaUrl).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? null;
}

function sinceDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60_000);
}

/** Mensagens candidatas da conexão (join com a conversa) no período. */
function candidateWhere(tenantId: number, sessionKey: string, days: number) {
  return and(
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.sessionKey, sessionKey),
    notLike(conversationsTable.phone, "%@g.us"),
    eq(conversationsTable.isCommunity, false),
    eq(messagesTable.tenantId, tenantId),
    eq(messagesTable.direction, "inbound"),
    isNotNull(messagesTable.externalId),
    isNull(messagesTable.deletedAt),
    inArray(messagesTable.type, CANDIDATE_TYPES),
    gte(messagesTable.createdAt, sinceDate(days)),
    // Tem o que ler: arquivo guardado ou texto de verdade (não o placeholder da mídia).
    or(isNotNull(messagesTable.mediaUrl), sql`(${messagesTable.content} <> '' AND NOT ${mediaPlaceholderSql})`),
  );
}

export interface ErpForwardSummary {
  configured: boolean;
  forwardToErp: boolean;
  days: number;
  queue: { pending: number; processing: number; sent: number; failed: number };
  conversations: Array<{ id: number; phone: string; name: string; messages: number; lastMessageAt: string | null }>;
}

/** Situação da fila da conexão + contatos com mensagens candidatas no período (mais mensagens primeiro). */
export async function erpForwardSummary(tenantId: number, sessionKey: string, days: number): Promise<ErpForwardSummary> {
  const [configured, forwardToErp, statusRows, convRows] = await Promise.all([
    erpForwardConfigured(tenantId),
    sessionForwardsToErp(sessionKey, tenantId),
    db
      .select({ status: erpForwardQueueTable.status, n: count() })
      .from(erpForwardQueueTable)
      .where(and(eq(erpForwardQueueTable.tenantId, tenantId), eq(erpForwardQueueTable.sessionKey, sessionKey)))
      .groupBy(erpForwardQueueTable.status),
    db
      .select({
        id: conversationsTable.id,
        phone: conversationsTable.phone,
        name: conversationsTable.name,
        messages: count(messagesTable.id),
        lastMessageAt: max(messagesTable.createdAt),
      })
      .from(messagesTable)
      .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
      .where(candidateWhere(tenantId, sessionKey, days))
      .groupBy(conversationsTable.id, conversationsTable.phone, conversationsTable.name)
      .orderBy(desc(count(messagesTable.id)), desc(max(messagesTable.createdAt))),
  ]);
  const queue = { pending: 0, processing: 0, sent: 0, failed: 0 };
  for (const r of statusRows) if (r.status in queue) queue[r.status as keyof typeof queue] = Number(r.n);
  return {
    configured,
    forwardToErp,
    days,
    queue,
    conversations: convRows.map((c) => ({
      id: c.id,
      phone: c.phone,
      name: c.name,
      messages: Number(c.messages),
      lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
    })),
  };
}

export interface HistoryResult {
  /** Entraram na fila agora. */
  queued: number;
  /** Já estavam na fila (mesmo id de mensagem) — não duplicam. */
  alreadyQueued: number;
  /** Contatos com pelo menos uma mensagem considerada. */
  conversations: number;
  /** Ficaram de fora por passar do teto de HISTORY_MAX_MESSAGES (chame de novo para o resto). */
  skipped: number;
}

/**
 * Enfileira as mensagens candidatas do período (opcionalmente só de alguns
 * contatos). Mais recentes primeiro: se passar do teto, o que fica de fora é
 * o mais antigo — e para lista de preço o que vale é a última. Não dispara
 * envio: o agendador manda no ritmo dele.
 */
export async function enqueueErpForwardHistory(
  tenantId: number,
  sessionKey: string,
  days: number,
  conversationIds?: number[],
): Promise<HistoryResult> {
  const where = and(
    candidateWhere(tenantId, sessionKey, days),
    conversationIds && conversationIds.length ? inArray(conversationsTable.id, conversationIds) : undefined,
  );
  const [[totals], rows] = await Promise.all([
    db
      .select({ total: count() })
      .from(messagesTable)
      .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
      .where(where),
    db
      .select({
        id: messagesTable.id,
        conversationId: messagesTable.conversationId,
        externalId: messagesTable.externalId,
        type: messagesTable.type,
        content: messagesTable.content,
        mediaUrl: messagesTable.mediaUrl,
        metadata: messagesTable.metadata,
        createdAt: messagesTable.createdAt,
        phone: conversationsTable.phone,
        name: conversationsTable.name,
      })
      .from(messagesTable)
      .innerJoin(conversationsTable, eq(messagesTable.conversationId, conversationsTable.id))
      .where(where)
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(HISTORY_MAX_MESSAGES),
  ]);
  const inputs: EnqueueInput[] = [];
  const convs = new Set<number>();
  for (const m of rows) {
    if (!m.externalId) continue;
    const meta = m.metadata;
    const text = isMediaPlaceholder(m.type, m.content) ? null : m.content || null;
    inputs.push({
      tenantId,
      sessionKey,
      externalId: m.externalId,
      conversationId: m.conversationId,
      senderPhone: normalizePhone(m.phone),
      senderName: m.name || null,
      receivedAt: m.createdAt,
      text,
      fileName: meta?.fileName ?? null,
      mimeType: meta?.mimeType ?? mimeFromMediaUrl(m.mediaUrl),
      mediaUrl: m.mediaUrl,
      mediaBase64: null,
    });
    convs.add(m.conversationId);
  }
  const { queued, alreadyQueued } = await enqueueErpForwardMany(inputs);
  const total = Number(totals?.total ?? 0);
  return { queued, alreadyQueued, conversations: convs.size, skipped: Math.max(0, total - rows.length) };
}

/** Linhas 'failed' da conexão voltam para a fila (tentativas zeradas). Devolve quantas. */
export async function retryFailedErpForward(tenantId: number, sessionKey: string): Promise<number> {
  const rows = await db
    .update(erpForwardQueueTable)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date() })
    .where(and(
      eq(erpForwardQueueTable.tenantId, tenantId),
      eq(erpForwardQueueTable.sessionKey, sessionKey),
      eq(erpForwardQueueTable.status, "failed"),
    ))
    .returning({ id: erpForwardQueueTable.id });
  return rows.length;
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
      const buf = await readFile(p.mediaPath).catch((err: NodeJS.ErrnoException) => {
        // Arquivo sumiu do disco (ex.: histórico antigo): não vai voltar — não insiste.
        if (err.code === "ENOENT") throw Object.assign(new Error("Arquivo da mídia não está mais no servidor"), { final: true });
        throw err;
      });
      if (buf.byteLength > MAX_MEDIA_BYTES) throw Object.assign(new Error("Arquivo maior que 15 MB (limite do ERP)"), { final: true });
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

/** Tempo máximo de um tick: o próximo (60 s) continua de onde parou. */
const TICK_BUDGET_MS = 50_000;

/** Tick do agendador: manda o que está pendente e vencido, uma de cada vez. */
export async function runErpForwardQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Linhas presas em "processing" por mais de 10 min (processo caiu no meio) voltam para a fila.
    await db
      .update(erpForwardQueueTable)
      .set({ status: "pending" })
      .where(and(eq(erpForwardQueueTable.status, "processing"), lte(erpForwardQueueTable.nextAttemptAt, sql`now() - interval '10 minutes'`)));
    // Credenciais resolvidas uma vez por loja dentro do tick.
    const credsByTenant = new Map<number, ErpCredentials | null>();
    const startedAt = Date.now();
    // Em rodadas de 20 até esvaziar ou estourar o tempo do tick — conversas
    // anteriores podem enfileirar milhares de linhas de uma vez.
    for (;;) {
      const due = await db
        .select({ id: erpForwardQueueTable.id, tenantId: erpForwardQueueTable.tenantId })
        .from(erpForwardQueueTable)
        .where(and(eq(erpForwardQueueTable.status, "pending"), lte(erpForwardQueueTable.nextAttemptAt, new Date())))
        .orderBy(erpForwardQueueTable.id)
        .limit(20);
      if (!due.length) break;
      for (const row of due) {
        if (!credsByTenant.has(row.tenantId)) credsByTenant.set(row.tenantId, await resolveErpCredentials(row.tenantId));
        await sendOne(row.id, credsByTenant.get(row.tenantId) ?? null);
      }
      // Rodada que não esvaziou (ERP fora do ar: tudo voltou com espera) ou tempo esgotado: para.
      if (due.length < 20 || Date.now() - startedAt > TICK_BUDGET_MS) break;
    }
  } catch (err) {
    logger.warn({ err }, "Tick da fila do ERP falhou");
  } finally {
    running = false;
  }
}
