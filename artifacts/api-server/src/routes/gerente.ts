// Gerente IA — painel do dono (admin): configuração, "Meu dia", agenda,
// lembretes, lançamentos, contas, histórico da conversa e a caixa de
// conversa (mesma interpretação do WhatsApp, sem passar pelo bridge).
// Só admin: é a vida pessoal/financeira do dono — nunca vendedor/supervisor.
import { Router, type IRouter } from "express";
import {
  db, gerenteSettingsTable, gerenteMessagesTable, gerenteEventsTable, gerenteRemindersTable,
  gerenteEntriesTable, gerenteBillsTable, gerentePendingActionsTable, whatsappSessionsTable,
  crmContactsTable, conversationsTable, tasksTable, taskAssigneesTable, usersTable, gerenteTaskDispatchesTable, gerenteTeamPhonesTable, gerenteErpActionsTable,
} from "@workspace/db";
import { eq, and, desc, asc, gte, lt, ne, inArray, sql, isNull } from "drizzle-orm";
import { phoneVariants } from "../lib/phone";
import { requireAdmin, requireModule, requireTenant } from "../middlewares/auth";
import {
  getGerenteSettings, invalidateGerenteCache, normalizeAuthorizedPhones, handlePanelMessage, buildDigest,
} from "../lib/gerente";
import { parseSpLocal, spDateISO } from "../lib/gerenteRules";

const router: IRouter = Router();

router.use("/gerente", requireAdmin, requireModule("gerente"));

const isHM = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const idParam = (raw: string): number | null => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };

// ─── Configuração ────────────────────────────────────────────────────────────
router.get("/gerente/settings", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const full = await getGerenteSettings(tenantId);
  // Guarda o endereço do CRM pra montar os links que saem no WhatsApp.
  const origin = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  if (origin && !/localhost|127\.0\.0\.1/.test(origin)) {
    const base = `${proto}://${origin}`;
    if (full.publicBaseUrl !== base) await db.update(gerenteSettingsTable).set({ publicBaseUrl: base }).where(eq(gerenteSettingsTable.tenantId, tenantId));
  }
  const { erpAgentKeyCiphertext, erpAgentKeyIv, erpAgentKeyAuthTag, erpAgentKeyVersion, ...s } = full;
  void erpAgentKeyIv; void erpAgentKeyAuthTag; void erpAgentKeyVersion;
  const erpAgentKeySet = !!erpAgentKeyCiphertext;
  // Linhas de WhatsApp da loja — pra mostrar por onde os avisos saem.
  const lines = await db.select({ sessionKey: whatsappSessionsTable.sessionKey, displayName: whatsappSessionsTable.displayName, phoneNumber: whatsappSessionsTable.phoneNumber, status: whatsappSessionsTable.status })
    .from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  res.json({ ...s, erpAgentKeySet, lines });
});

router.patch("/gerente/settings", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as Record<string, unknown>;
  const set: Partial<typeof gerenteSettingsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof b["enabled"] === "boolean") set.enabled = b["enabled"];
  if (typeof b["assistantName"] === "string" && b["assistantName"].trim()) set.assistantName = b["assistantName"].trim().slice(0, 40);
  const warnings: string[] = [];
  if (Array.isArray(b["authorizedPhones"])) {
    const raw = b["authorizedPhones"].map((v) => String(v ?? "").trim()).filter(Boolean);
    const invalid = raw.filter((v) => normalizeAuthorizedPhones([v]).length === 0);
    if (invalid.length) {
      res.status(400).json({ error: `Número inválido: ${invalid.join(", ")}. Use DDD + número (ex.: 33 99999-0000).` });
      return;
    }
    const phones = normalizeAuthorizedPhones(raw);
    // Um dígito trocado autoriza o celular de um cliente — e as mensagens
    // dele passam a sumir do atendimento. Avisa se o número já é um cliente
    // conhecido desta loja (contato do CRM ou conversa), sem bloquear.
    for (const ph of phones) {
      const variants = phoneVariants(ph);
      const [contact] = await db.select({ name: crmContactsTable.name }).from(crmContactsTable)
        .where(and(eq(crmContactsTable.tenantId, tenantId), inArray(crmContactsTable.phone, variants))).limit(1);
      const [conv] = contact ? [] : await db.select({ name: conversationsTable.name }).from(conversationsTable)
        .where(and(eq(conversationsTable.tenantId, tenantId), inArray(conversationsTable.phone, variants))).limit(1);
      const known = contact?.name ?? conv?.name;
      if (known) warnings.push(`${ph} já é um cliente da loja ("${known}") — confira se é mesmo o número do dono.`);
    }
    set.authorizedPhones = phones;
  }
  if (b["admSessionKey"] === null || b["admSessionKey"] === "") set.admSessionKey = null;
  else if (typeof b["admSessionKey"] === "string") {
    const [line] = await db.select({ k: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable)
      .where(and(eq(whatsappSessionsTable.tenantId, tenantId), eq(whatsappSessionsTable.sessionKey, b["admSessionKey"]))).limit(1);
    if (!line) { res.status(400).json({ error: "Linha de WhatsApp não encontrada." }); return; }
    set.admSessionKey = line.k;
  }
  if (isHM(b["quietStart"])) set.quietStart = b["quietStart"];
  if (isHM(b["quietEnd"])) set.quietEnd = b["quietEnd"];
  if (b["dailyDigestTime"] === null) set.dailyDigestTime = null;
  else if (isHM(b["dailyDigestTime"])) set.dailyDigestTime = b["dailyDigestTime"];
  if (typeof b["teamDigestEnabled"] === "boolean") set.teamDigestEnabled = b["teamDigestEnabled"];
  if (typeof b["internalChatEnabled"] === "boolean") set.internalChatEnabled = b["internalChatEnabled"];
  if (isHM(b["teamMorningTime"])) set.teamMorningTime = b["teamMorningTime"];
  if (isHM(b["teamEveningTime"])) set.teamEveningTime = b["teamEveningTime"];
  await getGerenteSettings(tenantId);
  const [updated] = await db.update(gerenteSettingsTable).set(set).where(eq(gerenteSettingsTable.tenantId, tenantId)).returning();
  invalidateGerenteCache(tenantId);
  const { erpAgentKeyCiphertext: _c, erpAgentKeyIv: _i, erpAgentKeyAuthTag: _a, erpAgentKeyVersion: _v, ...safe } = updated!;
  void _i; void _a; void _v;
  res.json({ ...safe, erpAgentKeySet: !!_c, warnings });
});

