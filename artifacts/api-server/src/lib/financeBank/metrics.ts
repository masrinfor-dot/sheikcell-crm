// Agregação pura para o dashboard financeiro — sem import de @workspace/db (por
// isso roda via `node --test` direto). A rota só busca as linhas filtradas e
// chama isto; nenhuma lógica de agregação mora na rota.

export type MetricsTransaction = {
  amountCents: number;
  type: "credit" | "debit";
  postedAt: Date;
  reconciliationStatus: "pending" | "matched" | "ignored";
  storeId: number;
  storeName: string;
  provider: string;
};
export type MetricsSale = { paymentMethod: "credito" | "debito" | "pix"; grossAmountCents: number };

export type MetricsResult = {
  totals: { creditCents: number; debitCents: number; netCents: number; pendingCount: number; matchedCount: number; reconciliationRatePct: number };
  cashFlowByDay: { date: string; creditCents: number; debitCents: number }[];
  byStore: { storeId: number; storeName: string; netCents: number }[];
  byProvider: { provider: string; netCents: number }[];
  salesByPaymentMethod: { paymentMethod: "credito" | "debito" | "pix"; count: number; grossCents: number }[];
};

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function computeMetrics(transactions: MetricsTransaction[], sales: MetricsSale[]): MetricsResult {
  let creditCents = 0, debitCents = 0, pendingCount = 0, matchedCount = 0;
  const byDay = new Map<string, { creditCents: number; debitCents: number }>();
  const byStore = new Map<number, { storeName: string; netCents: number }>();
  const byProvider = new Map<string, number>();

  for (const t of transactions) {
    if (t.type === "credit") creditCents += t.amountCents; else debitCents += Math.abs(t.amountCents);
    if (t.reconciliationStatus === "matched") matchedCount++;
    else if (t.reconciliationStatus === "pending") pendingCount++;

    const key = dayKey(t.postedAt);
    const day = byDay.get(key) ?? { creditCents: 0, debitCents: 0 };
    if (t.type === "credit") day.creditCents += t.amountCents; else day.debitCents += Math.abs(t.amountCents);
    byDay.set(key, day);

    const store = byStore.get(t.storeId) ?? { storeName: t.storeName, netCents: 0 };
    store.netCents += t.amountCents;
    byStore.set(t.storeId, store);

    byProvider.set(t.provider, (byProvider.get(t.provider) ?? 0) + t.amountCents);
  }

  const bySalePayment = new Map<"credito" | "debito" | "pix", { count: number; grossCents: number }>();
  for (const s of sales) {
    const entry = bySalePayment.get(s.paymentMethod) ?? { count: 0, grossCents: 0 };
    entry.count += 1;
    entry.grossCents += s.grossAmountCents;
    bySalePayment.set(s.paymentMethod, entry);
  }

  const reconciled = matchedCount + pendingCount;

  return {
    totals: {
      creditCents, debitCents, netCents: creditCents - debitCents, pendingCount, matchedCount,
      reconciliationRatePct: reconciled > 0 ? Math.round((matchedCount / reconciled) * 1000) / 10 : 0,
    },
    cashFlowByDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v })),
    byStore: [...byStore.entries()].map(([storeId, v]) => ({ storeId, ...v }))
      .sort((a, b) => b.netCents - a.netCents),
    byProvider: [...byProvider.entries()].map(([provider, netCents]) => ({ provider, netCents }))
      .sort((a, b) => b.netCents - a.netCents),
    salesByPaymentMethod: [...bySalePayment.entries()].map(([paymentMethod, v]) => ({ paymentMethod, ...v })),
  };
}
