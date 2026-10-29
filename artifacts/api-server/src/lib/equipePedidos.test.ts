// Tela "Equipe": leitura do "Pedir algo para alguém" e regras do quadro de
// pedidos. As funções moram no front (artifacts/sheikcell/src/lib/equipePedidos.ts,
// sem imports); este teste as carrega daqui. Fica fora do typecheck do
// api-server (tsconfig "exclude") porque importa um arquivo de fora de src —
// o typecheck do front cobre o arquivo testado.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePedido, dueBadge, replyLateText, columnOf, inScope, scopeCounts, whoText, linkOf, formatDue, sortPedidos,
  type PedidoTask,
} from "../../../sheikcell/src/lib/equipePedidos.ts";

const people = [
  { id: 1, name: "Samuel Masri" },
  { id: 2, name: "Lucelia" },
  { id: 3, name: "Gabriel" },
  { id: 4, name: "Gabrielly" },
  { id: 5, name: "Ana Paula" },
  { id: 6, name: "Ana Clara" },
];

// Quinta-feira, 29/10/2026, 14:00 em Brasília (17:00 UTC).
const NOW = new Date("2026-10-29T17:00:00Z");
const br = (iso: string) => new Date(`${iso}-03:00`).toISOString();

test("@nome + até 16h: responsável, prazo hoje e título limpo", () => {
  const r = parsePedido("@Lucélia separar 2 telas A15 para o Jorge até 16h", people, NOW);
  assert.equal(r.assignee?.id, 2);
  assert.equal(r.mention, "Lucélia");
  assert.equal(r.unknownMention, false);
  assert.equal(r.title, "Separar 2 telas A15 para o Jorge");
  assert.equal(r.due?.toISOString(), br("2026-10-29T16:00:00"));
});

test("nome com acento acha cadastro sem acento e vice-versa; maiúscula não importa", () => {
  assert.equal(parsePedido("@LUCELIA ver isso", people, NOW).assignee?.id, 2);
  assert.equal(parsePedido("@gabrielly ver isso", people, NOW).assignee?.id, 4);
  assert.equal(parsePedido("@Samuel conferir pix", people, NOW).assignee?.id, 1);
  assert.equal(parsePedido("@Masri conferir pix", people, NOW).assignee?.id, 1);
});

test("@nome no meio do texto e nome composto", () => {
  const r = parsePedido("Conferir o caixa @Ana Paula até amanhã 10h", people, NOW);
  assert.equal(r.assignee?.id, 5);
  assert.equal(r.title, "Conferir o caixa");
  assert.equal(r.due?.toISOString(), br("2026-10-30T10:00:00"));
});

test("dois com o mesmo primeiro nome: pede para escolher", () => {
  const r = parsePedido("@Ana trocar a vitrine", people, NOW);
  assert.equal(r.assignee, null);
  assert.equal(r.unknownMention, false);
  assert.deepEqual(r.candidates.map((p) => p.id).sort(), [5, 6]);
});

test("nome que não existe: avisa (unknownMention) e não escolhe ninguém", () => {
  const r = parsePedido("@Jorginho buscar peça até 17h", people, NOW);
  assert.equal(r.assignee, null);
  assert.equal(r.unknownMention, true);
  assert.equal(r.mention, "Jorginho");
  assert.equal(r.title, "Buscar peça");
});

test("sem @ e sem prazo: só o título", () => {
  const r = parsePedido("  fechar o caixa da loja SJ ", people, NOW);
  assert.equal(r.mention, null);
  assert.equal(r.assignee, null);
  assert.equal(r.unknownMention, false);
  assert.equal(r.due, null);
  assert.equal(r.title, "Fechar o caixa da loja SJ");
});

test("e-mail não é menção", () => {
  assert.equal(parsePedido("mandar para joao@loja.com", people, NOW).mention, null);
});

test("prazos: até amanhã (fim do expediente), até sexta, até às 9:30, hora que já passou vai para amanhã", () => {
  assert.equal(parsePedido("x até amanhã", people, NOW).due?.toISOString(), br("2026-10-30T18:00:00"));
  assert.equal(parsePedido("x até sexta", people, NOW).due?.toISOString(), br("2026-10-30T18:00:00"));
  assert.equal(parsePedido("x até sexta-feira 10h", people, NOW).due?.toISOString(), br("2026-10-30T10:00:00"));
  assert.equal(parsePedido("x até segunda às 9:30", people, NOW).due?.toISOString(), br("2026-11-02T09:30:00"));
  // Quinta 14h: "até quinta" ainda é hoje às 18h; "até quarta" é a próxima; "até 13h" já passou → amanhã.
  assert.equal(parsePedido("x até quinta", people, NOW).due?.toISOString(), br("2026-10-29T18:00:00"));
  assert.equal(parsePedido("x até quarta", people, NOW).due?.toISOString(), br("2026-11-04T18:00:00"));
  assert.equal(parsePedido("x até 13h", people, NOW).due?.toISOString(), br("2026-10-30T13:00:00"));
  assert.equal(parsePedido("x até as 16h30", people, NOW).due?.toISOString(), br("2026-10-29T16:30:00"));
  assert.equal(parsePedido("x até hoje", people, NOW).due?.toISOString(), br("2026-10-29T18:00:00"));
  assert.equal(parsePedido("x até meio-dia", people, NOW).due?.toISOString(), br("2026-10-30T12:00:00"));
  assert.equal(parsePedido("x até 05/11", people, NOW).due?.toISOString(), br("2026-11-05T18:00:00"));
  assert.equal(parsePedido("x até dia 3", people, NOW).due?.toISOString(), br("2026-11-03T18:00:00"));
});

