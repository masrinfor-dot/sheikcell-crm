// Shared "potencial" (new, unclaimed lead) scoping helpers.
//
// A conversation is a "potencial" when it is a fresh, unassigned, open lead.
// These are intentionally visible to ALL vendedores regardless of sector so any
// salesperson can pick them up. Once assigned (or moved to pending/resolved/
// archived) the conversation falls back to normal sector-scoped visibility.

export const POTENTIAL_EXCLUDED_STATUSES = ["pending", "resolved", "archived"] as const;

export function isPotentialConversation(
  conv: { assigneeId: number | null; status: string; isArchived?: boolean | null },
): boolean {
  if (conv.isArchived) return false;
  if (conv.assigneeId != null) return false;
  return !POTENTIAL_EXCLUDED_STATUSES.includes(conv.status as (typeof POTENTIAL_EXCLUDED_STATUSES)[number]);
}
