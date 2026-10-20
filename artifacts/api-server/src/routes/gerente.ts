// Gerente IA — painel do dono (admin): configuração, "Meu dia", agenda,
// lembretes, lançamentos, contas, histórico da conversa e a caixa de
// conversa (mesma interpretação do WhatsApp, sem passar pelo bridge).
// Só admin: é a vida pessoal/financeira do dono — nunca vendedor/supervisor.
import { Router, type IRouter } from "express";
import {
  db, gerenteSettingsTable, gerenteMessagesTable, gerenteEventsTable, gerenteRemindersTable,
  gerenteEntriesTable, gerenteBillsTable, gerentePendingActionsTable, whatsappSessionsTable,
  crmContactsTable, conversationsTable,
} from "@workspace/db";
import { eq, and, desc, asc, gte, lt, inArray, sql } from "drizzle-orm";
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
  const s = await getGerenteSettings(tenantId);
  // Linhas de WhatsApp da loja — pra mostrar por onde os avisos saem.
  const lines = await db.select({ sessionKey: whatsappSessionsTable.sessionKey, displayName: whatsappSessionsTable.displayName, phoneNumber: whatsappSessionsTable.phoneNumber, status: whatsappSessionsTable.status })
    .from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  res.json({ ...s, lines });
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
  if (isHM(b["quietStart"])) set.quietStart = b["quietStart"];
  if (isHM(b["quietEnd"])) set.quietEnd = b["quietEnd"];
  if (b["dailyDigestTime"] === null) set.dailyDigestTime = null;
  else if (isHM(b["dailyDigestTime"])) set.dailyDigestTime = b["dailyDigestTime"];
  await getGerenteSettings(tenantId);
  const [updated] = await db.update(gerenteSettingsTable).set(set).where(eq(gerenteSettingsTable.tenantId, tenantId)).returning();
  invalidateGerenteCache(tenantId);
  res.json({ ...updated, warnings });
});

// ─── Meu dia ─────────────────────────────────────────────────────────────────
router.get("/gerente/overview", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const today = spDateISO();
  const start = parseSpLocal(`${today}T00:00`)!;
  const end = new Date(start.getTime() + 86_400_000);
  const [events, reminders, bills, entriesMonth, digest] = await Promise.all([
    db.select().from(gerenteEventsTable).where(and(eq(gerenteEventsTable.tenantId, tenantId), eq(gerenteEventsTable.status, "agendado"), gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, end))).orderBy(asc(gerenteEventsTable.startsAt)),
    db.select().from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end))).orderBy(asc(gerenteRemindersTable.dueAt)),
    db.select().from(gerenteBillsTable).where(and(eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"))).orderBy(asc(gerenteBillsTable.dueDate)).limit(50),
    db.select({
      kind: gerenteEntriesTable.kind, scope: gerenteEntriesTable.scope, total: sql<number>`coalesce(sum(${gerenteEntriesTable.amountCents}), 0)::int`,
    }).from(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.tenantId, tenantId), sql`to_char(${gerenteEntriesTable.entryDate}, 'YYYY-MM') = ${today.slice(0, 7)}`)).groupBy(gerenteEntriesTable.kind, gerenteEntriesTable.scope),
    buildDigest(tenantId),
  ]);
  res.json({
    today, events, reminders,
    billsDueToday: bills.filter((b) => b.dueDate <= today),
    billsUpcoming: bills.filter((b) => b.dueDate > today).slice(0, 10),
    month: entriesMonth, digest,
  });
});

// ─── Agenda ──────────────────────────────────────────────────────────────────
router.get("/gerente/events", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const from = isISODate(req.query["from"]) ? parseSpLocal(`${req.query["from"]}T00:00`)! : parseSpLocal(`${spDateISO()}T00:00`)!;
  const days = Math.max(1, Math.min(90, Number(req.query["days"] ?? 30) || 30));
  const to = new Date(from.getTime() + days * 86_400_000);
  const rows = await db.select().from(gerenteEventsTable)
    .where(and(eq(gerenteEventsTable.tenantId, tenantId), gte(gerenteEventsTable.startsAt, from), lt(gerenteEventsTable.startsAt, to)))
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
    .where(all ? eq(gerenteRemindersTable.tenantId, tenantId) : and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente")))
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