test("'até' que não é prazo fica no título", () => {
  const r = parsePedido("@Gabriel levar até a loja PP", people, NOW);
  assert.equal(r.due, null);
  assert.equal(r.title, "Levar até a loja PP");
});

test("selo de prazo: atrasado (vermelho), vence em ≤60 min (amarelo), sem prazo, concluído", () => {
  assert.deepEqual(dueBadge(new Date(NOW.getTime() - 25 * 60_000).toISOString(), NOW, false), { text: "Atrasado 25 min", tone: "late" });
  assert.deepEqual(dueBadge(new Date(NOW.getTime() + 40 * 60_000).toISOString(), NOW, false), { text: "Vence em 40 min", tone: "soon" });
  assert.deepEqual(dueBadge(new Date(NOW.getTime() + 3 * 3600_000).toISOString(), NOW, false), { text: "Vence em 3 h", tone: "normal" });
  assert.deepEqual(dueBadge(null, NOW, false), { text: "Sem prazo", tone: "none" });
  assert.equal(dueBadge(null, NOW, true).tone, "done");
  assert.equal(formatDue(new Date(br("2026-10-30T10:00:00")), NOW), "amanhã 10:00");
});

test("sem resposta há X: só a partir de 5 min", () => {
  assert.equal(replyLateText(new Date(NOW.getTime() - 3 * 60_000).toISOString(), NOW), null);
  assert.deepEqual(replyLateText(new Date(NOW.getTime() - 25 * 60_000).toISOString(), NOW), { text: "sem resposta há 25 min", strong: false });
  assert.deepEqual(replyLateText(new Date(NOW.getTime() - 60 * 60_000).toISOString(), NOW), { text: "sem resposta há 1 h", strong: true });
  assert.equal(replyLateText(null, NOW), null);
});

const task = (p: Partial<PedidoTask>): PedidoTask => ({
  id: 1, title: "T", description: null, status: "todo", dueDate: null, updatedAt: NOW.toISOString(), createdAt: NOW.toISOString(),
  createdBy: { id: 1, name: "Samuel" }, assignees: [{ id: 2, name: "Lucelia" }], contact: null, waitingFor: null, ...p,
});

test("colunas: novo, fazendo, esperando alguém, feito hoje (feito de ontem sai)", () => {
  assert.equal(columnOf(task({}), NOW), "novo");
  assert.equal(columnOf(task({ status: "doing" }), NOW), "fazendo");
  assert.equal(columnOf(task({ status: "doing", waitingFor: "Transportadora" }), NOW), "esperando");
  assert.equal(columnOf(task({ status: "done" }), NOW), "feito");
  assert.equal(columnOf(task({ status: "done", updatedAt: "2026-10-28T12:00:00Z" }), NOW), null);
});

test("filtros Para mim / Que eu pedi / Equipe toda e contagem sem os feitos", () => {
  const list = [
    task({ id: 1 }), // Samuel → Lucelia
    task({ id: 2, createdBy: { id: 3, name: "Gabriel" }, assignees: [{ id: 1, name: "Samuel" }] }),
    task({ id: 3, status: "done" }),
  ];
  assert.equal(inScope(list[0]!, "pedi", 1), true);
  assert.equal(inScope(list[0]!, "mim", 1), false);
  assert.equal(inScope(list[1]!, "mim", 1), true);
  assert.deepEqual(scopeCounts(list, 1, NOW), { mim: 1, pedi: 1, equipe: 2 });
  assert.equal(whoText(list[0]!, 1), "Você pediu → Lucelia");
  assert.equal(whoText(list[1]!, 1), "Gabriel pediu → você");
});

test("vínculo: atendimento do cliente ou OS citada", () => {
  assert.equal(linkOf(task({ contact: { id: 9, name: "Fabrícia" } })), "Atendimento: Fabrícia");
  assert.equal(linkOf(task({ title: "Trocar bateria OS #2553" })), "OS #2553");
  assert.equal(linkOf(task({ description: "ver a os 1234 amanhã" })), "OS #1234");
  assert.equal(linkOf(task({ title: "Comprar fios" })), null);
});

test("ordem: prazo mais perto primeiro, sem prazo no fim", () => {
  const a = task({ id: 1, dueDate: "2026-10-29T20:00:00Z" });
  const b = task({ id: 2, dueDate: "2026-10-29T18:00:00Z" });
  const c = task({ id: 3 });
  assert.deepEqual([a, c, b].sort(sortPedidos).map((t) => t.id), [2, 1, 3]);
});
