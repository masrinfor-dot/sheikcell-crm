// Regras puras do atendimento por canais (26/10/2026): de quem é a vez
// ("Responder agora" x "Aguardando cliente"), "Não precisa responder",
// "Retomar depois" e validação de canal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { channelFilterFromQuery, needsReply, parseChannelId, validSnoozeUntil, waitingSince } from "./attendanceState";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const min = (n: number) => new Date(NOW - n * 60_000);
const base = { status: "open", isArchived: false };

test("cliente falou por último = Responder agora; nós falamos = Aguardando cliente", () => {
  assert.equal(needsReply({ ...base, lastMessageDirection: "inbound", lastMessageAt: min(10) }, NOW), true);
  assert.equal(waitingSince({ ...base, lastMessageDirection: "inbound", lastMessageAt: min(10) }, NOW), min(10).getTime());
  assert.equal(needsReply({ ...base, lastMessageDirection: "outbound", lastMessageAt: min(10) }, NOW), false);
  assert.equal(needsReply({ ...base, lastMessageDirection: null, lastMessageAt: null }, NOW), false);
  assert.equal(needsReply({ status: "resolved", lastMessageDirection: "inbound", lastMessageAt: min(10) }, NOW), false);
});

test("Não precisa responder vale até o cliente mandar mensagem nova", () => {
  const dismissed = { ...base, lastMessageDirection: "inbound", lastMessageAt: min(10), replyDismissedAt: min(5) };
  assert.equal(needsReply(dismissed, NOW), false);
  // cliente escreveu depois de marcado
  assert.equal(needsReply({ ...dismissed, lastMessageAt: min(1) }, NOW), true);
});

test("Retomar depois: aguardando até o horário; volta no horário; mensagem do cliente cancela", () => {
  const snoozed = { ...base, lastMessageDirection: "outbound", lastMessageAt: min(30), snoozeSetAt: min(20), snoozeUntil: new Date(NOW + 3600_000) };
  assert.equal(needsReply(snoozed, NOW), false);
  // mesmo com o cliente tendo falado por último antes de marcar
  assert.equal(needsReply({ ...snoozed, lastMessageDirection: "inbound" }, NOW), false);
  // chegou a hora
  const due = { ...snoozed, snoozeUntil: min(1) };
  assert.equal(needsReply(due, NOW), true);
  assert.equal(waitingSince(due, NOW), min(1).getTime());
  // respondemos depois do horário → sai de Responder agora
  assert.equal(needsReply({ ...due, lastMessageAt: new Date(NOW - 10_000) }, NOW), false);
  // cliente mandou mensagem antes do horário → sobe na hora
  assert.equal(needsReply({ ...snoozed, lastMessageDirection: "inbound", lastMessageAt: min(5) }, NOW), true);
});

test("canal: valida ids e monta filtro da consulta", () => {
  assert.equal(parseChannelId("todos"), "todos");
  assert.equal(parseChannelId("instagram"), "instagram");
  assert.equal(parseChannelId("wa:varejo-1"), "wa:varejo-1");
  assert.equal(parseChannelId("wa:"), null);
  assert.equal(parseChannelId("wa:../x"), null);
  assert.equal(parseChannelId(42), null);
  assert.deepEqual(channelFilterFromQuery({ channel: "instagram", sessionKey: "x" }, []), { instagram: true });
  assert.deepEqual(channelFilterFromQuery({ sessionKey: "varejo" }, []), { sessionKey: "varejo" });
  assert.deepEqual(channelFilterFromQuery({ excludeInternal: "1" }, ["compras"]), { excludeSessionKeys: ["compras"] });
  assert.deepEqual(channelFilterFromQuery({ sessionKey: "DROP TABLE" }, []), {});
});

test("retomar depois: só horário no futuro e até 60 dias", () => {
  assert.equal(validSnoozeUntil(new Date(NOW - 1000).toISOString(), NOW), null);
  assert.equal(validSnoozeUntil("amanhã", NOW), null);
  assert.equal(validSnoozeUntil(new Date(NOW + 61 * 86_400_000).toISOString(), NOW), null);
  assert.ok(validSnoozeUntil(new Date(NOW + 3600_000).toISOString(), NOW));
});
