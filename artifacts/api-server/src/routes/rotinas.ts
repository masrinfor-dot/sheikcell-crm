import { Router, type IRouter } from "express";
import {
  db, routineChecklistsTable, routineChecklistQuestionsTable, routineChecklistScopesTable,
  routineResponsesTable, employeesTable, storesTable, sectorsTable, usersTable, leaveRecordsTable,
  type RoutineChecklist, type RoutineChecklistQuestion, type RoutineChecklistScope,
} from "@workspace/db";
import { eq, and, desc, asc, isNotNull, lte, gte } from "drizzle-orm";
import { requireAuth, requireTenant, requireModule } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { isPasswordRecentlyVerified, clearPasswordVerified } from "./auth";

const router: IRouter = Router();

// Fase 1: CRUD do admin (modelo de dados), sem trava/agendamento disparando.
// Fase 2 (abaixo, a partir de "Devido agora"): checklist "devido agora" pro
// usuário logado, reautenticação por senha e resposta com snapshot — ainda
// SOFT (fechável), sem travar o sistema de verdade (isso é a Fase 3).

const VALID_RECURRENCE = ["daily", "weekdays", "specific_days", "weekly", "monthly", "specific_date"];
const VALID_QUESTION_TYPES = ["yes_no", "done_not_done", "text", "number", "value", "photo", "document", "observation"];
const VALID_EVIDENCE_TYPES = ["photo", "document"];

type QuestionInput = {
  label?: unknown; type?: unknown; required?: unknown;
  requiresEvidence?: unknown; evidenceType?: unknown;
};
type ScopeInput = {
  storeId?: unknown; sectorId?: unknown; jobFunction?: unknown; userId?: unknown;
};
type SanitizedQuestion = { label: string; type: string; required: boolean; requiresEvidence: boolean; evidenceType: string | null };
type SanitizedScope = { storeId: number | null; sectorId: number | null; jobFunction: string | null; userId: number | null };

function sanitizeQuestions(input: unknown): SanitizedQuestion[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) return null;
  const out: SanitizedQuestion[] = [];
  for (const raw of input as QuestionInput[]) {
    const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, 300) : "";
    if (!label) return null;
    const type = typeof raw?.type === "string" && VALID_QUESTION_TYPES.includes(raw.type) ? raw.type : "yes_no";
    const requiresEvidence = raw?.requiresEvidence === true;
    let evidenceType: string | null = null;
    if (requiresEvidence) {
      evidenceType = typeof raw?.evidenceType === "string" && VALID_EVIDENCE_TYPES.includes(raw.evidenceType) ? raw.evidenceType : "photo";
    }
    out.push({ label, type, required: raw?.required !== false, requiresEvidence, evidenceType });
  }
  return out;
}

function sanitizeScopes(input: unknown): SanitizedScope[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > 200) return null;
  const out: SanitizedScope[] = [];
  for (const raw of input as ScopeInput[]) {
    const storeId = typeof raw?.storeId === "number" && Number.isFinite(raw.storeId) ? raw.storeId : null;
    const sectorId = typeof raw?.sectorId === "number" && Number.isFinite(raw.sectorId) ? raw.sectorId : null;
    const jobFunction = typeof raw?.jobFunction === "string" && raw.jobFunction.trim() ? raw.jobFunction.trim().slice(0, 120) : null;
    const userId = typeof raw?.userId === "number" && Number.isFinite(raw.userId) ? raw.userId : null;
    out.push({ storeId, sectorId, jobFunction, userId });
  }
  return out;
}

function sanitizeRecurrenceDays(recurrence: string, input: unknown): number[] | null {
  if (recurrence !== "specific_days" && recurrence !== "weekly" && recurrence !== "monthly") return null;
  if (!Array.isArray(input)) return null;
  const max = recurrence === "monthly" ? 31 : 6;
  const min = recurrence === "monthly" ? 1 : 0;
  const days = input
    .map((d) => (typeof d === "number" ? d : parseInt(String(d), 10)))
    .filter((d) => Number.isFinite(d) && d >= min && d <= max);
  return days.length ? Array.from(new Set(days)).sort((a, b) => a - b) : null;
}

async function loadChecklistFull(tenantId: number, id: number) {
  const [checklist] = await db.select().from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.id, id), eq(routineChecklistsTable.tenantId, tenantId)));
  if (!checklist) return null;
  const questions = await db.select().from(routineChecklistQuestionsTable)
    .where(eq(routineChecklistQuestionsTable.checklistId, id))
    .orderBy(asc(routineChecklistQuestionsTable.orderIndex));
  const scopes = await db.select().from(routineChecklistScopesTable)
    .where(eq(routineChecklistScopesTable.checklistId, id));
  return { ...checklist, questions, scopes };
}

