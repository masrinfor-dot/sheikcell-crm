import { test } from "node:test";
import assert from "node:assert/strict";
import { isSurveyReminderDue, type SurveyReminderConv, type SurveyReminderCfg } from "./surveyReminderEligibility";

const NOW = Date.parse("2026-08-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

const baseConv: SurveyReminderConv = {
  pendingSurveyLogId: 42,
  surveySentAt: hoursAgo(25),
  surveyReminderSentAt: null,
  surveyWindowHours: 48,
  channel: "whatsapp",
  phone: "5511999990000",
};
const baseCfg: SurveyReminderCfg = { enabled: true, reminderEnabled: true, reminderHours: 24 };

test("elegível: pendente, 25h depois, janela de 48h aberta", () => {
  assert.equal(isSurveyReminderDue(baseConv, baseCfg, NOW), true);
});

test("cliente já respondeu (pending limpo) → não lembra", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, pendingSurveyLogId: null }, baseCfg, NOW), false);
});

test("lembrete já enviado → nunca um segundo", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, surveyReminderSentAt: hoursAgo(1) }, baseCfg, NOW), false);
});

test("janela de resposta expirou (49h de uma janela de 48h) → não lembra", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, surveySentAt: hoursAgo(49) }, baseCfg, NOW), false);
});

test("exatamente na fronteira da janela (48h) → não lembra", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, surveySentAt: hoursAgo(48) }, baseCfg, NOW), false);
});

test("prazo do retrato manda: config atual maior não reabre pesquisa vencida", () => {
  // Retrato: janela de 24h, enviada há 25h. Mesmo que a loja mude para 168h
  // depois, a pesquisa venceu segundo o retrato → sem lembrete.
  const conv = { ...baseConv, surveyWindowHours: 24, surveySentAt: hoursAgo(25) };
  assert.equal(isSurveyReminderDue(conv, { ...baseCfg, reminderHours: 12 }, NOW), false);
});

test("pesquisa antiga sem retrato de janela → não lembra (sem prazo confiável)", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, surveyWindowHours: null }, baseCfg, NOW), false);
});

test("cedo demais (23h de um lembrete de 24h) → ainda não", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, surveySentAt: hoursAgo(23) }, baseCfg, NOW), false);
});

test("lembrete desligado na loja → não lembra", () => {
  assert.equal(isSurveyReminderDue(baseConv, { ...baseCfg, reminderEnabled: false }, NOW), false);
});

test("pesquisa desligada na loja → não lembra", () => {
  assert.equal(isSurveyReminderDue(baseConv, { ...baseCfg, enabled: false }, NOW), false);
});

test("grupo de WhatsApp → não lembra", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, phone: "12036302@g.us" }, baseCfg, NOW), false);
});

test("canal que não é WhatsApp → não lembra", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, channel: "interno" }, baseCfg, NOW), false);
});

test("sem surveySentAt → não lembra", () => {
  assert.equal(isSurveyReminderDue({ ...baseConv, surveySentAt: null }, baseCfg, NOW), false);
});
