// Interpretador por regras do Gerente IA — puro, sem banco nem IA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseByRules, extractWhen, parseBRL, parseSpLocal, spParts, withinRange, cleanTitle } from "./gerenteRules.ts";

// Segunda-feira, 19/10/2026 14:00 em São Paulo (fixo, pra datas relativas).
const NOW = parseSpLocal("2026-10-19T14:00")!;
const sp = (d: Date | null) => {
  assert.ok(d, "esperava uma data");
  const p = spParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
};

test("parseBRL entende os formatos do dia a dia", () => {
  assert.equal(parseBRL("50"), 5000);
  assert.equal(parseBRL("1.250,50"), 125050);
  assert.equal(parseBRL("1250.50"), 125050);
  assert.equal(parseBRL("R$ 1.500"), 150000);
  assert.equal(parseBRL("12,5"), 1250);
  assert.equal(parseBRL("50 reais"), 5000);
  assert.equal(parseBRL("abc"), null);
});

test("extractWhen: amanhã às 9h, sexta 10h, dd/mm, em 2 horas, hora já passada vai pra amanhã", () => {
  assert.equal(sp(extractWhen(" ligar pro contador amanhã às 9h ", NOW).when), "2026-10-20 09:00");
  assert.equal(sp(extractWhen(" dentista sexta 10h ", NOW).when), "2026-10-23 10:00");
  assert.equal(sp(extractWhen(" pagar aluguel dia 10/11 ", NOW).when), "2026-11-10 09:00");
  assert.equal(sp(extractWhen(" conferir caixa em 2 horas ", NOW).when), "2026-10-19 16:00");
  assert.equal(sp(extractWhen(" reunião às 15:30 ", NOW).when), "2026-10-19 15:30");
  // 8h já passou (são 14h) → amanhã
  assert.equal(sp(extractWhen(" abrir loja às 8h ", NOW).when), "2026-10-20 08:00");
  // "segunda" dita numa segunda = a próxima
  assert.equal(sp(extractWhen(" fechamento segunda 9h ", NOW).when), "2026-10-26 09:00");
  // período do dia
  assert.equal(sp(extractWhen(" visita amanhã de tarde ", NOW).when), "2026-10-20 15:00");
  assert.equal(sp(extractWhen(" visita amanhã às 3 da tarde ", NOW).when), "2026-10-20 15:00");
  // sem nada temporal
  assert.equal(extractWhen(" só um texto ", NOW).when, null);
  // o resto não leva a parte temporal
  assert.equal(cleanTitle(extractWhen(" de ligar pro contador amanhã às 9h ", NOW).rest), "ligar pro contador");
});

test("lembrete: 'lembra de ligar pro contador amanhã às 9h'", () => {
  const r = parseByRules("lembra de ligar pro contador amanhã às 9h", NOW);
  assert.ok(r && r.kind === "lembrete");
  assert.equal(r.title, "ligar pro contador");
  assert.equal(sp(r.dueAt), "2026-10-20 09:00");
  assert.equal(r.urgent, false);
  const u = parseByRules("me lembre urgente de pagar o fornecedor hoje às 17h", NOW);
  assert.ok(u && u.kind === "lembrete" && u.urgent);
  // Lembrete sem horário: regras devolvem null (vai pra IA perguntar o horário)
  assert.equal(parseByRules("lembra de comprar café", NOW), null);
});

test("gasto e receita", () => {
  const g = parseByRules("gastei 50 no almoço", NOW);
  assert.ok(g && g.kind === "gasto");
  assert.equal(g.amountCents, 5000);
  assert.equal(g.description, "almoço");
  assert.equal(g.scope, "empresa");
  const r = parseByRules("recebi 1.250,50 do João da venda do iPhone", NOW);
  assert.ok(r && r.kind === "receita");
  assert.equal(r.amountCents, 125050);
  assert.equal(r.description, "João da venda do iPhone");
  const p = parseByRules("paguei 120 na minha conta de luz de casa", NOW);
  assert.ok(p && p.kind === "gasto" && p.scope === "pessoal");
});

