// Orquestrador do motor de conciliação — a única parte que toca o banco.
// Carrega os dados, delega o casamento para as funções puras de matching.ts
// (testáveis sem banco) em ordem de prioridade das regras, e grava o resultado.

import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  db, bankTransactionsTable, acquirerRepassesTable, reconciliationRulesTable,
  reconciliationMatchesTable, type BankTransaction, type AcquirerRepasse,
} from "@workspace/db";
import { matchByExternalId, matchByValueAndDate, type Match, type MatchCandidate, type PendingTransaction } from "./matching.ts";

function toCandidate(r: AcquirerRepasse): MatchCandidate {
  return { id: r.id, amountCents: r.amountCents, occurredAt: r.settledAt, externalId: r.externalRepasseId };
}
function toPending(t: BankTransaction): PendingTransaction {
  return { id: t.id, amountCents: t.amountCents, postedAt: t.postedAt, externalId: t.externalId };
}

export type ReconciliationSummary = { evaluated: number; matched: number; pending: number };

// Orquestra: carrega transações pendentes + repasses ainda não conciliados +
// regras ativas (por prioridade), aplica cada regra só sobre o que sobrou das
// anteriores, grava os matches encontrados e atualiza os status.
export async function runReconciliation(tenantId: number, storeId?: number): Promise<ReconciliationSummary> {
  const txRows = await db.select().from(bankTransactionsTable)
    .where(and(eq(bankTransactionsTable.tenantId, tenantId), eq(bankTransactionsTable.reconciliationStatus, "pending")));
  const repasseRows = await db.select().from(acquirerRepassesTable)
    .where(and(eq(acquirerRepassesTable.tenantId, tenantId), isNull(acquirerRepassesTable.reconciledTransactionId)));
  const rules = await db.select().from(reconciliationRulesTable)
    .where(and(eq(reconciliationRulesTable.tenantId, tenantId), eq(reconciliationRulesTable.isActive, true)))
    .orderBy(reconciliationRulesTable.priority);

  // storeId filtra pela loja dona da conta bancária — como bank_transactions
  // não guarda storeId diretamente (só via bank_accounts), o filtro por loja
  // fica a cargo de quem chama (rota já filtra o conjunto antes de passar
  // aqui) nesta primeira versão; deixado explícito para não confundir.
  void storeId;

  let pendingTx = txRows.map(toPending);
  let pendingCandidates = repasseRows.map(toCandidate);
  const allMatches: (Match & { ruleId: number | null })[] = [];

  for (const rule of rules) {
    if (pendingTx.length === 0 || pendingCandidates.length === 0) break;
    let found: Match[] = [];
    if (rule.ruleType === "external_id") {
      found = matchByExternalId(pendingTx, pendingCandidates);
    } else if (rule.ruleType === "valor_data") {
      found = matchByValueAndDate(pendingTx, pendingCandidates, rule.toleranceValueCents ?? 0, rule.toleranceDays ?? 0);
    } else if (rule.ruleType === "documento") {
      // Repasses de credenciadora não carregam CPF/CNPJ do pagador nesta fase
      // (só bank_transactions.counterpartyDoc tem essa informação) — não há
      // hoje um "doc" do lado do repasse para casar contra. matchByDocument
      // (em matching.ts) já existe pronta e testada para quando essa fonte de
      // dado existir (ex.: contas a receber do CRM), mas não tem candidato aqui ainda.
      found = [];
    }
    for (const m of found) allMatches.push({ ...m, ruleId: rule.id });
    const matchedTxIds = new Set(found.map((m) => m.bankTransactionId));
    const matchedCandidateIds = new Set(found.map((m) => m.matchedRecordId));
    pendingTx = pendingTx.filter((t) => !matchedTxIds.has(t.id));
    pendingCandidates = pendingCandidates.filter((c) => !matchedCandidateIds.has(c.id));
  }

  if (allMatches.length > 0) {
    await db.insert(reconciliationMatchesTable).values(allMatches.map((m) => ({
      tenantId, bankTransactionId: m.bankTransactionId, matchedType: "acquirer_repasse" as const,
      matchedRecordId: m.matchedRecordId, ruleId: m.ruleId, matchedBy: "system", status: "auto" as const,
    })));
    await db.update(bankTransactionsTable).set({ reconciliationStatus: "matched" })
      .where(inArray(bankTransactionsTable.id, allMatches.map((m) => m.bankTransactionId)));
    // Um UPDATE por match (não dá para agrupar num só IN, cada repasse liga a
    // uma transação diferente) — volume baixo o bastante para não precisar de bulk update aqui.
    for (const m of allMatches) {
      await db.update(acquirerRepassesTable).set({ reconciledTransactionId: m.bankTransactionId })
        .where(eq(acquirerRepassesTable.id, m.matchedRecordId));
    }
  }

  return { evaluated: txRows.length, matched: allMatches.length, pending: txRows.length - allMatches.length };
}
