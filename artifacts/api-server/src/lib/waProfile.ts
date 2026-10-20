// Fotos de perfil e nomes do WhatsApp (pedido 20/10/2026: "o CRM tem que
// puxar as fotos de perfil também, e os nomes já cadastrados no WhatsApp").
//
// FOTOS — o link que o WhatsApp devolve expira em poucos dias (a imagem
// quebrava e a lista mostrava só as iniciais), e conversas que vieram do
// histórico ou nasceram de mensagem enviada pelo celular nunca buscavam a
// foto. Agora uma rotina pede à ponte a foto JÁ BAIXADA e guarda no disco do
// CRM (MEDIA_DIR/avatars), servida por /api/chat/avatars/:id. Busca o que
// nunca foi buscado e renova a cada AVATAR_REFRESH_DAYS, aos poucos (poucas
// por rodada e uma pausa entre cada uma) para não chamar atenção do WhatsApp.
//
// NOMES — conversa e ficha do CRM que ainda têm só o número ganham o nome já
// cadastrado: agenda do WhatsApp da mesma linha → ficha do CRM → agenda de
// outra linha → outra conversa do mesmo número → nome de perfil que o
// cliente mandou. Roda a cada 30 min e depois do botão "Atualizar agenda e
// fotos", que pede a agenda inteira de novo ao WhatsApp.
import { createHmac } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, pool, conversationsTable, whatsappSessionsTable } from "@workspace/db";
import { MEDIA_DIR } from "./whatsappInbound";
import { logger } from "./logger";

export const AVATAR_DIR = path.join(MEDIA_DIR, "avatars");
export const AVATAR_REFRESH_DAYS = 3;
const PER_SESSION_PER_RUN = 20;
const PAUSE_MS = 1_500;
export const LOCAL_AVATAR_PREFIX = "/api/chat/avatars/";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function bridgeUrl(): string {
  return process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
}

function bridgeSecret(): string {
  return createHmac("sha256", process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret")
    .update("whatsapp-bridge-v1").digest("hex");
}

async function bridgePost(pathName: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${bridgeUrl()}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function isLocalAvatar(url: string | null | undefined): boolean {
  return !!url && url.startsWith(LOCAL_AVATAR_PREFIX);
}

/** Arquivo da foto da conversa no disco (só o nome do arquivo: "123.jpg"). */
export function avatarFileName(conversationId: number, mimeType: string): string {
  return `${conversationId}.${EXT[mimeType] ?? "jpg"}`;
}

export function avatarPublicUrl(conversationId: number, at: Date): string {
  return `${LOCAL_AVATAR_PREFIX}${conversationId}?v=${at.getTime()}`;
}

type PictureResult = { kind: "found"; mimeType: string; data: Buffer } | { kind: "none" } | { kind: "offline" };

export async function fetchPictureFromBridge(sessionKey: string, target: string): Promise<PictureResult> {
  try {
    const r = await bridgePost("/whatsapp/profile-picture", { session: sessionKey, target }, 30_000);
    if (!r.ok) return { kind: "offline" };
    const body = await r.json() as { found?: boolean; mimeType?: string; dataBase64?: string };
    if (!body.found || !body.dataBase64) return { kind: "none" };
    const mimeType = (body.mimeType ?? "image/jpeg").toLowerCase();
    if (!mimeType.startsWith("image/")) return { kind: "none" };
    return { kind: "found", mimeType, data: Buffer.from(body.dataBase64, "base64") };
  } catch {
    return { kind: "offline" };
  }
}

/** Conversas desta linha cuja foto nunca foi buscada ou está velha (mais recentes primeiro). */
export async function conversationsNeedingAvatar(tenantId: number, sessionKey: string, limit: number, now = new Date()) {
  const stale = new Date(now.getTime() - AVATAR_REFRESH_DAYS * 24 * 3600_000);
  return db.select({ id: conversationsTable.id, phone: conversationsTable.phone, avatarUrl: conversationsTable.avatarUrl })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.sessionKey, sessionKey),
      eq(conversationsTable.channel, "whatsapp"),
      or(isNull(conversationsTable.avatarFetchedAt), lt(conversationsTable.avatarFetchedAt, stale)),
    ))
    .orderBy(sql`${conversationsTable.avatarFetchedAt} asc nulls first`, desc(conversationsTable.lastMessageAt))
    .limit(limit);
}