// ─── Pessoas com acesso ao Gerente (gestor / 2º número) ─────────────────────
router.get("/gerente/members", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { gerenteMembersTable } = await import("@workspace/db");
  res.json(await db.select().from(gerenteMembersTable).where(eq(gerenteMembersTable.tenantId, tenantId)).orderBy(asc(gerenteMembersTable.id)));
});
router.post("/gerente/members", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { gerenteMembersTable } = await import("@workspace/db");
  const { normalizePhone } = await import("../lib/phone");
  const b = (req.body ?? {}) as { name?: unknown; phone?: unknown; userId?: unknown };
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
  const phone = normalizePhone(typeof b.phone === "string" ? b.phone : "");
  if (!name || !phone || phone.length < 12 || phone.length > 13) { res.status(400).json({ error: "Informe nome e um celular válido com DDD (ex.: 33 99999-0000)." }); return; }
  const settings = await getGerenteSettings(tenantId);
  if (settings.authorizedPhones.some((a) => normalizePhone(a) === phone)) { res.status(400).json({ error: "Esse já é o número do dono." }); return; }
  // Uma linha do próprio CRM não consegue mandar mensagem pra si mesma.
  const lines = await db.select({ phoneNumber: whatsappSessionsTable.phoneNumber, displayName: whatsappSessionsTable.displayName }).from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  const line = lines.find((l) => l.phoneNumber && normalizePhone(l.phoneNumber) === phone);
  if (line) { res.status(400).json({ error: `Esse número é uma linha do CRM (${line.displayName ?? line.phoneNumber}). A pessoa precisa usar o celular PESSOAL dela pra falar com o Gerente.` }); return; }
  const userId = typeof b.userId === "number" && Number.isInteger(b.userId) ? b.userId : null;
  const [row] = await db.insert(gerenteMembersTable).values({ tenantId, name, phone, userId })
    .onConflictDoUpdate({ target: [gerenteMembersTable.tenantId, gerenteMembersTable.phone], set: { name, userId, isActive: true } }).returning();
  invalidateGerenteCache(tenantId);
  res.status(201).json(row);
});
router.delete("/gerente/members/:id", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = idParam(String(req.params["id"])); if (!id) { res.status(400).json({ error: "id inválido" }); return; }
  const { gerenteMembersTable } = await import("@workspace/db");
  await db.delete(gerenteMembersTable).where(and(eq(gerenteMembersTable.id, id), eq(gerenteMembersTable.tenantId, tenantId)));
  invalidateGerenteCache(tenantId);
  res.json({ ok: true });
});

