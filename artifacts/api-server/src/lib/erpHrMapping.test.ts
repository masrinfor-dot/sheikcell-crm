import { test } from "node:test";
import assert from "node:assert/strict";
import { employeeForErp, isAllowedAfterMove, leaveDaysInMonth } from "./erpHrMapping";

test("RH → ERP: faltas injustificadas e afastamentos contados só dentro do mês", () => {
  const out = leaveDaysInMonth([
    { kind: "falta_injustificada", startDate: "2026-10-05", endDate: "2026-10-05" },
    { kind: "falta_injustificada", startDate: "2026-09-29", endDate: "2026-10-02" }, // 2 dias em outubro
    { kind: "ferias", startDate: "2026-10-20", endDate: "2026-11-08" }, // 12 dias em outubro
    { kind: "atestado", startDate: "2026-11-01", endDate: "2026-11-03" }, // fora
  ], "2026-10");
  assert.deepEqual(out, { absenceDays: 3, leaveDays: 12 });
});

test("RH → ERP: importação inicial leva o cadastro do CRM com o id dele", () => {
  const row = employeeForErp({
    id: 17, tenantId: 1, name: "Ana", cpf: "123", phone: "33999", email: "a@x.com", role: "Vendedora",
    jobFunction: null, contractType: "clt", salaryCents: 220000, admissionDate: "2025-03-01", isActive: true,
  } as never, "Padre Paraíso");
  assert.equal(row.crmEmployeeId, "17");
  assert.equal(row.storeName, "Padre Paraíso");
  assert.equal(row.jobTitle, "Vendedora");
  assert.equal(row.salaryCents, 220000);
});

test("RH no ERP: aqui continua bater o ponto e consultar; o resto vai para o ERP", () => {
  assert.equal(isAllowedAfterMove("GET", "/rh-dp/employees"), true);
  assert.equal(isAllowedAfterMove("POST", "/rh-dp/me/punch"), true);
  assert.equal(isAllowedAfterMove("POST", "/rh-dp/leave-records"), false);
  assert.equal(isAllowedAfterMove("PATCH", "/rh/candidates/3"), false);
  assert.equal(isAllowedAfterMove("POST", "/rh-dp/me/vacation-requests"), false);
});