/** Busca e guarda a foto de UMA conversa. Devolve false se a linha está fora (para a rodada parar). */
export async function refreshConversationAvatar(
  conv: { id: number; phone: string; avatarUrl: string | null },
  sessionKey: string,
  fetcher: typeof fetchPictureFromBridge = fetchPictureFromBridge,
): Promise<"saved" | "none" | "offline"> {
  const pic = await fetcher(sessionKey, conv.phone);
  if (pic.kind === "offline") return "offline";
  const now = new Date();
  if (pic.kind === "none") {
    // Sem foto (ou privada): tira o link velho do WhatsApp, que já não abre.
    await db.update(conversationsTable)
      .set({ avatarFetchedAt: now, ...(conv.avatarUrl && !isLocalAvatar(conv.avatarUrl) ? { avatarUrl: null } : {}) })
      .where(eq(conversationsTable.id, conv.id));
    return "none";
  }
  await mkdir(AVATAR_DIR, { recursive: true });
  const file = avatarFileName(conv.id, pic.mimeType);
  // Formato pode mudar entre buscas (jpg → webp): apaga o outro arquivo.
  for (const ext of Object.values(EXT)) {
    const other = `${conv.id}.${ext}`;
    if (other !== file) await unlink(path.join(AVATAR_DIR, other)).catch(() => {});
  }
  await writeFile(path.join(AVATAR_DIR, file), pic.data);
  await db.update(conversationsTable)
    .set({ avatarUrl: avatarPublicUrl(conv.id, now), avatarFetchedAt: now })
    .where(eq(conversationsTable.id, conv.id));
  return "saved";
}

let running = false;

/** Rodada da rotina: poucas fotos por linha conectada, com pausa entre cada uma. */
export async function runAvatarRefresh(opts: { perSession?: number; pauseMs?: number } = {}): Promise<{ saved: number; none: number }> {
  const totals = { saved: 0, none: 0 };
  if (running) return totals;
  running = true;
  try {
    // Todas as linhas (o status gravado pode estar atrasado): a linha que não
    // responder devolve "offline" e a rodada pula para a próxima.
    const sessions = await db.select({ tenantId: whatsappSessionsTable.tenantId, sessionKey: whatsappSessionsTable.sessionKey })
      .from(whatsappSessionsTable);
    for (const s of sessions) {
      const convs = await conversationsNeedingAvatar(s.tenantId, s.sessionKey, opts.perSession ?? PER_SESSION_PER_RUN);
      for (const c of convs) {
        const r = await refreshConversationAvatar(c, s.sessionKey).catch((err) => {
          logger.warn({ err, conversationId: c.id }, "Foto de perfil: falha ao guardar");
          return "none" as const;
        });
        if (r === "offline") break; // linha caiu: tenta na próxima rodada
        totals[r] += 1;
        await new Promise((res) => setTimeout(res, opts.pauseMs ?? PAUSE_MS));
      }
    }
  } finally {
    running = false;
  }
  return totals;
}

// Nome "só número": dígitos, espaço, +, parênteses e hífen.
const NUMBER_ONLY = `'^[0-9+ ()-]+$'`;

