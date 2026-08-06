import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "./metrics.ts";

const base = { storeId: 1, storeName: "Loja MT", provider: "pagbank" as const };

test("totals soma créditos e débitos separadamente e calcula o líquido", () => {
  const r = computeMetrics([
    { ...base, amountCents: 10000, type: "credit", postedAt: new Date("2026-01-05"), reconciliationStatus: "matched" },
    { ...base, amountCents: -3000, type: "debit", postedAt: new Date("2026-01-05"), reconciliationStatus: "pending" },
  ], []);
  assert.equal(r.totals.creditCents, 10000);
  assert.equal(r.totals.debitCents, 3000);
  assert.equal(r.totals.netCents, 7000);
});

test("taxa de conciliação é matched / (matched + pending), ignorados não contam", () => {
  const r = computeMetrics([
    { ...base, amountCents: 100, type: "credit", postedAt: new Date(), reconciliationStatus: "matched" },
    { ...base, amountCents: 100, type: "credit", postedAt: new Date(), reconciliationStatus: "matched" },
    { ...base, amountCents: 100, type: "credit", postedAt: new Date(), reconciliationStatus: "pending" },
    { ...base, amountCents: 100, type: "credit", postedAt: new Date(), reconciliationStatus: "ignored" },
  ], []);
  assert.equal(r.totals.reconciliationRatePct, 66.7);
});

test("taxa de conciliação é 0 quando não há transações (evita divisão por zero)", () => {
  const r = computeMetrics([], []);
  assert.equal(r.totals.reconciliationRatePct, 0);
});

test("cashFlowByDay agrupa por dia (UTC) e vem ordenado", () => {
  const r = computeMetrics([
    { ...base, amountCents: 500, type: "credit", postedAt: new Date("2026-01-06T10:00:00Z"), reconciliationStatus: "matched" },
    { ...base, amountCents: 200, type: "credit", postedAt: new Date("2026-01-05T23:00:00Z"), reconciliationStatus: "matched" },
    { ...base, amountCents: -100, type: "debit", postedAt: new Date("2026-01-05T01:00:00Z"), reconciliationStatus: "matched" },
  ], []);
  assert.deepEqual(r.cashFlowByDay, [
    { date: "2026-01-05", creditCents: 200, debitCents: 100 },
    { date: "2026-01-06", creditCents: 500, debitCents: 0 },
  ]);
});

test("byStore agrega o líquido (créditos - débitos) por loja, ordenado do maior para o menor", () => {
  const r = computeMetrics([
    { storeId: 1, storeName: "Loja MT", provider: "pagbank", amountCents: 1000, type: "credit", postedAt: new Date(), reconciliationStatus: "matched" },
    { storeId: 2, storeName: "Loja PP", provider: "pagbank", amountCents: 5000, type: "credit", postedAt: new Date(), reconciliationStatus: "matched" },
    { storeId: 1, storeName: "Loja MT", provider: "pagbank", amountCents: -200, type: "debit", postedAt: new Date(), reconciliationStatus: "matched" },
  ], []);
  assert.deepEqual(r.byStore, [
    { storeId: 2, storeName: "Loja PP", netCents: 5000 },
    { storeId: 1, storeName: "Loja MT", netCents: 800 },
  ]);
});

test("salesByPaymentMethod conta e soma o valor bruto por forma de pagamento", () => {
  const r = computeMetrics([], [
    { paymentMethod: "credito", grossAmountCents: 10000 },
    { paymentMethod: "credito", grossAmountCents: 5000 },
    { paymentMethod: "pix", grossAmountCents: 3000 },
  ]);
  const credito = r.salesByPaymentMethod.find((p) => p.paymentMethod === "credito");
  assert.deepEqual(credito, { paymentMethod: "credito", count: 2, grossCents: 15000 });
});