// ─── Indicadores de tarefas e equipe (dashboard) ─────────────────────────────
router.get("/gerente/task-stats", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { gerenteTaskMetaTable } = await import("@workspace/db");
  const now = new Date();
  const today = spDateISO(now);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const tasks = await db.select({
    id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, priority: tasksTable.priority, dueDate: tasksTable.dueDate,
    createdAt: tasksTable.createdAt, updatedAt: tasksTable.updatedAt, category: gerenteTaskMetaTable.category,
  }).from(tasksTable).leftJoin(gerenteTaskMetaTable, eq(gerenteTaskMetaTable.taskId, tasksTable.id))
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), sql`(${tasksTable.status} <> 'done' OR ${tasksTable.updatedAt} >= ${since30})`))
    .limit(3000);
  const ids = tasks.map((t) => t.id);
  const asg = ids.length ? await db.select({ taskId: taskAssigneesTable.taskId, userId: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(taskAssigneesTable).innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId)).where(inArray(taskAssigneesTable.taskId, ids)) : [];
  const disp = await db.select({ userId: gerenteTaskDispatchesTable.userId, status: gerenteTaskDispatchesTable.status, doneAt: gerenteTaskDispatchesTable.doneAt, proofUrl: gerenteTaskDispatchesTable.proofUrl, postponeCount: gerenteTaskDispatchesTable.postponeCount })
    .from(gerenteTaskDispatchesTable).where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), gte(gerenteTaskDispatchesTable.createdAt, since30)));

  const open = tasks.filter((t) => t.status !== "done");
  const isLate = (t: typeof tasks[number]) => !!t.dueDate && t.dueDate.getTime() < now.getTime();
  const done30 = tasks.filter((t) => t.status === "done");
  const onTime = (list: typeof tasks) => { const w = list.filter((t) => t.dueDate); return w.length ? Math.round(100 * w.filter((t) => t.updatedAt.getTime() <= t.dueDate!.getTime() + 60_000).length / w.length) : null; };
  const since7 = now.getTime() - 7 * 86_400_000;

  const people = new Map<number, { userId: number; name: string; isOwner: boolean; open: number; overdue: number; done7: number; onTimePct: number | null; awaitingProof: number; postponed: number; done30: typeof tasks }>();
  const byTask = new Map<number, typeof tasks[number]>(tasks.map((t) => [t.id, t]));
  for (const a of asg) {
    const t = byTask.get(a.taskId); if (!t) continue;
    const p = people.get(a.userId) ?? { userId: a.userId, name: a.name.trim(), isOwner: a.role === "admin", open: 0, overdue: 0, done7: 0, onTimePct: null, awaitingProof: 0, postponed: 0, done30: [] };
    if (t.status !== "done") { p.open++; if (isLate(t)) p.overdue++; }
    else { p.done30.push(t); if (t.updatedAt.getTime() >= since7) p.done7++; }
    people.set(a.userId, p);
  }
  for (const d of disp) {
    const p = people.get(d.userId); if (!p) continue;
    if (d.status === "aguardando_prova") p.awaitingProof++;
    p.postponed += d.postponeCount;
  }
  const team = [...people.values()].map(({ done30: d, ...p }) => ({ ...p, onTimePct: onTime(d) }))
    .sort((a, b) => (a.isOwner ? 1 : 0) - (b.isOwner ? 1 : 0) || b.overdue - a.overdue || b.open - a.open);

  const catCount = new Map<string, { open: number; overdue: number }>();
  for (const t of open) { const k = t.category ?? "Sem categoria"; const c = catCount.get(k) ?? { open: 0, overdue: 0 }; c.open++; if (isLate(t)) c.overdue++; catCount.set(k, c); }

  const trend: { date: string; created: number; done: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = spDateISO(new Date(now.getTime() - i * 86_400_000));
    trend.push({ date: d, created: tasks.filter((t) => spDateISO(t.createdAt) === d).length, done: done30.filter((t) => spDateISO(t.updatedAt) === d).length });
  }
  const oldestLate = open.filter(isLate).sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime()).slice(0, 6)
    .map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate, daysLate: Math.floor((now.getTime() - t.dueDate!.getTime()) / 86_400_000), assignees: asg.filter((a) => a.taskId === t.id).map((a) => a.name.trim().split(" ")[0]) }));

  res.json({
    now: now.toISOString(), today,
    kpis: {
      open: open.length, overdue: open.filter(isLate).length,
      dueToday: open.filter((t) => t.dueDate && spDateISO(t.dueDate) === today && !isLate(t)).length,
      noDue: open.filter((t) => !t.dueDate).length,
      noCategory: open.filter((t) => !t.category).length,
      done7: done30.filter((t) => t.updatedAt.getTime() >= since7).length,
      onTimePct: onTime(done30),
      withProof: disp.filter((d) => d.proofUrl && d.doneAt && d.doneAt.getTime() >= since7).length,
    },
    team, categories: [...catCount.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.open - a.open),
    trend, oldestLate,
  });
});

// Arrumação automática (mesmo plano do comando "arrumar tarefas").
router.post("/gerente/organize/plan", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { buildOrganizePlan } = await import("../lib/gerenteOrganize");
  const { mergeDuplicateTasks } = await import("../lib/gerenteTaskOps");
  const merged = await mergeDuplicateTasks(tenantId);
  res.json({ merged: merged.reduce((s, g) => s + g.archived.length, 0), items: await buildOrganizePlan(tenantId) });
});
router.post("/gerente/organize/apply", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { applyOrganizePlan, sanitizeItems } = await import("../lib/gerenteOrganize");
  const n = await applyOrganizePlan(tenantId, sanitizeItems((req.body as { items?: unknown })?.items));
  res.json({ applied: n });
});

// Aba "Tarefas" do painel: usa o mesmo gerenciador do link do celular.
router.post("/gerente/panel-link", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { createLink } = await import("../lib/gerenteExtras");
  const url = await createLink(await getGerenteSettings(tenantId), "dia", null, 1, true);
  res.json({ token: url.split("/g/")[1], url });
});

