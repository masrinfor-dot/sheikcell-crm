import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTradeInKey, findBaseValueMatch, type BaseValueRow } from "./tradeInBaseValues.ts";

test("normalizeTradeInKey ignora acento, caixa e espaço duplicado", () => {
  assert.equal(normalizeTradeInKey("iPhone 13 Pró Max"), normalizeTradeInKey("IPHONE   13 PRO MAX"));
});

const ROWS: BaseValueRow[] = [
  { brand: "Apple", model: "iPhone 13", storage: "128GB", baseValue: 2000 },
  { brand: "Apple", model: "iPhone 13", storage: "256GB", baseValue: 2300 },
  { brand: "Apple", model: "iPhone SE", storage: null, baseValue: 1200 },
];

test("findBaseValueMatch acha o mesmo armazenamento exato", () => {
  const r = findBaseValueMatch(ROWS, "apple", "iphone 13", "256gb");
  assert.equal(r?.baseValue, 2300);
});

test("findBaseValueMatch cai pra linha sem armazenamento (vale qualquer tamanho)", () => {
  const r = findBaseValueMatch(ROWS, "Apple", "iPhone SE", "64GB");
  assert.equal(r?.baseValue, 1200);
});

test("findBaseValueMatch sem armazenamento pedido usa a primeira linha do modelo", () => {
  const r = findBaseValueMatch(ROWS, "Apple", "iPhone 13", null);
  assert.equal(r?.baseValue, 2000);
});

test("findBaseValueMatch retorna null quando o modelo não está na tabela", () => {
  assert.equal(findBaseValueMatch(ROWS, "Samsung", "Galaxy S21", "128GB"), null);
});
