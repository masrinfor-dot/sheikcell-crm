// Importação do histórico do WhatsApp (pedido 16/10/2026: "subir o número das
// compras e do adm no CRM, puxar o histórico de conversa e cadastrar direto em
// Ativos com os mesmos nomes que estão no WhatsApp").
//
// Como funciona: ao parear uma linha com "Puxar histórico ao conectar"
// ligado (whatsapp_sessions.history_import_enabled), o bridge pede o
// histórico completo ao celular (evento messaging-history.set do Baileys) e
// encaminha as mensagens em lotes para POST /chat/webhook/whatsapp-history,
// que chama processWAHistoryBatch abaixo.
//
// Regras:
// - Mensagens recebidas E enviadas (fromMe), com a data original.
// - Grupos entram também (nome do grupo como nome da conversa).
// - Nome do contato: o salvo na agenda DESTA linha (whatsapp_contacts) →
//   nome do chat no WhatsApp → nome do perfil (pushName) → telefone.
// - Conversa nova: se a linha tem responsável fixo (direct_assignee_id) E a
//   conversa está ABERTA no celular, já nasce em "Ativos" com ele (e a ficha
//   do CRM em "Ativo"). Arquivada no celular, ou linha sem responsável:
//   nasce em Resolvidas — nunca enche Ativos/Potenciais com conversa velha
//   nem dispara a fila. (pedido 17/10: "atendimentos ativos direto das
//   conversas abertas no WhatsApp de cada um" — ADM, Atacado e Compras.)
// - Arquivada DEPOIS que o histórico já gravou (o celular manda esse estado
//   separado): processWAHistoryArchived fecha só as conversas que a
//   importação acabou de criar e que ninguém mexeu desde então.
// - Conversa que já existe: só recebe as mensagens que faltam; status e
//   responsável não mudam.
// - Nunca dispara robô, pesquisa, check-in de ponto nem som/alerta de
//   mensagem nova; não soma "não lidas".
// - Idempotente: a mesma mensagem (mesmo ID do WhatsApp) nunca é gravada
//   duas vezes — o celular pode reenviar pedaços do histórico.
// - Mídia antiga não é baixada (o WhatsApp costuma expirar o arquivo): a
//   mensagem aparece com o tipo ("📷 Foto", "📄 nome.pdf"…) sem o arquivo.
import {
  db, conversationsTable, messagesTable, sectorsTable, whatsappSessionsTable,
  crmContactsTable, whatsappContactsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { normalizePhone, phoneVariants } from "./phone";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { ensureCrmContactForConversation } from "./crmSync";
import { describeWAContent, resolveDirectAssignee, resolveTenantForSession, type InboundWAPayload } from "./whatsappInbound";
import { logger } from "./logger";

export interface WAHistoryMessage {
  /** JID da conversa já resolvido pelo bridge (telefone@s.whatsapp.net ou grupo@g.us). */
  remoteJid: string;
  id: string;
  fromMe: boolean;
  isGroup: boolean;
  /** Quem mandou dentro do grupo (telefone@s.whatsapp.net), quando resolvido. */
  participant?: string;
  pushName?: string;
  /** Segundos desde 1970 (messageTimestamp do WhatsApp). */
  timestamp?: number;
  /** Nome do chat no WhatsApp (nome do grupo, ou nome que o celular mostra para o contato). */
  chatName?: string;
  /** Conversa arquivada no celular (true) — vai pra Resolvidas, não pra Ativos. */
  chatArchived?: boolean;
  message?: NonNullable<InboundWAPayload["data"]>["message"];
  mediaType?: "image" | "video" | "audio" | "doc" | "sticker";
  mediaMimeType?: string;
}

export interface WAHistoryPayload {
  sessionKey?: string;
  messages?: WAHistoryMessage[];
}

export interface WAHistoryResult {
  skipped?: "unknown_session" | "disabled";
  conversationsCreated: number;
  conversationsUpdated: number;
  messagesInserted: number;
  messagesIgnored: number;
}

const MAX_MESSAGES_PER_BATCH = 1000;
const VALID_SESSION = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Identidade da conversa a partir do JID: telefone normalizado (1:1) ou o JID do grupo. */
export function historyConversationKey(remoteJid: string, isGroup: boolean): string | null {
  if (isGroup) return remoteJid.endsWith("@g.us") ? remoteJid : null;
  if (!remoteJid.endsWith("@s.whatsapp.net") && !remoteJid.endsWith("@c.us")) return null; // @lid sem telefone: não dá pra responder
  const digits = remoteJid.split("@")[0]?.split(":")[0] ?? "";
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/** Escolhe o nome da conversa como o WhatsApp mostra (ver regras no topo). */
export function pickHistoryName(input: {
  isGroup: boolean;
  phone: string;
  agendaName?: string | null;
  chatName?: string | null;
  pushName?: string | null;
}): string {
  const clean = (v?: string | null) => (v ?? "").trim();
  if (input.isGroup) return clean(input.chatName) || "Grupo do WhatsApp";
  return clean(input.agendaName) || clean(input.chatName) || clean(input.pushName) || input.phone;
}

export async function processWAHistoryBatch(payload: WAHistoryPayload): Promise<WAHistoryResult> {
  const result: WAHistoryResult = { conversationsCreated: 0, conversationsUpdated: 0, messagesInserted: 0, messagesIgnored: 0 };
  const sessionKey = typeof payload.sessionKey === "string" && VALID_SESSION.test(payload.sessionKey) ? payload.sessionKey : null;
  if (!sessionKey) return { ...result, skipped: "unknown_session" };
  const tenantId = await resolveTenantForSession(sessionKey);
  if (tenantId == null) return { ...result, skipped: "unknown_session" };

  const [session] = await db.select({
    historyImportEnabled: whatsappSessionsTable.historyImportEnabled,
    defaultSectorIds: whatsappSessionsTable.defaultSectorIds,
    displayName: whatsappSessionsTable.displayName,
  }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.sessionKey, sessionKey), eq(whatsappSessionsTable.tenantId, tenantId)))
    .limit(1);
  // Só grava com a opção ligada — desligar no meio do caminho para a importação.
  if (!session?.historyImportEnabled) return { ...result, skipped: "disabled" };

  const directAssigneeId = await resolveDirectAssignee(tenantId, sessionKey);
  const outboundSenderName = session.displayName?.trim() || "WhatsApp (celular)";

  // Setor da conversa nova: o 1º setor vinculado à linha; senão, o 1º setor ativo da loja.
  let sectorId: number | null = session.defaultSectorIds?.[0] ?? null;
  if (sectorId == null) {
    const [first] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
      .where(and(eq(sectorsTable.isActive, true), eq(sectorsTable.tenantId, tenantId)))
      .limit(1);
    sectorId = first?.id ?? null;
  }

  // Agrupa por conversa, preservando a ordem cronológica.
  const groups = new Map<string, WAHistoryMessage[]>();
  for (const m of (payload.messages ?? []).slice(0, MAX_MESSAGES_PER_BATCH)) {
    if (!m || typeof m.remoteJid !== "string" || typeof m.id !== "string" || !m.id) { result.messagesIgnored++; continue; }
    const key = historyConversationKey(m.remoteJid, !!m.isGroup);
    if (!key) { result.messagesIgnored++; continue; }
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  for (const [key, list] of groups) {
    try {
      list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const r = await importConversation({ tenantId, sessionKey, key, list, sectorId, directAssigneeId, outboundSenderName });
      if (r.created) result.conversationsCreated++;
      else if (r.inserted > 0) result.conversationsUpdated++;
      result.messagesInserted += r.inserted;
      result.messagesIgnored += r.ignored;
    } catch (err) {
      result.messagesIgnored += list.length;
      logger.warn({ err, sessionKey, key }, "Falha ao importar histórico de uma conversa do WhatsApp");
    }
  }
  return result;
}

async function importConversation(input: {
  tenantId: number;
  sessionKey: string;
  key: string;
  list: WAHistoryMessage[];
  sectorId: number | null;
  directAssigneeId: number | null;
  outboundSenderName: string;
}): Promise<{ created: boolean; inserted: number; ignored: number }> {
  const { tenantId, sessionKey, key, list, sectorId, directAssigneeId, outboundSenderName } = input;
  const isGroup = key.endsWith("@g.us");
  const storedPhone = isGroup ? key : normalizePhone(key);
  const matchCandidates = isGroup ? [key] : phoneVariants(key);
  if (!storedPhone || matchCandidates.length === 0) return { created: false, inserted: 0, ignored: list.length };

  // Contato bloqueado no CRM (spam etc.): mesmo descarte do caminho ao vivo.
  if (!isGroup) {
    const [blocked] = await db.select({ id: crmContactsTable.id }).from(crmContactsTable)
      .where(and(eq(crmContactsTable.tenantId, tenantId), eq(crmContactsTable.isBlocked, true), inArray(crmContactsTable.phone, matchCandidates)))
      .limit(1);
    if (blocked) return { created: false, inserted: 0, ignored: list.length };
  }

  // Interpreta cada mensagem com o MESMO leitor da mensagem ao vivo.
  const parsed = list.map((m) => {
    const d = describeWAContent({ data: { message: m.message, mediaType: m.mediaType, mediaMimeType: m.mediaMimeType } });
    return { m, d };
  });

  const newest = parsed[parsed.length - 1]!;
  const newestAt = newest.m.timestamp ? new Date(newest.m.timestamp * 1000) : new Date();
  const lastInboundPush = [...list].reverse().find((m) => !m.fromMe && !isGroup && m.pushName)?.pushName;
  const chatName = [...list].reverse().find((m) => m.chatName)?.chatName;
  const archivedOnPhone = [...list].reverse().find((m) => m.chatArchived != null)?.chatArchived === true;
  const goesToActive = directAssigneeId != null && !archivedOnPhone;

  let agendaName: string | null = null;
  if (!isGroup) {
    const [agenda] = await db.select({ name: whatsappContactsTable.name }).from(whatsappContactsTable)
      .where(and(
        eq(whatsappContactsTable.tenantId, tenantId),
        eq(whatsappContactsTable.sessionKey, sessionKey),
        inArray(whatsappContactsTable.phone, matchCandidates),
        sql`${whatsappContactsTable.name} is not null and ${whatsappContactsTable.name} <> ''`,
      ))
      .limit(1);
    agendaName = agenda?.name ?? null;
  }
  const name = pickHistoryName({ isGroup, phone: storedPhone, agendaName, chatName, pushName: lastInboundPush });

  const conditions = [
    eq(conversationsTable.tenantId, tenantId),
    inArray(conversationsTable.phone, matchCandidates),
    eq(conversationsTable.isArchived, false),
  ];
  if (!isGroup) conditions.push(eq(conversationsTable.sessionKey, sessionKey));

  // Mesma advisory lock do caminho ao vivo (upsertConversation): uma mensagem
  // nova chegando enquanto o histórico é gravado nunca cria conversa duplicada.
  const lockKeyStr = `${storedPhone}|${isGroup ? "" : sessionKey}`;
  const { conv, created } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${tenantId}, hashtext(${lockKeyStr}))`);
    const [existing] = await tx.select().from(conversationsTable)
      .where(and(...conditions))
      .orderBy(desc(conversationsTable.lastMessageAt))
      .limit(1);
    if (existing) return { conv: existing, created: false };
    const [inserted] = await tx.insert(conversationsTable).values({
      tenantId,
      phone: storedPhone,
      name,
      channel: "whatsapp",
      sessionKey,
      sectorId,
      // Aberta no celular + responsável fixo: "Ativos" com ele. Arquivada ou
      // sem responsável: Resolvidas (só consulta).
      status: goesToActive ? "open" : "resolved",
      assigneeId: goesToActive ? directAssigneeId : null,
      attendanceStartedAt: goesToActive ? new Date() : null,
      lastMessage: newest.d.displayContent,
      lastMessageDirection: newest.m.fromMe ? "outbound" : "inbound",
      lastMessageSenderName: newest.m.fromMe ? outboundSenderName : null,
      lastMessageAt: newestAt,
      unreadCount: 0,
    }).returning();
    return { conv: inserted!, created: true };
  });

  // Mensagens que já estão gravadas nesta conversa (pedaço reenviado pelo celular).
  const ids = [...new Set(list.map((m) => m.id))];
  const existingIds = new Set(
    (await db.select({ externalId: messagesTable.externalId }).from(messagesTable)
      .where(and(eq(messagesTable.conversationId, conv.id), inArray(messagesTable.externalId, ids))))
      .map((r) => r.externalId),
  );
  const seen = new Set<string>();
  const rows = parsed
    .filter(({ m }) => {
      if (existingIds.has(m.id) || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .map(({ m, d }) => {
      const participantPhone = isGroup && m.participant?.endsWith("@s.whatsapp.net") ? m.participant.split("@")[0] ?? null : null;
      const metadata = d.mediaType === "doc" && (d.docFileName || d.docFileSize || d.mediaMimeType)
        ? { fileName: d.docFileName ?? undefined, fileSize: d.docFileSize, mimeType: d.mediaMimeType ?? undefined }
        : null;
      return {
        tenantId,
        conversationId: conv.id,
        content: d.displayContent,
        direction: m.fromMe ? "outbound" : "inbound",
        type: d.msgType,
        status: m.fromMe ? "sent" : "delivered",
        senderName: m.fromMe ? outboundSenderName : (m.pushName || (isGroup ? participantPhone : name) || null),
        senderPhone: m.fromMe ? null : participantPhone,
        externalId: m.id,
        mediaUrl: null,
        metadata,
        createdAt: m.timestamp ? new Date(m.timestamp * 1000) : new Date(),
      };
    });

  let inserted = 0;
  // Em pedaços, pra não estourar o limite de parâmetros do Postgres.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await db.insert(messagesTable).values(chunk).onConflictDoNothing().returning({ id: messagesTable.id });
    inserted += res.length;
  }
  const ignored = list.length - inserted;

  if (created) {
    broadcast("conversation_new", conv, { tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
    // Ficha no CRM com o mesmo nome e já em "Ativo" quando há responsável.
    await ensureCrmContactForConversation(conv);
    return { created, inserted, ignored };
  }

  // Conversa existente: atualiza o "última mensagem" só se o histórico trouxe
  // algo mais novo; acerta o nome se ainda é só o telefone.
  const patch: Partial<typeof conversationsTable.$inferInsert> = {};
  if (inserted > 0 && (!conv.lastMessageAt || newestAt > conv.lastMessageAt)) {
    patch.lastMessage = newest.d.displayContent;
    patch.lastMessageDirection = newest.m.fromMe ? "outbound" : "inbound";
    patch.lastMessageSenderName = newest.m.fromMe ? outboundSenderName : null;
    patch.lastMessageAt = newestAt;
  }
  const nameIsJustPhone = conv.name.replace(/\D/g, "") === conv.name.trim() || conv.name === conv.phone;
  if (name !== storedPhone && (nameIsJustPhone || (isGroup && conv.name === "Grupo do WhatsApp"))) patch.name = name;
  if (Object.keys(patch).length > 0) {
    const [updated] = await db.update(conversationsTable).set({ ...patch, updatedAt: new Date() })
      .where(eq(conversationsTable.id, conv.id)).returning();
    if (updated) {
      broadcast("conversation_updated", updated, { tenantId, sectorId: updated.sectorId, sessionKey: updated.sessionKey, isPotential: isPotentialConversation(updated), restrictedTo: await restrictedRecipients(updated) });
    }
  }
  return { created, inserted, ignored };
}

// Janela em que uma conversa criada pelo histórico ainda pode ser fechada
// pelo aviso de "arquivada" que chega atrasado do celular.
const ARCHIVE_GRACE_MS = 6 * 3600_000;

export interface WAHistoryArchivedPayload {
  sessionKey?: string;
  jids?: string[];
}

/**
 * O celular avisou que estas conversas estão arquivadas. Fecha (Resolvidas,
 * sem responsável) só as que o histórico criou há pouco e que não tiveram
 * nenhuma mensagem depois da importação — atendimento de verdade nunca é
 * fechado por aqui.
 */
export async function processWAHistoryArchived(payload: WAHistoryArchivedPayload, now = new Date()): Promise<{ resolved: number }> {
  const sessionKey = typeof payload.sessionKey === "string" && VALID_SESSION.test(payload.sessionKey) ? payload.sessionKey : null;
  if (!sessionKey) return { resolved: 0 };
  const tenantId = await resolveTenantForSession(sessionKey);
  if (tenantId == null) return { resolved: 0 };
  const [session] = await db.select({ historyImportEnabled: whatsappSessionsTable.historyImportEnabled })
    .from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.sessionKey, sessionKey), eq(whatsappSessionsTable.tenantId, tenantId)))
    .limit(1);
  if (!session?.historyImportEnabled) return { resolved: 0 };

  const phones = new Set<string>();
  for (const jid of (payload.jids ?? []).slice(0, 2000)) {
    if (typeof jid !== "string") continue;
    const isGroup = jid.endsWith("@g.us");
    const key = historyConversationKey(jid, isGroup);
    if (!key) continue;
    if (isGroup) phones.add(key);
    else for (const v of phoneVariants(key)) phones.add(v);
  }
  if (phones.size === 0) return { resolved: 0 };

  const since = new Date(now.getTime() - ARCHIVE_GRACE_MS);
  const updated = await db.update(conversationsTable)
    .set({ status: "resolved", assigneeId: null, attendanceStartedAt: null, updatedAt: now })
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.sessionKey, sessionKey),
      eq(conversationsTable.status, "open"),
      inArray(conversationsTable.phone, [...phones]),
      sql`${conversationsTable.createdAt} >= ${since}`,
      // Nada novo desde a importação: a última mensagem é anterior à criação.
      sql`(${conversationsTable.lastMessageAt} is null or ${conversationsTable.lastMessageAt} <= ${conversationsTable.createdAt})`,
    ))
    .returning();
  for (const conv of updated) {
    broadcast("conversation_updated", conv, { tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
  }
  return { resolved: updated.length };
}