// ─── ERP (linha ADM) ─────────────────────────────────────────────────────────
router.put("/gerente/erp-key", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const key = String((req.body as { key?: unknown })?.key ?? "").trim();
  if (key && !/^agk_[A-Za-z0-9_-]{10,}$/.test(key)) { res.status(400).json({ error: "A chave do agente começa com agk_ (ERP › Financeiro › Aprovações do agente › Chaves)." }); return; }
  await getGerenteSettings(tenantId);
  const { saveAgentKey, pingAgent } = await import("../lib/gerenteErp");
  await saveAgentKey(tenantId, key || null);
  invalidateGerenteCache(tenantId);
  res.json(key ? await pingAgent(await getGerenteSettings(tenantId)) : { ok: true, message: "Chave removida." });
});

router.post("/gerente/erp-key/test", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { pingAgent } = await import("../lib/gerenteErp");
  res.json(await pingAgent(await getGerenteSettings(tenantId)));
});

router.get("/gerente/erp-actions", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select({
    id: gerenteErpActionsTable.id, type: gerenteErpActionsTable.type, summary: gerenteErpActionsTable.summary,
    status: gerenteErpActionsTable.status, message: gerenteErpActionsTable.message, createdAt: gerenteErpActionsTable.createdAt, updatedAt: gerenteErpActionsTable.updatedAt,
  }).from(gerenteErpActionsTable).where(eq(gerenteErpActionsTable.tenantId, tenantId)).orderBy(desc(gerenteErpActionsTable.id)).limit(60);
  res.json(rows);
});

router.post("/gerente/erp-actions/:id/resend", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = idParam(req.params["id"]!); if (id == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const { resendErpAction } = await import("../lib/gerenteErp");
  res.json({ message: await resendErpAction(await getGerenteSettings(tenantId), id) });
});

// ─── Equipe no WhatsApp ──────────────────────────────────────────────────────
router.get("/gerente/team", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const users = await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, storeName: usersTable.storeName })
    .from(usersTable).where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), ne(usersTable.role, "superadmin"), ne(usersTable.role, "admin")))
    .orderBy(asc(usersTable.name));
  const phones = await db.select().from(gerenteTeamPhonesTable).where(eq(gerenteTeamPhonesTable.tenantId, tenantId));
  const { suggestedPhones } = await import("../lib/gerenteDispatch");
  const sugg = await suggestedPhones(tenantId);
  res.json(users.map((u) => {
    const p = phones.find((x) => x.userId === u.id);
    return { ...u, name: u.name.trim(), phone: p?.phone ?? null, suggestedPhone: p ? null : sugg.get(u.id) ?? null, lastTestAt: p?.lastTestAt ?? null, lastTestOk: p?.lastTestOk ?? null };
  }));
});

router.put("/gerente/team/:userId", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = idParam(req.params["userId"]!); if (userId == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!u) { res.status(404).json({ error: "Usuário não encontrado" }); return; }
  const raw = String((req.body as { phone?: unknown })?.phone ?? "").trim();
  if (!raw) { await db.delete(gerenteTeamPhonesTable).where(and(eq(gerenteTeamPhonesTable.tenantId, tenantId), eq(gerenteTeamPhonesTable.userId, userId))); res.json({ ok: true, phone: null }); return; }
  const phone = normalizeAuthorizedPhones([raw])[0];
  if (!phone || phone.length < 12) { res.status(400).json({ error: "Número inválido. Use DDD + número (ex.: 33 99999-0000)." }); return; }
  await db.insert(gerenteTeamPhonesTable).values({ tenantId, userId, phone })
    .onConflictDoUpdate({ target: [gerenteTeamPhonesTable.tenantId, gerenteTeamPhonesTable.userId], set: { phone, lastTestAt: null, lastTestOk: null, updatedAt: new Date() } });
  // Tarefas já enviadas sem telefone passam a ter o número novo.
  res.json({ ok: true, phone });
});

router.post("/gerente/team/:userId/test", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = idParam(req.params["userId"]!); if (userId == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const [row] = await db.select({ phone: gerenteTeamPhonesTable.phone, name: usersTable.name }).from(gerenteTeamPhonesTable)
    .innerJoin(usersTable, eq(usersTable.id, gerenteTeamPhonesTable.userId))
    .where(and(eq(gerenteTeamPhonesTable.tenantId, tenantId), eq(gerenteTeamPhonesTable.userId, userId))).limit(1);
  if (!row) { res.status(400).json({ error: "Cadastre o WhatsApp desta pessoa primeiro." }); return; }
  const settings = await getGerenteSettings(tenantId);
  const { sendTeamTest } = await import("../lib/gerenteDispatch");
  const used = await sendTeamTest(tenantId, row.phone, row.name, settings.lastSessionKey);
  await db.update(gerenteTeamPhonesTable).set({ lastTestAt: new Date(), lastTestOk: !!used })
    .where(and(eq(gerenteTeamPhonesTable.tenantId, tenantId), eq(gerenteTeamPhonesTable.userId, userId)));
  if (!used) { res.status(502).json({ error: "Nenhuma linha de WhatsApp aceitou o envio. Confira se as linhas estão conectadas." }); return; }
  res.json({ ok: true, sessionKey: used });
});