test("conta a pagar / receber com vencimento", () => {
  const c = parseByRules("pagar 1.500 aluguel dia 10/11", NOW);
  assert.ok(c && c.kind === "conta");
  assert.equal(c.billKind, "pagar");
  assert.equal(c.amountCents, 150000);
  assert.equal(c.description, "aluguel");
  assert.equal(c.dueDate, "2026-11-10");
  const rc = parseByRules("conta a receber 500 da Maria sexta", NOW);
  assert.ok(rc && rc.kind === "conta" && rc.billKind === "receber");
  assert.equal(rc.dueDate, "2026-10-23");
});

test("tarefa pra equipe com responsável e prazo", () => {
  const t = parseByRules("tarefa pro Nilmar: conferir estoque até sexta", NOW);
  assert.ok(t && t.kind === "tarefa");
  assert.equal(t.assignee, "Nilmar");
  assert.equal(t.title, "conferir estoque");
  assert.equal(sp(t.dueAt), "2026-10-23 18:00");
  const t2 = parseByRules("tarefa: trocar a vitrine para o Vagner amanhã 10h urgente", NOW);
  assert.ok(t2 && t2.kind === "tarefa");
  assert.equal(t2.assignee, "Vagner");
  assert.equal(t2.priority, "alta");
  assert.equal(sp(t2.dueAt), "2026-10-20 10:00");
});

test("compromisso", () => {
  const c = parseByRules("reunião com o contador quinta às 14h", NOW);
  assert.ok(c && c.kind === "compromisso");
  assert.equal(c.title, "reunião com o contador");
  assert.equal(sp(c.startsAt), "2026-10-22 14:00");
  const a = parseByRules("agendar dentista 25/10 às 9h", NOW);
  assert.ok(a && a.kind === "compromisso");
  assert.equal(a.title, "dentista");
});

test("comandos curtos: feito, adia, sim/não, consultas, ajuda, desfazer", () => {
  assert.deepEqual(parseByRules("feito", NOW), { kind: "feito" });
  assert.deepEqual(parseByRules("Sim", NOW), { kind: "confirmar", yes: true });
  assert.deepEqual(parseByRules("não", NOW), { kind: "confirmar", yes: false });
  assert.deepEqual(parseByRules("ajuda", NOW), { kind: "ajuda" });
  assert.deepEqual(parseByRules("desfazer", NOW), { kind: "desfazer" });
  assert.deepEqual(parseByRules("meu dia", NOW), { kind: "consultar", what: "meu_dia" });
  assert.deepEqual(parseByRules("contas", NOW), { kind: "consultar", what: "contas" });
  assert.deepEqual(parseByRules("financeiro", NOW), { kind: "consultar", what: "financeiro" });
  const a1 = parseByRules("adia 1h", NOW);
  assert.ok(a1 && a1.kind === "adiar" && a1.minutes === 60);
  const a2 = parseByRules("adiar 30 min", NOW);
  assert.ok(a2 && a2.kind === "adiar" && a2.minutes === 30);
  const a3 = parseByRules("adia pra amanhã 9h", NOW);
  assert.ok(a3 && a3.kind === "adiar" && a3.minutes === null);
  assert.equal(sp(a3.when), "2026-10-20 09:00");
  // Frase livre: regras não entendem → null (IA assume)
  assert.equal(parseByRules("o cliente da PP reclamou do prazo do conserto", NOW), null);
});

test("withinRange cruza a meia-noite", () => {
  assert.equal(withinRange("23:00", "22:00", "07:00"), true);
  assert.equal(withinRange("03:00", "22:00", "07:00"), true);
  assert.equal(withinRange("12:00", "22:00", "07:00"), false);
  assert.equal(withinRange("12:00", "09:00", "18:00"), true);
});
