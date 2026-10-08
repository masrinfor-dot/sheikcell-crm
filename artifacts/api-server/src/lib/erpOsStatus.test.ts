// Situação da OS pelo robô: detecção da pergunta e texto da resposta (puros —
// a consulta ao ERP em si é coberta no ERP; aqui não precisa de banco).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";

const { detectOsStatusQuestion, formatOsStatusReply } = await import("./erpOsStatus.ts");
type Item = Parameters<typeof formatOsStatusReply>[0]["orders"][number];

function os(over: Partial<Item> = {}): Item {
  return {
    number: "LJ01-2026-000004",
    store: { name: "SHEIKCELL CENTRO", phone: "(33) 3522-0000" },
    equipment: { type: "PHONE", typeLabel: "Celular", brand: "Apple", model: "iPhone 13", description: "Apple iPhone 13" },
    status: "EM_SERVICO",
    statusLabel: "Em serviço",
    message: "O conserto está em andamento.",
    forecast: { at: "2026-10-08T21:00:00.000Z", text: "08/10 às 18:00", dependsOnPart: false },
    readyForPickup: false,
    total: null,
    amountDue: null,
    technicianFirstName: "João",
    openedAt: "2026-10-05T13:00:00.000Z",
    lastUpdate: "2026-10-07T12:00:00.000Z",
    ...over,
  };
}

test("detecta o número da OS na mensagem do cliente", () => {
  assert.deepEqual(
    detectOsStatusQuestion("Olá! Quero falar sobre a OS LJ01-2026-0004 ... meu celular como que tá??"),
    { number: "LJ01-2026-0004" },
  );
  assert.deepEqual(detectOsStatusQuestion("os lj01-2026-000004"), { number: "LJ01-2026-000004" });
});

test("detecta perguntas de situação sem número", () => {
  for (const text of [
    "meu celular já ficou pronto?",
    "Bom dia, como que tá o meu celular?",
    "qual a situação do meu conserto",
    "queria saber da minha OS",
    "o aparelho já está pronto?",
    "tem previsão do meu iphone?",
    "minha ordem de serviço",
  ]) {
    assert.deepEqual(detectOsStatusQuestion(text), { number: null }, text);
  }
});

test("não confunde com outros assuntos", () => {
  for (const text of [
    "quanto custa a tela do iphone 13?",
    "vocês têm capinha?",
    "quero comprar um celular",
    "meu celular quebrou a tela",
    "quero ver os fones",
    "",
  ]) {
    assert.equal(detectOsStatusQuestion(text), undefined, text);
  }
});

test("uma OS: situação, previsão, loja e telefone", () => {
  const text = formatOsStatusReply({ found: true, orders: [os()] })!;
  assert.match(text, /LJ01-2026-000004/);
  assert.match(text, /Apple iPhone 13/);
  assert.match(text, /\*Em serviço\*/);
  assert.match(text, /08\/10 às 18:00/);
  assert.match(text, /SHEIKCELL CENTRO/);
  assert.match(text, /\(33\) 3522-0000/);
  assert.doesNotMatch(text, /retirar/);
});

test("pronta: pode retirar com o valor a pagar; depende de peça", () => {
  const ready = formatOsStatusReply({ found: true, orders: [os({ readyForPickup: true, forecast: null, total: 350, amountDue: 300, statusLabel: "Pronto para retirar" })] })!;
  assert.match(ready, /Pode retirar/);
  assert.match(ready, /R\$\s?300,00/);
  const paid = formatOsStatusReply({ found: true, orders: [os({ readyForPickup: true, forecast: null, total: 350, amountDue: 0 })] })!;
  assert.match(paid, /já está pago/);
  const part = formatOsStatusReply({ found: true, orders: [os({ forecast: { at: null, text: "Depende da chegada da peça", dependsOnPart: true } })] })!;
  assert.match(part, /depende da chegada da peça/);
});

test("várias OS: lista curta; número pedido que não é do cliente avisa antes", () => {
  const text = formatOsStatusReply(
    { found: true, orders: [os(), os({ number: "LJ02-2026-000010", readyForPickup: true, forecast: null, amountDue: 120, statusLabel: "Pronto para retirar" })] },
    "LJ01-2026-0099",
  )!;
  assert.match(text, /^Não encontrei a OS LJ01-2026-0099/);
  assert.match(text, /2 ordens de serviço em aberto/);
  assert.match(text, /LJ02-2026-000010.*pode retirar \(a pagar R\$\s?120,00\)/);
});

test("nada encontrado: sem resposta (robô segue para o atendente)", () => {
  assert.equal(formatOsStatusReply({ found: false, orders: [] }), null);
});