// ─── Meu dia ─────────────────────────────────────────────────────────────────
router.get("/gerente/overview", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const today = spDateISO();
  const start = parseSpLocal(`${today}T00:00`)!;
  const end = new Date(start.getTime() + 86_400_000);
  const weekEnd = new Date(start.getTime() + 8 * 86_400_000);
  const now = new Date();
  const [events, reminders, bills, entriesMonth, digest, weekEvents, weekReminders, teamTasks] = await Promise.all([
    db.select().from(gerenteEventsTable).where(and(eq(gerenteEventsTable.tenantId, tenantId), isNull(gerenteEventsTable.memberPhone), eq(gerenteEventsTable.status, "agendado"), gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, end))).orderBy(asc(gerenteEventsTable.startsAt)),
    db.select().from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), isNull(gerenteRemindersTable.memberPhone), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end))).orderBy(asc(gerenteRemindersTable.dueAt)),
    db.select().from(gerenteBillsTable).where(and(eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"))).orderBy(asc(gerenteBillsTable.dueDate)).limit(50),
    db.select({
      kind: gerenteEntriesTable.kind, scope: gerenteEntriesTable.scope, total: sql<number>`coalesce(sum(${gerenteEntriesTable.amountCents}), 0)::int`,
    }).from(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.tenantId, tenantId), sql`to_char(${gerenteEntriesTable.entryDate}, 'YYYY-MM') = ${today.slice(0, 7)}`)).groupBy(gerenteEntriesTable.kind, gerenteEntriesTable.scope),
    buildDigest(tenantId),
    db.select({ startsAt: gerenteEventsTable.startsAt }).from(gerenteEventsTable).where(and(eq(gerenteEventsTable.tenantId, tenantId), isNull(gerenteEventsTable.memberPhone), eq(gerenteEventsTable.status, "agendado"), gte(gerenteEventsTable.startsAt, end), lt(gerenteEventsTable.startsAt, weekEnd))),
    db.select({ dueAt: gerenteRemindersTable.dueAt }).from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), isNull(gerenteRemindersTable.memberPhone), eq(gerenteRemindersTable.status, "pendente"), gte(gerenteRemindersTable.dueAt, end), lt(gerenteRemindersTable.dueAt, weekEnd))),
    // Tarefas da equipe atrasadas ou vencendo hoje (quadro de Tarefas).
    db.select({ id: tasksTable.id, title: tasksTable.title, dueDate: tasksTable.dueDate, status: tasksTable.status, priority: tasksTable.priority })
      .from(tasksTable).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"), lt(tasksTable.dueDate, end)))
      .orderBy(asc(tasksTable.dueDate)).limit(30),
  ]);
  // Tarefas enviadas pelo WhatsApp nos últimos 7 dias (status + prova).
  const dispatches = await db.select({
    id: gerenteTaskDispatchesTable.id, taskId: gerenteTaskDispatchesTable.taskId, assigneeName: gerenteTaskDispatchesTable.assigneeName,
    status: gerenteTaskDispatchesTable.status, sentAt: gerenteTaskDispatchesTable.sentAt, doneAt: gerenteTaskDispatchesTable.doneAt,
    proofUrl: gerenteTaskDispatchesTable.proofUrl, proofNote: gerenteTaskDispatchesTable.proofNote, createdAt: gerenteTaskDispatchesTable.createdAt,
    title: tasksTable.title, dueDate: tasksTable.dueDate,
  }).from(gerenteTaskDispatchesTable).innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
    .where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), gte(gerenteTaskDispatchesTable.createdAt, new Date(start.getTime() - 7 * 86_400_000))))
    .orderBy(desc(gerenteTaskDispatchesTable.id)).limit(40);
  const taskIds = teamTasks.map((t) => t.id);
  const assignees = taskIds.length ? await db.select({ taskId: taskAssigneesTable.taskId, name: usersTable.name })
    .from(taskAssigneesTable).innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId))
    .where(inArray(taskAssigneesTable.taskId, taskIds)) : [];
  const who = new Map<number, string[]>();
  for (const a of assignees) who.set(a.taskId, [...(who.get(a.taskId) ?? []), a.name.split(" ")[0]!]);

  // Próximos 7 dias: quantos compromissos/lembretes por dia (visão da semana).
  const week: { date: string; events: number; reminders: number }[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = spDateISO(new Date(start.getTime() + i * 86_400_000 + 12 * 3_600_000));
    week.push({ date: d, events: weekEvents.filter((e) => spDateISO(e.startsAt) === d).length, reminders: weekReminders.filter((r) => spDateISO(r.dueAt) === d).length });
  }
  // Carga do dia: minutos de compromissos (sem fim = 1h).
  const loadMinutes = events.reduce((sum, e) => sum + Math.max(15, Math.round(((e.endsAt?.getTime() ?? e.startsAt.getTime() + 3_600_000) - e.startsAt.getTime()) / 60_000)), 0);

  res.json({
    today, now: now.toISOString(), events, reminders,
    overdueReminders: reminders.filter((r) => r.dueAt.getTime() < now.getTime()),
    billsDueToday: bills.filter((b) => b.dueDate <= today),
    billsUpcoming: bills.filter((b) => b.dueDate > today).slice(0, 10),
    teamTasks: teamTasks.map((t) => ({ ...t, assignees: who.get(t.id) ?? [], overdue: !!t.dueDate && t.dueDate.getTime() < now.getTime() })),
    week, loadMinutes, dispatches,
    month: entriesMonth, digest,
  });
});

