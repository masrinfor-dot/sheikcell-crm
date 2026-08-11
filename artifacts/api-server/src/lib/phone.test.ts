import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, phoneVariants } from "./phone.ts";

test("normalizePhone: celular sem DDI e sem o 9 vira a forma canônica", () => {
  assert.equal(normalizePhone("11987654321"), "5511987654321");
});

test("normalizePhone: já canônico não muda", () => {
  assert.equal(normalizePhone("5511987654321"), "5511987654321");
});

test("normalizePhone: com DDI mas sem o 9 do celular ganha o 9", () => {
  assert.equal(normalizePhone("551187654321"), "5511987654321");
});

test("normalizePhone: fixo (8 dígitos começando em 2-5) não ganha 9", () => {
  assert.equal(normalizePhone("1133334444"), "551133334444");
  assert.equal(normalizePhone("551133334444"), "551133334444");
});

test("normalizePhone: remove formatação (espaço, parênteses, traço, +)", () => {
  assert.equal(normalizePhone("+55 (11) 98765-4321"), "5511987654321");
});

test("normalizePhone: remove o 0 de discagem interurbana", () => {
  assert.equal(normalizePhone("011987654321"), "5511987654321");
});

test("normalizePhone: vazio/nulo não quebra", () => {
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
  assert.equal(normalizePhone(undefined), "");
});

test("phoneVariants: cobre as 4 formas do mesmo número (com/sem 55, com/sem 9)", () => {
  const variants = phoneVariants("11987654321").sort();
  assert.deepEqual(variants, ["1187654321", "11987654321", "551187654321", "5511987654321"].sort());
});

test("phoneVariants: já vindo sem o 9 e sem DDI cobre as mesmas 4 formas", () => {
  const variants = phoneVariants("1187654321").sort();
  assert.deepEqual(variants, ["1187654321", "11987654321", "551187654321", "5511987654321"].sort());
});

test("phoneVariants: fixo não gera variação com 9 inventado", () => {
  const variants = phoneVariants("551133334444").sort();
  assert.deepEqual(variants, ["1133334444", "551133334444"].sort());
});

test("phoneVariants: vazio devolve lista vazia", () => {
  assert.deepEqual(phoneVariants(""), []);
});