const FILL_NAMES_SQL = `
WITH alvo AS (
  SELECT c.id, c.tenant_id, c.session_key, c.phone,
    CASE WHEN length(c.phone) = 13 THEN left(c.phone, 4) || right(c.phone, 8)
         WHEN length(c.phone) = 12 THEN left(c.phone, 4) || '9' || right(c.phone, 8)
         ELSE c.phone END AS alt
  FROM conversations c
  WHERE c.phone NOT LIKE '%@%'
    AND (c.name ~ ${NUMBER_ONLY} OR c.name = c.phone)
    AND ($1::int IS NULL OR c.tenant_id = $1::int)
),
nome AS (
  SELECT a.id, COALESCE(
    (SELECT w.name FROM whatsapp_contacts w
      WHERE w.tenant_id = a.tenant_id AND w.session_key = a.session_key AND w.phone IN (a.phone, a.alt)
        AND coalesce(trim(w.name), '') <> '' AND w.name !~ ${NUMBER_ONLY}
      ORDER BY w.updated_at DESC LIMIT 1),
    (SELECT k.name FROM crm_contacts k
      WHERE k.tenant_id = a.tenant_id AND k.phone IN (a.phone, a.alt)
        AND coalesce(trim(k.name), '') <> '' AND k.name !~ ${NUMBER_ONLY}
      ORDER BY k.updated_at DESC LIMIT 1),
    (SELECT w.name FROM whatsapp_contacts w
      WHERE w.tenant_id = a.tenant_id AND w.phone IN (a.phone, a.alt)
        AND coalesce(trim(w.name), '') <> '' AND w.name !~ ${NUMBER_ONLY}
      ORDER BY w.updated_at DESC LIMIT 1),
    (SELECT o.name FROM conversations o
      WHERE o.tenant_id = a.tenant_id AND o.id <> a.id AND o.phone IN (a.phone, a.alt)
        AND coalesce(trim(o.name), '') <> '' AND o.name !~ ${NUMBER_ONLY}
      ORDER BY o.last_message_at DESC NULLS LAST LIMIT 1),
    (SELECT w.push_name FROM whatsapp_contacts w
      WHERE w.tenant_id = a.tenant_id AND w.phone IN (a.phone, a.alt)
        AND coalesce(trim(w.push_name), '') <> '' AND w.push_name !~ ${NUMBER_ONLY}
      ORDER BY w.updated_at DESC LIMIT 1),
    (SELECT m.sender_name FROM messages m
      WHERE m.conversation_id = a.id AND m.direction = 'inbound'
        AND coalesce(trim(m.sender_name), '') <> '' AND m.sender_name !~ ${NUMBER_ONLY}
      ORDER BY m.id DESC LIMIT 1)
  ) AS name
  FROM alvo a
)
UPDATE conversations c SET name = n.name, updated_at = now()
FROM nome n
WHERE n.id = c.id AND n.name IS NOT NULL
RETURNING c.id`;

/** Troca o nome "só número" das conversas pelo nome já cadastrado. Devolve quantas mudaram. */
export async function fillNumberOnlyNames(tenantId: number | null = null): Promise<number> {
  const r = await pool.query(FILL_NAMES_SQL, [tenantId]);
  return r.rowCount ?? 0;
}

/** Botão "Atualizar agenda e fotos": pede a agenda de novo e marca as fotos da linha para renovar. */
export async function refreshLineProfile(tenantId: number, sessionKey: string): Promise<{ agenda: boolean; conversations: number }> {
  let agenda = false;
  try {
    const r = await bridgePost("/whatsapp/resync-contacts", { session: sessionKey }, 120_000);
    agenda = r.ok;
  } catch { /* linha fora: as fotos ficam marcadas para a próxima rodada */ }
  const marked = await db.update(conversationsTable)
    .set({ avatarFetchedAt: null })
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.sessionKey, sessionKey),
      eq(conversationsTable.channel, "whatsapp"),
    ))
    .returning({ id: conversationsTable.id });
  // Os nomes da agenda chegam aos poucos pelos eventos de contatos: preenche
  // agora e de novo daqui a pouco.
  await fillNumberOnlyNames(tenantId).catch(() => 0);
  setTimeout(() => { void fillNumberOnlyNames(tenantId).catch(() => 0); }, 60_000).unref?.();
  setTimeout(() => { void runAvatarRefresh().catch(() => undefined); }, 5_000).unref?.();
  return { agenda, conversations: marked.length };
}