// ── Listar ───────────────────────────────────────────────────────────────
router.get("/rotinas/checklists", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(routineChecklistsTable)
    .where(eq(routineChecklistsTable.tenantId, tenantId))
    .orderBy(desc(routineChecklistsTable.createdAt));
  // Contagem de perguntas/escopos por checklist (evita N+1 no card da lista).
  const [questionCounts, scopeCounts] = await Promise.all([
    db.select({ checklistId: routineChecklistQuestionsTable.checklistId })
      .from(routineChecklistQuestionsTable).where(eq(routineChecklistQuestionsTable.tenantId, tenantId)),
    db.select({ checklistId: routineChecklistScopesTable.checklistId })
      .from(routineChecklistScopesTable).where(eq(routineChecklistScopesTable.tenantId, tenantId)),
  ]);
  const qCount = new Map<number, number>();
  for (const q of questionCounts) qCount.set(q.checklistId, (qCount.get(q.checklistId) ?? 0) + 1);
  const sCount = new Map<number, number>();
  for (const s of scopeCounts) sCount.set(s.checklistId, (sCount.get(s.checklistId) ?? 0) + 1);
  res.json(rows.map((c) => ({ ...c, questionCount: qCount.get(c.id) ?? 0, scopeCount: sCount.get(c.id) ?? 0 })));
});

// ── Detalhe (com perguntas + escopos) ──────────────────────────────────────
router.get("/rotinas/checklists/:id", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const full = await loadChecklistFull(tenantId, id);
  if (!full) { res.status(404).json({ error: "Checklist não encontrado" }); return; }
  res.json(full);
});

// ── Criar ───────────────────────────────────────────────────────────────
router.post("/rotinas/checklists", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 150) : "";
  if (!name) { res.status(400).json({ error: "Informe o nome" }); return; }
  const scheduledTime = typeof b.scheduledTime === "string" && /^\d{2}:\d{2}$/.test(b.scheduledTime) ? b.scheduledTime : "";
  if (!scheduledTime) { res.status(400).json({ error: "Horário inválido (use HH:MM)" }); return; }
  const recurrence = typeof b.recurrence === "string" && VALID_RECURRENCE.includes(b.recurrence) ? b.recurrence : "daily";
  const recurrenceDays = sanitizeRecurrenceDays(recurrence, b.recurrenceDays);
  const specificDate = recurrence === "specific_date" && typeof b.specificDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.specificDate)
    ? b.specificDate : null;
  if (recurrence === "specific_date" && !specificDate) { res.status(400).json({ error: "Informe a data específica" }); return; }
  const toleranceMinutes = [0, 5, 15, 30].includes(Number(b.toleranceMinutes)) ? Number(b.toleranceMinutes) : 0;
  const questions = sanitizeQuestions(b.questions);
  if (!questions) { res.status(400).json({ error: "Perguntas inválidas (1 a 50, cada uma com rótulo)" }); return; }
  const scopes = sanitizeScopes(b.scopes ?? []);
  if (!scopes) { res.status(400).json({ error: "Escopo inválido" }); return; }

  const created = await db.transaction(async (tx) => {
    const [checklist] = await tx.insert(routineChecklistsTable).values({
      tenantId, name,
      message: typeof b.message === "string" ? b.message.trim().slice(0, 1000) || null : null,
      scheduledTime, recurrence, recurrenceDays, specificDate,
      toleranceMinutes,
      mandatory: b.mandatory !== false,
      active: b.active !== false,
      createdByUserId: req.session.userId!,
    }).returning();
    if (questions.length) {
      await tx.insert(routineChecklistQuestionsTable).values(
        questions.map((q, i) => ({ tenantId, checklistId: checklist!.id, orderIndex: i, ...q })),
      );
    }
    if (scopes.length) {
      await tx.insert(routineChecklistScopesTable).values(
        scopes.map((s) => ({ tenantId, checklistId: checklist!.id, ...s })),
      );
    }
    return checklist!;
  });

  const full = await loadChecklistFull(tenantId, created.id);
  res.status(201).json(full);
});

