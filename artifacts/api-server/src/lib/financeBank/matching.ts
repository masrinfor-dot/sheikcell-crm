// Funções puras do motor de conciliação — sem import de @workspace/db (por
// isso rodam via `node --test` direto, sem precisar de banco). Não sabem de
// qual banco veio a transação, só enxergam o formato comum abaixo.
// O orquestrador que carrega/grava no banco fica em reconciliation.ts.

// Só repasses conciliam contra o extrato bancário diretamente — uma venda
// isolada nunca bate na conta, só o repasse consolidado que ela compõe (vendas
// se linkam ao repasse à parte, via acquirer_sales.repasse_id).
export type MatchCandidate = { id: number; amountCents: number; occurredAt: Date; externalId: string };
export type PendingTransaction = { id: number; amountCents: number; postedAt: Date; externalId: string };
export type RuleType = "external_id" | "valor_data" | "documento";
export type Match = { bankTransactionId: number; matchedRecordId: number; ruleType: RuleType };

// Um id externo idêntico é o sinal mais forte de match — sem tolerância.
export function matchByExternalId(transactions: PendingTransaction[], candidates: MatchCandidate[]): Match[] {
  const byExternalId = new Map(candidates.map((c) => [c.externalId, c]));
  const matches: Match[] = [];
  for (const tx of transactions) {
    const candidate = byExternalId.get(tx.externalId);
    if (candidate) { matches.push({ bankTransactionId: tx.id, matchedRecordId: candidate.id, ruleType: "external_id" }); byExternalId.delete(tx.externalId); }
  }
  return matches;
}

// Casa por valor (dentro de uma tolerância em centavos) e data (dentro de uma
// tolerância em dias) — greedy: cada transação fica com o candidato mais
// próximo em data ainda não reivindicado por uma transação anterior.
export function matchByValueAndDate(
  transactions: PendingTransaction[],
  candidates: MatchCandidate[],
  toleranceValueCents: number,
  toleranceDays: number,
): Match[] {
  const claimed = new Set<number>();
  const matches: Match[] = [];
  const msTolerance = toleranceDays * 24 * 60 * 60 * 1000;
  for (const tx of transactions) {
    let best: MatchCandidate | null = null;
    let bestDelta = Infinity;
    for (const c of candidates) {
      if (claimed.has(c.id)) continue;
      if (Math.abs(c.amountCents - tx.amountCents) > toleranceValueCents) continue;
      const delta = Math.abs(c.occurredAt.getTime() - tx.postedAt.getTime());
      if (delta > msTolerance) continue;
      if (delta < bestDelta) { best = c; bestDelta = delta; }
    }
    if (best) { matches.push({ bankTransactionId: tx.id, matchedRecordId: best.id, ruleType: "valor_data" }); claimed.add(best.id); }
  }
  return matches;
}

// Casa por documento do contraparte (CPF/CNPJ) + valor exatamente igual —
// documento sozinho não basta (várias transações do mesmo pagador no período).
export function matchByDocument(
  transactions: (PendingTransaction & { counterpartyDoc: string | null })[],
  candidates: (MatchCandidate & { doc: string | null })[],
): Match[] {
  const claimed = new Set<number>();
  const matches: Match[] = [];
  for (const tx of transactions) {
    if (!tx.counterpartyDoc) continue;
    const candidate = candidates.find((c) => !claimed.has(c.id) && c.doc === tx.counterpartyDoc && c.amountCents === tx.amountCents);
    if (candidate) { matches.push({ bankTransactionId: tx.id, matchedRecordId: candidate.id, ruleType: "documento" }); claimed.add(candidate.id); }
  }
  return matches;
}
