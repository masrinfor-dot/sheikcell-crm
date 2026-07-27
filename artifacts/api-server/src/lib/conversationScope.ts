import { db, conversationParticipantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

export function isPotentialConversation(
  conv: { assigneeId: number | null; status: string; isArchived?: boolean | null },
): boolean {
  if (conv.isArchived) return false;
  if (conv.assigneeId != null) return false;
  return !POTENTIAL_EXCLUDED_STATUSES.includes(conv.status as (typeof POTENTIAL_EXCLUDED_STATUSES)[number]);
}