// ── Editar ──────────────────────────────────────────────────────────────
router.patch("/rotinas/checklists/:id", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.id, id), eq(routineChecklistsTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Checklist não encontrado" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 150) : "";
    if (!name) { res.status(400).json({ error: "Informe o nome" }); return; }
    update.name = name;
  }
  if (b.message !== undefined) update.message = typeof b.message === "string" ? b.message.trim().slice(0, 1000) || null : null;
  if (b.scheduledTime !== undefined) {
    if (typeof b.scheduledTime !== "string" || !/^\d{2}:\d{2}$/.test(b.scheduledTime)) { res.status(400).json({ error: "Horário inválido (use HH:MM)" }); return; }
    update.scheduledTime = b.scheduledTime;
  }
  const recurrence = typeof b.recurrence === "string" && VALID_RECURRENCE.includes(b.recurrence) ? b.recurrence : existing.recurrence;
  if (b.recurrence !== undefined) update.recurrence = recurrence;
  if (b.recurrenceDays !== undefined || b.recurrence !== undefined) update.recurrenceDays = sanitizeRecurrenceDays(recurrence, b.recurrenceDays ?? existing.recurrenceDays);
  if (b.specificDate !== undefined) {
    update.specificDate = recurrence === "specific_date" && typeof b.specificDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.specificDate)
      ? b.specificDate : null;
  }
  if (b.toleranceMinutes !== undefined) update.toleranceMinutes = [0, 5, 15, 30].includes(Number(b.toleranceMinutes)) ? Number(b.toleranceMinutes) : 0;
  if (b.mandatory !== undefined) update.mandatory = !!b.mandatory;
  if (b.active !== undefined) update.active = !!b.active;

  let questions: SanitizedQuestion[] | null = null;
  if (b.questions !== undefined) {
    questions = sanitizeQuestions(b.questions);
    if (!questions) { res.status(400).json({ error: "Perguntas inválidas (1 a 50, cada uma com rótulo)" }); return; }
    // Editar as perguntas muda o que uma resposta futura vai significar —
    // versão sobe pra o admin acompanhar (a garantia real de não afetar
    // respostas antigas vem do snapshot gravado em cada resposta, Fase 2).
    update.version = existing.version + 1;
  }
  let scopes: SanitizedScope[] | null = null;
  if (b.scopes !== undefined) {
    scopes = sanitizeScopes(b.scopes);
    if (!scopes) { res.status(400).json({ error: "Escopo inválido" }); return; }
  }

  await db.transaction(async (tx) => {
    if (Object.keys(update).length) {
      await tx.update(routineChecklistsTable).set(update)
        .where(and(eq(routineChecklistsTable.id, id), eq(routineChecklistsTable.tenantId, tenantId)));
    }
    if (questions) {
      await tx.delete(routineChecklistQuestionsTable).where(eq(routineChecklistQuestionsTable.checklistId, id));
      await tx.insert(routineChecklistQuestionsTable).values(
        questions.map((q, i) => ({ tenantId, checklistId: id, orderIndex: i, ...q })),
      );
    }
    if (scopes) {
      await tx.delete(routineChecklistScopesTable).where(eq(routineChecklistScopesTable.checklistId, id));
      if (scopes.length) {
        await tx.insert(routineChecklistScopesTable).values(
          scopes.map((s) => ({ tenantId, checklistId: id, ...s })),
        );
      }
    }
  });

  const full = await loadChecklistFull(tenantId, id);
  res.json(full);
});

// ── Excluir ─────────────────────────────────────────────────────────────
router.delete("/rotinas/checklists/:id", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.id, id), eq(routineChecklistsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ── Auxiliares pra montar o formulário de escopo ───────────────────────────
// Funções já usadas em employees.job_function (texto livre) — dropdown
// dinâmico em vez de tabela de catálogo nova.
router.get("/rotinas/job-functions", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.selectDistinct({ jobFunction: employeesTable.jobFunction }).from(employeesTable)
    .where(and(eq(employeesTable.tenantId, tenantId), isNotNull(employeesTable.jobFunction)));
  const values = rows.map((r) => r.jobFunction).filter((v): v is string => !!v && v.trim().length > 0).sort();
  res.json(Array.from(new Set(values)));
});

router.get("/rotinas/scope-options", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [stores, sectors, users] = await Promise.all([
    db.select({ id: storesTable.id, name: storesTable.name }).from(storesTable).where(eq(storesTable.tenantId, tenantId)),
    db.select({ id: sectorsTable.id, name: sectorsTable.name }).from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId)),
    db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId)),
  ]);
  res.json({ stores, sectors, users });
});

// ── Devido agora (resolução pro usuário logado) ────────────────────────────

function todayInfo(): { dateKey: string; weekday: number; dayOfMonth: number; nowMinutes: number } {
  const now = new Date();
  const dateKey = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const weekdayName = now.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", hour12: false, hour: "2-digit", minute: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hh = parseInt(get("hour"), 10);
  if (hh === 24) hh = 0; // quirk do Intl: meia-noite às vezes vem como "24"
  const nowMinutes = hh * 60 + parseInt(get("minute"), 10);
  const dayOfMonth = parseInt(get("day"), 10);
  return { dateKey, weekday, dayOfMonth, nowMinutes };
}