// "Fechar o dia": empurra lembretes pendentes de hoje/atrasados e
// compromissos de hoje que já passaram sem conclusão para amanhã (mesma hora
// no caso dos compromissos; lembretes às 09:00). Só o que o dono escolheu.
router.post("/gerente/rollover", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as { reminderIds?: unknown; eventIds?: unknown };
  const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : []);
  const reminderIds = ids(b.reminderIds);
  const eventIds = ids(b.eventIds);
  const tomorrow = spDateISO(new Date(parseSpLocal(`${spDateISO()}T12:00`)!.getTime() + 86_400_000));
  const nineAm = parseSpLocal(`${tomorrow}T09:00`)!;
  let moved = 0;
  if (reminderIds.length) {
    const r = await db.update(gerenteRemindersTable).set({ dueAt: nineAm, sentAt: null, updatedAt: new Date() })
      .where(and(eq(gerenteRemindersTable.tenantId, tenantId), isNull(gerenteRemindersTable.memberPhone), eq(gerenteRemindersTable.status, "pendente"), inArray(gerenteRemindersTable.id, reminderIds))).returning({ id: gerenteRemindersTable.id });
    moved += r.length;
  }
  if (eventIds.length) {
    const r = await db.update(gerenteEventsTable).set({
      startsAt: sql`${gerenteEventsTable.startsAt} + interval '1 day'`,
      endsAt: sql`${gerenteEventsTable.endsAt} + interval '1 day'`,
      remindedAt: null, updatedAt: new Date(),
    }).where(and(eq(gerenteEventsTable.tenantId, tenantId), isNull(gerenteEventsTable.memberPhone), eq(gerenteEventsTable.status, "agendado"), inArray(gerenteEventsTable.id, eventIds))).returning({ id: gerenteEventsTable.id });
    moved += r.length;
  }
  res.json({ moved, to: tomorrow });
});

// ─── Agenda ──────────────────────────────────────────────────────────────────
router.get("/gerente/events", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const from = isISODate(req.query["from"]) ? parseSpLocal(`${req.query["from"]}T00:00`)! : parseSpLocal(`${spDateISO()}T00:00`)!;
  const days = Math.max(1, Math.min(90, Number(req.query["days"] ?? 30) || 30));
  const to = new Date(from.getTime() + days * 86_400_000);
  const rows = await db.select().from(gerenteEventsTable)
    .where(and(eq(gerenteEventsTable.tenantId, tenantId), isNull(gerenteEventsTable.memberPhone), gte(gerenteEventsTable.startsAt, from), lt(gerenteEventsTable.startsAt, to)))
    .orderBy(asc(gerenteEventsTable.startsAt)).limit(300);
  res.json(rows);
});

router.post("/gerente/events", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as Record<string, unknown>;
  const title = typeof b["title"] === "string" ? b["title"].trim().slice(0, 200) : "";
  const startsAt = parseSpLocal(typeof b["startsAt"] === "string" ? b["startsAt"] : null);
  if (!title || !startsAt) { res.status(400).json({ error: "Título e data/hora são obrigatórios." }); return; }
  const [row] = await db.insert(gerenteEventsTable).values({
    tenantId, title, startsAt,
    endsAt: parseSpLocal(typeof b["endsAt"] === "string" ? b["endsAt"] : null),
    location: typeof b["location"] === "string" ? b["location"].slice(0, 200) || null : null,
    participants: typeof b["participants"] === "string" ? b["participants"].slice(0, 300) || null : null,
    scope: b["scope"] === "pessoal" ? "pessoal" : "empresa",
    notes: typeof b["notes"] === "string" ? b["notes"].slice(0, 1000) || null : null,
    remindMinutesBefore: Number.isInteger(b["remindMinutesBefore"]) ? Math.max(0, Math.min(1440, b["remindMinutesBefore"] as number)) : 30,
  }).returning();
  res.status(201).json(row);
});

