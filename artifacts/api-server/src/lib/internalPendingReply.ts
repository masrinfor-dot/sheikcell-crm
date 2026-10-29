import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, internalConversationMembersTable, internalMessagesTable, usersTable } from "@workspace/db";

// Tela "Equipe" (29/10/2026): selo "sem resposta há X" nas conversas do chat
// interno — alguém te mandou mensagem e você ainda não respondeu.
//  - Conversa direta: qualquer mensagem do outro depois da sua última.
//  - Grupo / sala da equipe: só conta o que é PARA você — @menção do seu nome
//    (com ou sem acento) ou resposta a uma mensagem sua. Conversa do grupo
//    entre outras pessoas não cobra ninguém. Grupo com só duas pessoas de
//    verdade (ex.: sala "📋 Gerente · Pessoa" = dono + pessoa + bot) conta
//    como conversa direta.
// Ler não conta como responder. Mensagem do Gerente IA (usuário inativo/bot)
// não conta. Olha só os últimos 7 dias.

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export type PendingCandidate = { createdAt: Date; content: string; replyToSenderId: number | null };

/** A mensagem fala com essa pessoa? (@Nome completo ou @PrimeiroNome, sem ligar para acento/maiúscula) */
export function mentionsName(content: string, name: string): boolean {
  const text = fold(content);
  const full = fold(name).trim().replace(/\s+/g, " ");
  if (!full) return false;
  const first = full.split(" ")[0]!;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const n of new Set([full, first])) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])@${esc(n)}(?![\\p{L}\\p{N}])`, "u").test(text)) return true;
  }
  return false;
}

/**
 * Desde quando a pessoa está devendo resposta nesta conversa (null = não deve).
 * `candidates` = mensagens dos outros depois da última dela, em ordem.
 */
export function pendingSince(
  kind: string,
  candidates: PendingCandidate[],
  me: { id: number; name: string },
): Date | null {
  for (const c of candidates) {
    if (kind === "direct") return c.createdAt;
    if (c.replyToSenderId === me.id || mentionsName(c.content, me.name)) return c.createdAt;
  }
  return null;
}

/** Para cada conversa da lista: desde quando a pessoa deve resposta (só as que devem). */
export async function pendingReplyMap(
  tenantId: number,
  me: { id: number; name: string },
  convs: { id: number; kind: string }[],
  now = new Date(),
): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  const ids = convs.map((c) => c.id);
  if (!ids.length) return out;
  const floor = new Date(now.getTime() - WINDOW_MS);

  const mine = await db.select({
    conversationId: internalMessagesTable.conversationId,
    at: sql<string>`max(${internalMessagesTable.createdAt})`,
  }).from(internalMessagesTable)
    .where(and(
      eq(internalMessagesTable.tenantId, tenantId),
      inArray(internalMessagesTable.conversationId, ids),
      eq(internalMessagesTable.senderId, me.id),
      isNull(internalMessagesTable.deletedAt),
      gt(internalMessagesTable.createdAt, floor),
    ))
    .groupBy(internalMessagesTable.conversationId);
  const myLast = new Map(mine.map((r) => [r.conversationId, new Date(r.at)]));

  const rt = alias(internalMessagesTable, "reply_target");
  const rows = await db.select({
    conversationId: internalMessagesTable.conversationId,
    createdAt: internalMessagesTable.createdAt,
    content: internalMessagesTable.content,
    replyToSenderId: rt.senderId,
  }).from(internalMessagesTable)
    .innerJoin(usersTable, eq(usersTable.id, internalMessagesTable.senderId))
    .leftJoin(rt, eq(rt.id, internalMessagesTable.replyToId))
    .where(and(
      eq(internalMessagesTable.tenantId, tenantId),
      inArray(internalMessagesTable.conversationId, ids),
      ne(internalMessagesTable.senderId, me.id),
      eq(usersTable.isActive, true),
      isNull(internalMessagesTable.deletedAt),
      gt(internalMessagesTable.createdAt, floor),
    ))
    .orderBy(desc(internalMessagesTable.createdAt))
    .limit(3000);

  const byConv = new Map<number, PendingCandidate[]>();
  for (const r of rows) {
    const last = myLast.get(r.conversationId);
    if (last && r.createdAt <= last) continue;
    const list = byConv.get(r.conversationId) ?? [];
    list.push({ createdAt: r.createdAt, content: r.content, replyToSenderId: r.replyToSenderId ?? null });
    byConv.set(r.conversationId, list);
  }
  const groupIds = convs.filter((c) => c.kind !== "direct" && byConv.has(c.id)).map((c) => c.id);
  const people = groupIds.length
    ? await db.select({ conversationId: internalConversationMembersTable.conversationId, n: sql<number>`count(*)::int` })
        .from(internalConversationMembersTable)
        .innerJoin(usersTable, eq(usersTable.id, internalConversationMembersTable.userId))
        .where(and(inArray(internalConversationMembersTable.conversationId, groupIds), eq(usersTable.isActive, true)))
        .groupBy(internalConversationMembersTable.conversationId)
    : [];
  const twoPeople = new Set(people.filter((r) => r.n <= 2).map((r) => r.conversationId));
  for (const c of convs) {
    const list = byConv.get(c.id);
    if (!list) continue;
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const since = pendingSince(twoPeople.has(c.id) ? "direct" : c.kind, list, me);
    if (since) out.set(c.id, since);
  }
  return out;
}