// Devido hoje (dia certo pra recorrência) — fica pendente pro resto do dia
// até responder, mesmo espírito de checklists.ts (não "expira" sozinho).
function isDueToday(c: RoutineChecklist, info: ReturnType<typeof todayInfo>): boolean {
  switch (c.recurrence) {
    case "daily": return true;
    case "weekdays": return info.weekday >= 1 && info.weekday <= 5;
    case "specific_days":
    case "weekly": return (c.recurrenceDays ?? []).includes(info.weekday);
    case "monthly": return (c.recurrenceDays ?? [])[0] === info.dayOfMonth;
    case "specific_date": return c.specificDate === info.dateKey;
    default: return false;
  }
}

type UserRoutineContext = { storeId: number | null; sectorId: number | null; jobFunction: string | null; employeeId: number | null };

async function resolveUserContext(tenantId: number, userId: number): Promise<UserRoutineContext> {
  const [user] = await db.select({ storeId: usersTable.storeId, sectorId: usersTable.sectorId })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
  const [employee] = await db.select({ id: employeesTable.id, jobFunction: employeesTable.jobFunction })
    .from(employeesTable).where(and(eq(employeesTable.userId, userId), eq(employeesTable.tenantId, tenantId)));
  return {
    storeId: user?.storeId ?? null,
    sectorId: user?.sectorId ?? null,
    jobFunction: employee?.jobFunction ?? null,
    employeeId: employee?.id ?? null,
  };
}

// Uma regra "casa" se TODA dimensão preenchida bate (AND); dimensão nula na
// regra = coringa. O checklist se aplica ao usuário se QUALQUER regra casar
// (OR entre regras) — várias regras cobrem várias combinações de uma vez.
function scopeMatchesUser(scope: RoutineChecklistScope, ctx: UserRoutineContext, userId: number): boolean {
  if (scope.storeId != null && scope.storeId !== ctx.storeId) return false;
  if (scope.sectorId != null && scope.sectorId !== ctx.sectorId) return false;
  if (scope.jobFunction != null && scope.jobFunction !== ctx.jobFunction) return false;
  if (scope.userId != null && scope.userId !== userId) return false;
  return true;
}

async function isOnLeaveToday(tenantId: number, employeeId: number | null, dateKey: string): Promise<boolean> {
  if (employeeId == null) return false;
  const [leave] = await db.select({ id: leaveRecordsTable.id }).from(leaveRecordsTable)
    .where(and(
      eq(leaveRecordsTable.tenantId, tenantId), eq(leaveRecordsTable.employeeId, employeeId),
      lte(leaveRecordsTable.startDate, dateKey), gte(leaveRecordsTable.endDate, dateKey),
    )).limit(1);
  return !!leave;
}

type PendingRoutine = RoutineChecklist & { questions: RoutineChecklistQuestion[]; periodKey: string };

async function getPendingRoutines(tenantId: number, userId: number): Promise<PendingRoutine[]> {
  const info = todayInfo();
  const ctx = await resolveUserContext(tenantId, userId);
  if (await isOnLeaveToday(tenantId, ctx.employeeId, info.dateKey)) return [];

  const checklists = await db.select().from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.tenantId, tenantId), eq(routineChecklistsTable.active, true)));
  const due = checklists.filter((c) => info.nowMinutes >= parseInt(c.scheduledTime.slice(0, 2), 10) * 60 + parseInt(c.scheduledTime.slice(3, 5), 10) && isDueToday(c, info));
  if (due.length === 0) return [];

  const allScopes = await db.select().from(routineChecklistScopesTable)
    .where(eq(routineChecklistScopesTable.tenantId, tenantId));
  const scopesByChecklist = new Map<number, RoutineChecklistScope[]>();
  for (const s of allScopes) scopesByChecklist.set(s.checklistId, [...(scopesByChecklist.get(s.checklistId) ?? []), s]);

  const applicable = due.filter((c) => {
    const scopes = scopesByChecklist.get(c.id) ?? [];
    return scopes.some((s) => scopeMatchesUser(s, ctx, userId));
  });
  if (applicable.length === 0) return [];

  const answered = await db.select({ checklistId: routineResponsesTable.checklistId })
    .from(routineResponsesTable)
    .where(and(eq(routineResponsesTable.userId, userId), eq(routineResponsesTable.periodKey, info.dateKey)));
  const answeredIds = new Set(answered.map((a) => a.checklistId));
  const pending = applicable.filter((c) => !answeredIds.has(c.id));
  if (pending.length === 0) return [];

  const questions = await db.select().from(routineChecklistQuestionsTable)
    .where(eq(routineChecklistQuestionsTable.tenantId, tenantId))
    .orderBy(asc(routineChecklistQuestionsTable.orderIndex));
  const questionsByChecklist = new Map<number, RoutineChecklistQuestion[]>();
  for (const q of questions) questionsByChecklist.set(q.checklistId, [...(questionsByChecklist.get(q.checklistId) ?? []), q]);

  return pending.map((c) => ({ ...c, questions: questionsByChecklist.get(c.id) ?? [], periodKey: info.dateKey }));
}