router.patch("/gerente/events/:id", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = idParam(req.params["id"]!); if (id == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const b = req.body as Record<string, unknown>;
  const set: Partial<typeof gerenteEventsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof b["title"] === "string" && b["title"].trim()) set.title = b["title"].trim().slice(0, 200);
  if (typeof b["startsAt"] === "string") { const d = parseSpLocal(b["startsAt"]); if (d) { set.startsAt = d; set.remindedAt = null; } }
  if (b["endsAt"] === null) set.endsAt = null; else if (typeof b["endsAt"] === "string") set.endsAt = parseSpLocal(b["endsAt"]);
  if (typeof b["location"] === "string") set.location = b["location"].slice(0, 200) || null;
  if (typeof b["participants"] === "string") set.participants = b["participants"].slice(0, 300) || null;
  if (typeof b["notes"] === "string") set.notes = b["notes"].slice(0, 1000) || null;
  if (b["scope"] === "pessoal" || b["scope"] === "empresa") set.scope = b["scope"];
  if (["agendado", "concluido", "cancelado"].includes(b["status"] as string)) set.status = b["status"] as string;
  if (Number.isInteger(b["remindMinutesBefore"])) set.remindMinutesBefore = Math.max(0, Math.min(1440, b["remindMinutesBefore"] as number));
  const [row] = await db.update(gerenteEventsTable).set(set).where(and(eq(gerenteEventsTable.id, id), eq(gerenteEventsTable.tenantId, tenantId))).returning();
  if (!row) { res.status(404).json({ error: "Compromisso não encontrado" }); return; }
  res.json(row);
});

// ─── Lembretes ───────────────────────────────────────────────────────────────
router.get("/gerente/reminders", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const all = req.query["all"] === "1";
  const rows = await db.select().from(gerenteRemindersTable)
    .where(all ? eq(gerenteRemindersTable.tenantId, tenantId) : and(eq(gerenteRemindersTable.tenantId, tenantId), isNull(gerenteRemindersTable.memberPhone), eq(gerenteRemindersTable.status, "pendente")))
    .orderBy(all ? desc(gerenteRemindersTable.dueAt) : asc(gerenteRemindersTable.dueAt)).limit(200);
  res.json(rows);
});

router.post("/gerente/reminders", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as Record<string, unknown>;
  const title = typeof b["title"] === "string" ? b["title"].trim().slice(0, 200) : "";
  const dueAt = parseSpLocal(typeof b["dueAt"] === "string" ? b["dueAt"] : null);
  if (!title || !dueAt) { res.status(400).json({ error: "Título e data/hora são obrigatórios." }); return; }
  const [row] = await db.insert(gerenteRemindersTable).values({ tenantId, title, dueAt, urgent: b["urgent"] === true }).returning();
  res.status(201).json(row);
});

router.patch("/gerente/reminders/:id", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = idParam(req.params["id"]!); if (id == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const b = req.body as Record<string, unknown>;
  const set: Partial<typeof gerenteRemindersTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof b["title"] === "string" && b["title"].trim()) set.title = b["title"].trim().slice(0, 200);
  if (typeof b["dueAt"] === "string") { const d = parseSpLocal(b["dueAt"]); if (d) { set.dueAt = d; set.sentAt = null; } }
  if (typeof b["urgent"] === "boolean") set.urgent = b["urgent"];
  if (["pendente", "concluido", "cancelado"].includes(b["status"] as string)) set.status = b["status"] as string;
  const [row] = await db.update(gerenteRemindersTable).set(set).where(and(eq(gerenteRemindersTable.id, id), eq(gerenteRemindersTable.tenantId, tenantId))).returning();
  if (!row) { res.status(404).json({ error: "Lembrete não encontrado" }); return; }
  res.json(row);
});

// ─── Gastos e receitas ───────────────────────────────────────────────────────
router.get("/gerente/entries", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const month = typeof req.query["month"] === "string" && /^\d{4}-\d{2}$/.test(req.query["month"]) ? req.query["month"] : spDateISO().slice(0, 7);
  const rows = await db.select().from(gerenteEntriesTable)
    .where(and(eq(gerenteEntriesTable.tenantId, tenantId), sql`to_char(${gerenteEntriesTable.entryDate}, 'YYYY-MM') = ${month}`))
    .orderBy(desc(gerenteEntriesTable.entryDate), desc(gerenteEntriesTable.id)).limit(500);
  res.json({ month, rows });
});

router.post("/gerente/entries", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as Record<string, unknown>;
  const kind = b["kind"] === "receita" ? "receita" : "gasto";
  const amountCents = Number(b["amountCents"]);
  const description = typeof b["description"] === "string" ? b["description"].trim().slice(0, 200) : "";
  if (!Number.isInteger(amountCents) || amountCents <= 0 || !description) { res.status(400).json({ error: "Valor e descrição são obrigatórios." }); return; }
  const [row] = await db.insert(gerenteEntriesTable).values({
    tenantId, kind, amountCents, description,
    category: typeof b["category"] === "string" ? b["category"].slice(0, 60) || null : null,
    scope: b["scope"] === "pessoal" ? "pessoal" : "empresa",
    storeName: typeof b["storeName"] === "string" ? b["storeName"].slice(0, 60) || null : null,
    paymentMethod: typeof b["paymentMethod"] === "string" ? b["paymentMethod"].slice(0, 40) || null : null,
    installments: Number.isInteger(b["installments"]) ? Math.max(1, Math.min(60, b["installments"] as number)) : 1,
    reimbursementPending: b["reimbursementPending"] === true,
    entryDate: isISODate(b["entryDate"]) ? b["entryDate"] : spDateISO(),
  }).returning();
  res.status(201).json(row);
});

