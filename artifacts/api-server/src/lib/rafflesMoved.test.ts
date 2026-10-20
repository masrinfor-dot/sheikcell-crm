import { test } from "node:test";
import assert from "node:assert/strict";
import { erpRafflesLink, isRaffleWrite } from "./rafflesMoved";
import { raffleSenderName } from "./erpRaffleMessages";
import { buildRafflesExport } from "../routes/rafflesExport";

test("sorteios no ERP: só leitura continua liberada; link da tela do ERP", () => {
  assert.equal(isRaffleWrite("GET"), false);
  assert.equal(isRaffleWrite("head"), false);
  assert.equal(isRaffleWrite("POST"), true);
  assert.equal(isRaffleWrite("PATCH"), true);
  assert.equal(isRaffleWrite("DELETE"), true);
  assert.equal(erpRafflesLink("https://erp.x.com.br/"), "https://erp.x.com.br/sorteios");
  assert.equal(erpRafflesLink("  "), "");
  assert.equal(raffleSenderName("Dia das Crianças"), "ERP · Sorteio Dia das Crianças");
  assert.equal(raffleSenderName(null), "ERP · Sorteio");
});

test("exportação: ids viram nomes e o ganhador leva só o que o ERP usa", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const out = buildRafflesExport({
    tenant: { id: 1, name: "Sheikcell" },
    raffles: [{
      tenantId: 1, id: 7, name: "Sexta", prize: "Capinha", sectorIds: [3, 99], vendedorIds: [5], sessionKeys: ["pp"],
      periodDays: 30, clientTypes: ["comprou"], onlyResolved: false, surveyRespondedOnly: true, excludePreviousWinners: true,
      winnersCount: 1, messageTemplate: "Oi {nome}", storeName: null, recurrence: "weekly", dayOfWeek: 5, dayOfMonth: null,
      active: true, lastRunKey: "2026-10-10", createdById: 5, createdAt: now,
    }],
    draws: [{
      tenantId: 1, id: 100, raffleId: 7, periodKey: "manual-1", eligibleCount: 9, createdAt: now,
      winners: [{ phone: "5533999990001", name: "Ana", conversationId: 4, sent: false, error: "Falha", attempts: 3 }],
    }],
    sectorNames: new Map([[3, "Vendas"]]),
    userNames: new Map([[5, "Bruno"]]),
    sessionLabels: new Map([["pp", "Padre Paraíso"]]),
    now,
  });
  assert.equal(out.kind, "raffles");
  assert.equal(out.exportedAt, "2026-10-17T12:00:00.000Z");
  assert.deepEqual(out.raffles[0]!.sectorNames, ["Vendas", "99"]);
  assert.deepEqual(out.raffles[0]!.vendedorNames, ["Bruno"]);
  assert.deepEqual(out.raffles[0]!.sessionLabels, ["Padre Paraíso"]);
  assert.equal(out.raffles[0]!.createdByName, "Bruno");
  assert.deepEqual(out.draws[0]!.winners, [{ phone: "5533999990001", name: "Ana", sent: false, error: "Falha" }]);
});