router.get("/rotinas/pending", requireAuth, requireModule("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const pending = await getPendingRoutines(tenantId, req.session.userId!);
  res.json(pending.map((p) => ({
    id: p.id, name: p.name, message: p.message, mandatory: p.mandatory, periodKey: p.periodKey,
    questions: p.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, required: q.required, requiresEvidence: q.requiresEvidence, evidenceType: q.evidenceType })),
  })));
});

// ── Responder ───────────────────────────────────────────────────────────
router.post("/rotinas/checklists/:id/respond", requireAuth, requireModule("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  if (!isPasswordRecentlyVerified(tenantId, userId)) {
    res.status(401).json({ error: "Confirme sua senha antes de responder", code: "REAUTH_REQUIRED" });
    return;
  }

  const pending = await getPendingRoutines(tenantId, userId);
  const target = pending.find((p) => p.id === id);
  if (!target) { res.status(404).json({ error: "Checklist não está pendente pra você agora" }); return; }

  const body = (req.body ?? {}) as { answers?: Record<string, string> };
  const raw = body.answers && typeof body.answers === "object" ? body.answers : {};
  const answers: Record<string, string> = {};
  for (const q of target.questions) {
    const v = typeof raw[q.id] === "string" ? raw[q.id].trim().slice(0, 1000) : "";
    if (!v && q.required) { res.status(400).json({ error: `Responda: "${q.label}"` }); return; }
    if (v) answers[q.id] = v;
  }

  try {
    const [saved] = await db.insert(routineResponsesTable).values({
      tenantId, checklistId: id, userId, periodKey: target.periodKey, answers,
      questionsSnapshot: target.questions.map((q) => ({
        id: q.id, label: q.label, type: q.type, required: q.required, requiresEvidence: q.requiresEvidence, evidenceType: q.evidenceType,
      })),
      reauthAt: new Date(),
      deviceInfo: (req.headers["user-agent"] as string | undefined)?.slice(0, 300) ?? null,
    }).returning();
    clearPasswordVerified(tenantId, userId);
    res.status(201).json(saved);
  } catch {
    res.status(409).json({ error: "Você já respondeu este checklist neste período" });
  }
});

// ── Respostas de um checklist — funcionário vê só a própria, supervisor vê
// o setor dele, admin vê tudo (mesmo formato de canAccessConversation, chat.ts). ──
router.get("/rotinas/checklists/:id/responses", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [checklist] = await db.select({ id: routineChecklistsTable.id }).from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.id, id), eq(routineChecklistsTable.tenantId, tenantId)));
  if (!checklist) { res.status(404).json({ error: "Checklist não encontrado" }); return; }

  const rows = await db.select({
    id: routineResponsesTable.id, userId: routineResponsesTable.userId, userName: usersTable.name,
    userSectorId: usersTable.sectorId, periodKey: routineResponsesTable.periodKey,
    answers: routineResponsesTable.answers, questionsSnapshot: routineResponsesTable.questionsSnapshot,
    reauthAt: routineResponsesTable.reauthAt, createdAt: routineResponsesTable.createdAt,
  })
    .from(routineResponsesTable)
    .leftJoin(usersTable, eq(routineResponsesTable.userId, usersTable.id))
    .where(eq(routineResponsesTable.checklistId, id))
    .orderBy(desc(routineResponsesTable.createdAt))
    .limit(500);

  const role = req.session.userRole;
  const ownSectorId = req.session.userSectorId;
  const visible = role === "admin"
    ? rows
    : role === "supervisor"
      ? rows.filter((r) => r.userId === req.session.userId || (ownSectorId != null && r.userSectorId === ownSectorId))
      : rows.filter((r) => r.userId === req.session.userId);

  res.json(visible.map(({ userSectorId: _userSectorId, ...r }) => r));
});

export default router;
