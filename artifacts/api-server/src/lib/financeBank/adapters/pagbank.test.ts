import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { pagBankAdapter } from "./pagbank.ts";
import { listProviders, getBankAdapter, getAcquirerAdapter } from "./registry.ts";
import { NotImplementedError } from "./types.ts";
import type { HttpClient } from "./types.ts";
import type { BankAccount } from "@workspace/db";

const account = {} as BankAccount; // adapter não usa campos da conta nestes testes
const credential = { authType: "api_key" as const, secret: "fake-token" };

function mockHttp(json: unknown): HttpClient {
  return { async request() { return { status: 200, json }; } };
}

test("fetchTransactions mapeia o extrato mockado para o formato normalizado", async () => {
  const http = mockHttp({ items: [
    { id: "tx-1", date: "2026-01-05T10:00:00Z", amount: 15000, description: "Venda", payer_document: "12345678900" },
    { id: "tx-2", date: "2026-01-06T10:00:00Z", amount: -5000, description: "Taxa" },
  ] });
  const result = await pagBankAdapter.fetchTransactions(account, credential, http, new Date(), new Date());
  assert.equal(result.length, 2);
  assert.equal(result[0]!.type, "credit");
  assert.equal(result[0]!.amountCents, 15000);
  assert.equal(result[1]!.type, "debit");
});

test("fetchSales calcula o valor líquido (bruto - taxa)", async () => {
  const http = mockHttp({ items: [{ id: "sale-1", created_at: "2026-01-05T10:00:00Z", amount: 10000, fee_amount: 300, installments: 3, payment_method: "PIX" }] });
  const [sale] = await pagBankAdapter.fetchSales(account, credential, http, new Date(), new Date());
  assert.equal(sale!.netAmountCents, 9700);
  assert.equal(sale!.paymentMethod, "pix");
});

test("verifyWebhookSignature aceita HMAC válido e rejeita adulterado", () => {
  process.env["PAGBANK_WEBHOOK_SECRET"] = "webhook-secret";
  const body = Buffer.from(JSON.stringify({ account_id: "acc-1" }));
  const validSig = createHmac("sha256", "webhook-secret").update(body).digest("hex");
  assert.equal(pagBankAdapter.verifyWebhookSignature({ "x-pagbank-signature": validSig }, body).valid, true);
  assert.equal(pagBankAdapter.verifyWebhookSignature({ "x-pagbank-signature": "0".repeat(64) }, body).valid, false);
  assert.equal(pagBankAdapter.verifyWebhookSignature({}, body).valid, false);
});

test("registry: PagBank aparece configured=true, os outros 9 como stub", () => {
  const providers = listProviders();
  assert.equal(providers.find((p) => p.provider === "pagbank")?.configured, true);
  assert.equal(providers.filter((p) => p.configured).length, 1);
  assert.equal(providers.length, 11);
});

test("registry: adapter stub lança NotImplementedError ao ser chamado", async () => {
  const adapter = getBankAdapter("inter");
  assert.ok(adapter);
  await assert.rejects(() => adapter!.fetchBalance(account, credential, mockHttp({})), NotImplementedError);
});

test("registry: Cappta/Rede só existem como AcquirerAdapter, não como BankIntegrationAdapter", () => {
  assert.equal(getBankAdapter("cappta"), null);
  assert.ok(getAcquirerAdapter("cappta"));
});