router.delete("/gerente/entries/:id", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = idParam(req.params["id"]!); if (id == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const [row] = await db.delete(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.id, id), eq(gerenteEntriesTable.tenantId, tenantId))).returning();
  if (!row) { res.status(404).json({ error: "Lançamento não encontrado" }); return; }
  res.json({ ok: true });
});

// ─── Contas a pagar / receber ────────────────────────────────────────────────
router.get("/gerente/bills", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const all = req.query["all"] === "1";
  const rows = await db.select().from(gerenteBillsTable)
    .where(all ? eq(gerenteBillsTable.tenantId, tenantId) : and(eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta")))
    .orderBy(all ? desc(gerenteBillsTable.dueDate) : asc(gerenteBillsTable.dueDate)).limit(300);
  res.json(rows);
});

router.post("/gerente/bills", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as Record<string, unknown>;
  const kind = b["kind"] === "receber" ? "receber" : "pagar";
  const amountCents = Number(b["amountCents"]);
  const description = typeof b["description"] === "string" ? b["description"].trim().slice(0, 200) : "";
  if (!Number.isInteger(amountCents) || amountCents <= 0 || !description || !isISODate(b["dueDate"])) {
    res.status(400).json({ error: "Valor, descrição e vencimento são obrigatórios." }); return;
  }
  const [row] = await db.insert(gerenteBillsTable).values({
    tenantId, kind, amountCents, description, dueDate: b["dueDate"],
    counterparty: typeof b["counterparty"] === "string" ? b["counterparty"].slice(0, 120) || null : null,
    responsible: typeof b["responsible"] === "string" ? b["responsible"].slice(0, 80) || null : null,
    scope: b["scope"] === "pessoal" ? "pessoal" : "empresa",
    storeName: typeof b["storeName"] === "string" ? b["storeName"].slice(0, 60) || null : null,
  }).returning();
  res.status(201).json(row);
});

router.patch("/gerente/bills/:id", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = idParam(req.params["id"]!); if (id == null) { res.status(400).json({ error: "ID inválido" }); return; }
  const b = req.body as Record<string, unknown>;
  const set: Partial<typeof gerenteBillsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof b["description"] === "string" && b["description"].trim()) set.description = b["description"].trim().slice(0, 200);
  if (Number.isInteger(b["amountCents"]) && (b["amountCents"] as number) > 0) set.amountCents = b["amountCents"] as number;
  if (isISODate(b["dueDate"])) set.dueDate = b["dueDate"];
  if (typeof b["counterparty"] === "string") set.counterparty = b["counterparty"].slice(0, 120) || null;
  if (typeof b["responsible"] === "string") set.responsible = b["responsible"].slice(0, 80) || null;
  if (b["status"] === "paga") { set.status = "paga"; set.paidAt = new Date(); }
  else if (b["status"] === "aberta") { set.status = "aberta"; set.paidAt = null; }
  else if (b["status"] === "cancelada") set.status = "cancelada";
  const [row] = await db.update(gerenteBillsTable).set(set).where(and(eq(gerenteBillsTable.id, id), eq(gerenteBillsTable.tenantId, tenantId))).returning();
  if (!row) { res.status(404).json({ error: "Conta não encontrada" }); return; }
  res.json(row);
});

// ─── Conversa ────────────────────────────────────────────────────────────────
router.get("/gerente/messages", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const limit = Math.max(1, Math.min(300, Number(req.query["limit"] ?? 80) || 80));
  const rows = await db.select().from(gerenteMessagesTable)
    .where(eq(gerenteMessagesTable.tenantId, tenantId))
    .orderBy(desc(gerenteMessagesTable.id)).limit(limit);
  res.json(rows.reverse());
});

router.post("/gerente/chat", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const text = typeof (req.body as { text?: unknown })?.text === "string" ? (req.body as { text: string }).text.trim() : "";
  if (!text) { res.status(400).json({ error: "Mensagem vazia" }); return; }
  const r = await handlePanelMessage(tenantId, text.slice(0, 2000));
  res.json(r);
});

// Apaga tudo que foi testado (conversa, lembretes, agenda, lançamentos e
// contas desta loja). Exige digitar APAGAR — mesma proteção do protótipo.
router.delete("/gerente/data", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  if ((req.body as { confirm?: unknown })?.confirm !== "APAGAR") { res.status(400).json({ error: "Digite APAGAR para confirmar." }); return; }
  await db.transaction(async (tx) => {
    await tx.delete(gerentePendingActionsTable).where(eq(gerentePendingActionsTable.tenantId, tenantId));
    await tx.delete(gerenteMessagesTable).where(eq(gerenteMessagesTable.tenantId, tenantId));
    await tx.delete(gerenteRemindersTable).where(eq(gerenteRemindersTable.tenantId, tenantId));
    await tx.delete(gerenteEventsTable).where(eq(gerenteEventsTable.tenantId, tenantId));
    await tx.delete(gerenteEntriesTable).where(eq(gerenteEntriesTable.tenantId, tenantId));
    await tx.delete(gerenteBillsTable).where(eq(gerenteBillsTable.tenantId, tenantId));
  });
  res.json({ ok: true });
});

export default router;
