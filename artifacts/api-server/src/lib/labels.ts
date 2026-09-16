// Etiquetas (chat_labels) aplicadas automaticamente pela IA do robô — pedido
// 16/09: "crie e utilize etiquetas, evite repetir etiqueta ou criar com
// semelhança". A IA já recebe a lista de etiquetas existentes no prompt da
// ferramenta (ver applyLabelTool em bot.ts) e é instruída a reaproveitar uma
// existente sempre que possível; esta camada é a rede de segurança do lado
// do servidor — mesmo que o modelo "erre" e peça um nome levemente diferente
// (plural, acento, gralha de digitação), resolveOrCreateLabel reconhece a
// semelhança e reaproveita a etiqueta já cadastrada em vez de criar outra.
import { db, chatLabelsTable, conversationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";

function normalizeLabel(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

// Distância de edição (Levenshtein) — só usada em strings curtas (nomes de
// etiqueta, tipicamente 2-4 palavras), então O(m*n) nunca é um problema aqui.
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

// Etiqueta muito curta (<=4 caracteres normalizados) só reaproveita em match
// EXATO — nomes curtos como "VIP" e "PIX" não podem ser fundidos por
// coincidência de poucos caracteres. Acima disso, tolera ~20% de distância
// (cobre plural/singular — "orçamento"/"orçamentos" tem distância 1 — e
// pequenas gralhas de digitação) sem fundir termos realmente diferentes.
function isSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 4) return false;
  const dist = levenshtein(a, b);
  return dist <= Math.max(1, Math.floor(maxLen * 0.2));
}

/**
 * Resolve um nome de etiqueta pedido (pela IA, ou por qualquer outra
 * automação futura) pra uma etiqueta JÁ EXISTENTE da loja quando for
 * parecida o bastante, ou cria uma nova quando não há nada parecido.
 * Nunca cria uma segunda etiqueta visivelmente duplicada.
 */
export async function resolveOrCreateLabel(
  tenantId: number,
  requestedName: string,
): Promise<{ id: number; name: string; created: boolean } | null> {
  const name = requestedName.trim().slice(0, 60);
  if (!name) return null;
  const existing = await db.select().from(chatLabelsTable)
    .where(and(eq(chatLabelsTable.tenantId, tenantId), eq(chatLabelsTable.isActive, true)));
  const normReq = normalizeLabel(name);
  const match = existing.find((l) => isSimilar(normalizeLabel(l.name), normReq));
  if (match) return { id: match.id, name: match.name, created: false };

  // Paleta simples, cicla por quantidade de etiquetas já cadastradas — só
  // pra cada etiqueta nova não nascer todas da mesma cor.
  const PALETTE = ["#1a2e6e", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0369a1", "#4d7c0f"];
  const color = PALETTE[existing.length % PALETTE.length]!;
  const [created] = await db.insert(chatLabelsTable)
    .values({ tenantId, name, color, sortOrder: existing.length })
    .returning();
  return created ? { id: created.id, name: created.name, created: true } : null;
}

/**
 * Anexa a etiqueta (por nome) na conversa — conversations.labels é uma
 * string separada por vírgula (sem tabela de junção, ver schema/conversations.ts).
 * Não duplica se a conversa já tiver essa etiqueta (comparação normalizada).
 */
export async function attachLabelToConversation(conversationId: number, labelName: string): Promise<void> {
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  if (!conv) return;
  const current = (conv.labels ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const already = current.some((c) => normalizeLabel(c) === normalizeLabel(labelName));
  if (already) return;
  const next = [...current, labelName].join(", ");
  const [updated] = await db.update(conversationsTable).set({ labels: next, updatedAt: new Date() })
    .where(eq(conversationsTable.id, conversationId)).returning();
  if (!updated) return;
  broadcast("conversation_updated", updated, {
    tenantId: updated.tenantId,
    sectorId: updated.sectorId,
    sessionKey: updated.sessionKey,
    isPotential: isPotentialConversation(updated) || isPotentialConversation(conv),
    restrictedTo: await restrictedRecipients(updated),
  });
}
