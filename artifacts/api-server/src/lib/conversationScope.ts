import { db, conversationParticipantsTable, conversationsTable, sectorsTable } from "@workspace/db";
import { and, eq, notInArray, sql } from "drizzle-orm";

// Shared "potencial" (new, unclaimed lead) scoping helpers.
//
// A conversation is a "potencial" when it is a fresh, unassigned, open lead.
// These are intentionally visible to ALL vendedores regardless of sector so any
// salesperson can pick them up. Once assigned (or moved to pending/resolved/
// archived) the conversation falls back to normal sector-scoped visibility.

export const POTENTIAL_EXCLUDED_STATUSES = ["pending", "resolved", "archived"] as const;

// Uma conversa "restrita" é a que já tem dono (ativa, com responsável) ou já
// foi finalizada (resolvida/arquivada). Essas só podem ser vistas por:
// admin, supervisor DO MESMO SETOR (supervisor sem setor = global) e, entre os
// vendedores, apenas o responsável e os participantes adicionados.
export function isRestrictedConversation(
  conv: { assigneeId: number | null; status: string; isArchived?: boolean | null },
): boolean {
  return conv.assigneeId != null || conv.isArchived === true
    || conv.status === "resolved" || conv.status === "archived";
}

// Lista de userIds autorizados a receber eventos de uma conversa restrita
// (responsável + participantes), ou null quando a conversa NÃO é restrita
// (segue o escopo normal por setor/potencial).
export async function restrictedRecipients(
  conv: { id: number; assigneeId: number | null; status: string; isArchived?: boolean | null },
): Promise<number[] | null> {
  if (!isRestrictedConversation(conv)) return null;
  const parts = await db
    .select({ userId: conversationParticipantsTable.userId })
    .from(conversationParticipantsTable)
    .where(eq(conversationParticipantsTable.conversationId, conv.id));
  const ids = new Set(parts.map((p) => p.userId));
  if (conv.assigneeId != null) ids.add(conv.assigneeId);
  return [...ids];
}

// Quantos atendimentos um vendedor já tem abertos agora (assigneeId = ele,
// não arquivado, não resolvido/arquivado) — usado pela fila do Central de
// Atendimento (chatQueueSingleTask) tanto pra decidir o que ele vê
// (visibilidade) quanto pra bloquear/liberar o /claim e o auto-atribuir de
// um atendimento novo além dos que já tem.
//
// Grupo de WhatsApp (JID "...@g.us") NUNCA conta aqui (pedido 14/09): um
// grupo (ex.: "Clientes VIPs") atribuído a um vendedor não pode ocupar a
// vaga de "1 atendimento por vez" da fila — senão ele fica travado pra
// sempre sem receber cliente de verdade só por ter um grupo aberto.
export async function countActiveConversations(tenantId: number, userId: number): Promise<number> {
  const [row] = await db.select({ count: sql<string>`count(*)` })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.isArchived, false),
      eq(conversationsTable.assigneeId, userId),
      notInArray(conversationsTable.status, ["resolved", "archived"]),
      sql`${conversationsTable.phone} NOT LIKE '%@g.us'`,
    ));
  return Number(row?.count ?? 0);
}

// Pedido 14/09 (Atacado): setor com "vendorsSeeResolved" ligado libera pra
// TODO vendedor daquele setor ver/reabrir qualquer atendimento Resolvido do
// setor (não só o que ele mesmo finalizou) — pra reiniciar contato e
// prospectar cliente antigo. Usado tanto na listagem (buildConversation
// VisibilityConditions em chat.ts) quanto no acesso a uma conversa
// específica (canAccessConversation).
export async function sectorAllowsResolvedAccess(sectorId: number | null | undefined): Promise<boolean> {
  if (sectorId == null) return false;
  const [row] = await db.select({ v: sectorsTable.vendorsSeeResolved }).from(sectorsTable)
    .where(eq(sectorsTable.id, sectorId)).limit(1);
  return !!row?.v;
}

// Pedido 14/09: número sequencial exibido como "Fila #N" pra todo atendimento
// que ganhou responsável vindo da fila (origin="fila" — ver conversations.ts).
// Mesmo padrão de "última posição + 1 calculada na hora" já usado em
// queue_entries.position (queue.ts) — sem sequence do Postgres. Escopo por
// loja (storeId), não por tenant inteiro: cada loja tem sua própria contagem
// de fila, do jeito que o relatório de loja já separa os outros números.
// storeId null (vendedor sem loja definida) cai num escopo próprio (também
// null) em vez de misturar com os numerados.
export async function nextQueueNumber(tenantId: number, storeId: number | null): Promise<number> {
  const [last] = await db.select({ n: conversationsTable.queueNumber })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.origin, "fila"),
      storeId == null ? sql`${conversationsTable.storeId} IS NULL` : eq(conversationsTable.storeId, storeId),
    ))
    .orderBy(sql`${conversationsTable.queueNumber} DESC NULLS LAST`)
    .limit(1);
  return (last?.n ?? 0) + 1;
}

export function isPotentialConversation(
  conv: { assigneeId: number | null; status: string; isArchived?: boolean | null },
): boolean {
  if (conv.isArchived) return false;
  if (conv.assigneeId != null) return false;
  return !POTENTIAL_EXCLUDED_STATUSES.includes(conv.status as (typeof POTENTIAL_EXCLUDED_STATUSES)[number]);
}
