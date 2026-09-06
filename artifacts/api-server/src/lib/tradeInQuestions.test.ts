import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUESTIONS, sanitizeQuestions, validateTradeInAnswers, totalDeductionPercent, type QuestionCfg } from "./tradeInQuestions.ts";

// Questionário customizado mínimo para os testes de validação.
const CUSTOM: QuestionCfg[] = [
  { key: "Liga", label: "Liga?", options: [{ label: "Sim", blocks: false }, { label: "Não liga", blocks: true }] },
  { key: "Tela", label: "Tela ok?", options: [{ label: "Sim", blocks: false }, { label: "Quebrada", blocks: true }] },
];

const fullOk = { Liga: "Sim", Tela: "Sim" };

test("aceita respostas completas e válidas", () => {
  assert.deepEqual(validateTradeInAnswers(CUSTOM, fullOk), { ok: true });
});

test("bloqueia quando a opção escolhida está marcada como bloqueia (422)", () => {
  const r = validateTradeInAnswers(CUSTOM, { Liga: "Sim", Tela: "Quebrada" });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 422); assert.match(r.error, /tela/); }
});

test("rejeita quando falta a resposta de uma pergunta bloqueante (400)", () => {
  // Burla clássica: omitir a pergunta que bloquearia.
  const r = validateTradeInAnswers(CUSTOM, { Liga: "Sim" });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 400); assert.match(r.error, /Tela/); }
});

test("rejeita valor inventado que não é opção configurada (400)", () => {
  const r = validateTradeInAnswers(CUSTOM, { Liga: "Sim", Tela: "Perfeita demais" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("rejeita chave desconhecida fora do questionário (400)", () => {
  const r = validateTradeInAnswers(CUSTOM, { ...fullOk, Extra: "Sim" });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 400); assert.match(r.error, /desconhecida/); }
});

test("questionário padrão: 'Não liga' NÃO bloqueia (política 'compramos com qualquer defeito', rodada 16)", () => {
  const answers: Record<string, string> = {};
  for (const q of DEFAULT_QUESTIONS.apple) answers[q.key] = q.options[0]!.label;
  answers["Liga"] = "Não liga";
  const r = validateTradeInAnswers(DEFAULT_QUESTIONS.apple, answers);
  assert.deepEqual(r, { ok: true });
});

test("questionário padrão: respostas todas boas passam", () => {
  const answers: Record<string, string> = {};
  for (const q of DEFAULT_QUESTIONS.android) answers[q.key] = q.options[0]!.label;
  assert.deepEqual(validateTradeInAnswers(DEFAULT_QUESTIONS.android, answers), { ok: true });
});

test("sanitizeQuestions aceita config válida e normaliza blocks", () => {
  const { config, error } = sanitizeQuestions({
    apple: [{ key: "Liga", label: "Liga?", options: [{ label: "Sim" }, { label: "Não liga", blocks: true }] }],
    android: [{ key: "Tela", label: "Tela ok?", options: [{ label: "Sim" }, { label: "Quebrada", blocks: 1 }] }],
  });
  assert.equal(error, undefined);
  assert.equal(config!.apple[0]!.options[0]!.blocks, false);
  assert.equal(config!.android[0]!.options[1]!.blocks, true);
});

test("sanitizeQuestions rejeita lista vazia, opção única e todas bloqueando", () => {
  assert.ok(sanitizeQuestions({ apple: [], android: CUSTOM }).error);
  assert.ok(sanitizeQuestions({ apple: [{ key: "A", label: "a", options: [{ label: "x" }] }], android: CUSTOM }).error);
  assert.ok(sanitizeQuestions({
    apple: [{ key: "A", label: "a", options: [{ label: "x", blocks: true }, { label: "y", blocks: true }] }],
    android: CUSTOM,
  }).error);
});

test("sanitizeQuestions normaliza deductionPercent (clamp 0-100, omite quando 0)", () => {
  const { config, error } = sanitizeQuestions({
    apple: [{ key: "Tela", label: "Tela ok?", options: [{ label: "Sim", deductionPercent: 0 }, { label: "Quebrada", deductionPercent: 150 }] }],
    android: CUSTOM,
  });
  assert.equal(error, undefined);
  assert.equal(config!.apple[0]!.options[0]!.deductionPercent, undefined);
  assert.equal(config!.apple[0]!.options[1]!.deductionPercent, 100);
});

test("totalDeductionPercent soma os descontos das respostas escolhidas, com teto de 90", () => {
  const withDeductions: QuestionCfg[] = [
    { key: "Tela", label: "Tela ok?", options: [{ label: "Sim", blocks: false }, { label: "Quebrada", blocks: false, deductionPercent: 40 }] },
    { key: "Bateria", label: "Bateria ok?", options: [{ label: "Sim", blocks: false }, { label: "Ruim", blocks: false, deductionPercent: 30 }] },
  ];
  assert.equal(totalDeductionPercent(withDeductions, { Tela: "Sim", Bateria: "Sim" }), 0);
  assert.equal(totalDeductionPercent(withDeductions, { Tela: "Quebrada", Bateria: "Sim" }), 40);
  assert.equal(totalDeductionPercent(withDeductions, { Tela: "Quebrada", Bateria: "Ruim" }), 70);
  // Teto de 90% mesmo somando mais que isso.
  const heavy: QuestionCfg[] = [
    { key: "A", label: "a", options: [{ label: "x", blocks: false, deductionPercent: 60 }] },
    { key: "B", label: "b", options: [{ label: "y", blocks: false, deductionPercent: 60 }] },
  ];
  assert.equal(totalDeductionPercent(heavy, { A: "x", B: "y" }), 90);
});
