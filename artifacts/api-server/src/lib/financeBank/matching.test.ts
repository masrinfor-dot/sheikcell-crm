import { test } from "node:test";
import assert from "node:assert/strict";
import { matchByExternalId, matchByValueAndDate, matchByDocument } from "./matching.ts";

test("matchByExternalId casa quando o id externo é idêntico", () => {
  const txs = [{ id: 1, amountCents: 1000, postedAt: new Date(), externalId: "abc" }];
  const candidates = [{ id: 10, amountCents: 999, occurredAt: new Date(), externalId: "abc" }];
  const matches = matchByExternalId(txs, candidates);
  assert.deepEqual(matches, [{ bankTransactionId: 1, matchedRecordId: 10, ruleType: "external_id" }]);
});

test("matchByExternalId não casa quando os ids diferem", () => {
  const txs = [{ id: 1, amountCents: 1000, postedAt: new Date(), externalId: "abc" }];
  const candidates = [{ id: 10, amountCents: 1000, occurredAt: new Date(), externalId: "xyz" }];
  assert.deepEqual(matchByExternalId(txs, candidates), []);
});

test("matchByValueAndDate casa dentro da tolerância e ignora fora dela", () => {
  const day = 24 * 60 * 60 * 1000;
  const txs = [
    { id: 1, amountCents: 10000, postedAt: new Date("2026-01-10T00:00:00Z"), externalId: "t1" },
    { id: 2, amountCents: 5000, postedAt: new Date("2026-01-10T00:00:00Z"), externalId: "t2" },
  ];
  const candidates = [
    { id: 100, amountCents: 10050, occurredAt: new Date(new Date("2026-01-10T00:00:00Z").getTime() + day), externalId: "c1" }, // dentro: 50 centavos, 1 dia
    { id: 200, amountCents: 5000, occurredAt: new Date(new Date("2026-01-10T00:00:00Z").getTime() + 10 * day), externalId: "c2" }, // fora: 10 dias
  ];
  const matches = matchByValueAndDate(txs, candidates, 100, 2);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.bankTransactionId, 1);
  assert.equal(matches[0]!.matchedRecordId, 100);
});

test("matchByValueAndDate não reaproveita o mesmo candidato para duas transações", () => {
  const now = new Date("2026-01-10T00:00:00Z");
  const txs = [
    { id: 1, amountCents: 10000, postedAt: now, externalId: "t1" },
    { id: 2, amountCents: 10000, postedAt: now, externalId: "t2" },
  ];
  const candidates = [{ id: 100, amountCents: 10000, occurredAt: now, externalId: "c1" }];
  const matches = matchByValueAndDate(txs, candidates, 0, 0);
  assert.equal(matches.length, 1); // só a primeira transação fica com o único candidato
});

test("matchByDocument exige documento E valor iguais", () => {
  const txs = [
    { id: 1, amountCents: 10000, postedAt: new Date(), externalId: "t1", counterpartyDoc: "12345678900" },
    { id: 2, amountCents: 20000, postedAt: new Date(), externalId: "t2", counterpartyDoc: null },
  ];
  const candidates = [
    { id: 100, amountCents: 10000, occurredAt: new Date(), externalId: "c1", doc: "12345678900" },
    { id: 200, amountCents: 20000, occurredAt: new Date(), externalId: "c2", doc: "99999999999" },
  ];
  const matches = matchByDocument(txs, candidates);
  assert.deepEqual(matches, [{ bankTransactionId: 1, matchedRecordId: 100, ruleType: "documento" }]);
});
