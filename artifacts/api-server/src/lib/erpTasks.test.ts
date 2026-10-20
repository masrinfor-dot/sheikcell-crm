// Quadro de tarefas unificado (19/10/2026): tradução ERP ↔ CRM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assigneesForErp, buildCrmReport, canSeeErpTask, commentToCrm, toCrmTask, type CrmCtx, type ErpTask } from "./erpTasks";

const ctx: CrmCtx = {
  tenantId: 3,
  users: [
    { id: 10, name: "Samuel", email: "Samuel@Sheikcell.com" },
    { id: 11, name: "Ana", email: "ana@sheikcell.com" },
  ],
  sectors: [{ id: 5, name: "Vendas", color: "#123456" }],
  contacts: new Map([[77, { id: 77, name: "Cliente João", contact: "33999990000" }]]),
};

const erpTask = (over: Partial<ErpTask> = {}): ErpTask => ({
  id: "uuid-1", number: 42, title: "Ligar", description: null, status: "todo", priority: "alta",
  dueDate: "2026-10-18T10:00:00.000Z", durationMinutes: 30, alertMinutesBefore: 15, position: 0,
  sectorName: "Vendas", crmSectorId: 5, contactName: "Cliente João", contactPhone: "33999990000", crmContactId: 77,
  origin: "erp", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z",
  createdBy: { userId: "e1", name: "Samuel (ERP)", email: "samuel@sheikcell.com" },
  assignees: [
    { id: "a1", userId: "e2", name: "Ana ERP", email: "ana@sheikcell.com" },
    { id: "a2", userId: "e3", name: "Beto (só no ERP)", email: "beto@sheikcell.com" },
  ],
  subtaskTotal: 2, subtaskDone: 1, commentCount: 3,
  ...over,
});

test("tarefa do ERP vira tarefa do quadro: número como id, pessoas pelo e-mail, quem não tem par fica com id negativo", () => {
  const t = toCrmTask(erpTask(), ctx);
  assert.equal(t.id, 42);
  assert.deepEqual(t.assignees, [{ id: 11, name: "Ana" }, { id: -2, name: "Beto (só no ERP)" }]);
  assert.deepEqual(t.createdBy, { id: 10, name: "Samuel" });
  assert.equal(t.createdById, 10);
  assert.equal(t.sector?.name, "Vendas");
  assert.equal(t.sectorId, 5);
  assert.deepEqual(t.contact, { id: 77, name: "Cliente João", contact: "33999990000" });
  assert.equal(t.commentCount, 3);
});

test("setor e cliente que não existem aqui aparecem pelo nome", () => {
  const t = toCrmTask(erpTask({ crmSectorId: null, sectorName: "Financeiro", crmContactId: null, contactName: "Maria", contactPhone: "339" }), ctx);
  assert.equal(t.sectorId, null);
  assert.equal(t.sector?.name, "Financeiro");
  assert.deepEqual(t.contact, { id: 0, name: "Maria", contact: "339" });
});

test("quem vê: admin todas; os outros as que criaram ou em que são responsáveis (pelo e-mail)", () => {
  const t = erpTask();
  assert.equal(canSeeErpTask(t, { email: null, isAdmin: true }), true);
  assert.equal(canSeeErpTask(t, { email: "ANA@sheikcell.com", isAdmin: false }), true);
  assert.equal(canSeeErpTask(t, { email: "samuel@sheikcell.com", isAdmin: false }), true);
  assert.equal(canSeeErpTask(t, { email: "outro@sheikcell.com", isAdmin: false }), false);
  assert.equal(canSeeErpTask(t, { email: null, isAdmin: false }), false);
});

test("responsáveis para o ERP: usuários daqui com e-mail; negativos mantêm quem só existe no ERP", () => {
  const current = erpTask();
  assert.deepEqual(assigneesForErp([10, -2, 10], ctx, current), [
    { displayName: "Samuel", email: "samuel@sheikcell.com" },
    { displayName: "Beto (só no ERP)", email: "beto@sheikcell.com" },
  ]);
  assert.deepEqual(assigneesForErp([999], ctx, current), { error: "Responsável inválido" });
});

test("comentário com anexo vira link do CRM (que busca no ERP)", () => {
  const c = commentToCrm({
    id: "c-1", authorName: "Ana ERP", authorEmail: "ana@sheikcell.com", origin: "erp", content: "ok",
    fileName: "foto.jpg", mimeType: "image/jpeg", hasFile: true, createdAt: "2026-10-19T10:00:00Z",
  }, 42, ctx);
  assert.equal(c.authorId, 11);
  assert.equal(c.authorName, "Ana");
  assert.equal(c.mediaUrl, "/api/tasks/42/comments/c-1/file");
  assert.equal(c.mediaType, "image");
});

test("relatório por setor e vendedor", () => {
  const rows = [toCrmTask(erpTask(), ctx), toCrmTask(erpTask({ number: 43, status: "done", assignees: [], crmSectorId: null, sectorName: null }), ctx)];
  const r = buildCrmReport(rows, new Date("2026-10-19T10:00:00Z"));
  assert.deepEqual(r.bySector, [
    { name: "Vendas", total: 1, todo: 1, doing: 0, done: 0, overdue: 1 },
    { name: "Sem setor", total: 1, todo: 0, doing: 0, done: 1, overdue: 0 },
  ]);
  assert.deepEqual(r.byUser.map((b) => b.name), ["Ana", "Beto (só no ERP)", "Sem responsável"]);
});
