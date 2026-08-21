import { Router, type IRouter, type Request, type Response } from "express";
import {
  db, employeesTable, workShiftsTable, timeClockEntriesTable, timeBankAdjustmentsTable, leaveRecordsTable,
  timeBankClosuresTable, usersTable, storesTable,
} from "@workspace/db";
import { eq, and, desc, asc, gte, lte, inArray } from "drizzle-orm";
import { requireAuth, requireTenant, tenantIdOf } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { computeTimeBank, nextPunchKind, dayKeySaoPaulo, employeeNeedsClockInToday } from "../lib/timeBank";
import { generateClosuresForMonth, previousMonthKey, currentMonthKey } from "../lib/timeBankClosures";

const router: IRouter = Router();

const PUNCH_KINDS = ["in", "break_start", "break_end", "out"] as const;
type PunchKind = (typeof PUNCH_KINDS)[number];
const CONTRACT_TYPES = ["clt", "pj", "estagio"] as const;
const LEAVE_KINDS = ["ferias", "atestado", "falta_justificada", "falta_injustificada", "outro"] as const;

function parseDateRange(req: Request, res: Response): { from: Date; to: Date } | null {
  const parseDate = (v: unknown): Date | null => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = parseDate(req.query.to) ?? new Date();
  const from = parseDate(req.query.from) ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) { res.status(400).json({ error: "Período inválido" }); return null; }
  return { from, to };
}

function parseHHMM(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{2}:\d{2}$/.test(v)) return null;
  const [h, m] = v.split(":").map(Number);
  if (h! < 0 || h! > 23 || m! < 0 || m! > 59) return null;
  return h! * 60 + m!;
}

async function getEmployeeForUser(userId: number, tenantId: number) {
  const [row] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.userId, userId), eq(employeesTable.tenantId, tenantId)));
  return row ?? null;
}

async function getEmployee(id: number, tenantId: number) {
  const [row] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, id), eq(employeesTable.tenantId, tenantId)));
  return row ?? null;
}

// ── Ponto obrigatório: bloqueia o uso do sistema até bater a entrada ────────
// Mesmo padrão de enforceMandatoryChecklists/enforceMandatoryTrainings
// (checklists.ts/trainings.ts): cache curto por tenant:usuário, allowlist de
// rotas sempre liberadas, 423 pro resto. Só se aplica a quem tem employee
// vinculado com escala "fixed" prevendo expediente hoje — ver
// employeeNeedsClockInToday em lib/timeBank.ts.
const CLOCK_IN_BLOCK_CACHE_MS = 60000;
const clockInBlockCache = new Map<string, { until: number; blocked: boolean }>();
export function invalidateClockInBlock(uid: number): void {
  for (const k of clockInBlockCache.keys()) if (k.endsWith(`:${uid}`)) clockInBlockCache.delete(k);
}

export const CLOCK_IN_GATE_ALLOWLIST = [
  /^\/auth\//,
  /^\/rh-dp\/me\/clock-status$/, /^\/rh-dp\/me\/punch$/,
];

export async function enforceMandatoryClockIn(req: Request, res: Response, next: import("express").NextFunction): Promise<void> {
  const uid = req.session?.userId;
  if (!uid) { next(); return; }
  if (CLOCK_IN_GATE_ALLOWLIST.some((r) => r.test(req.path))) { next(); return; }
  // Admin nunca é obrigado, mesmo com cadastro de RH vinculado.
  if (req.session.userRole === "admin") { next(); return; }
  const tenantId = tenantIdOf(req);
  if (tenantId == null) { next(); return; } // superadmin/sessão sem loja: sem RH a exigir
  try {
    const cacheKey = `${tenantId}:${uid}`;
    const cached = clockInBlockCache.get(cacheKey);
    let blocked: boolean;
    if (cached && cached.until > Date.now()) {
      blocked = cached.blocked;
    } else {
      const employee = await getEmployeeForUser(uid, tenantId);
      if (!employee) {
        blocked = false;
      } else {
        const shift = employee.shiftId
          ? (await db.select().from(workShiftsTable).where(eq(workShiftsTable.id, employee.shiftId)))[0] ?? null
          : null;
        blocked = await employeeNeedsClockInToday(employee.id, tenantId, shift);
      }
      clockInBlockCache.set(cacheKey, { until: Date.now() + CLOCK_IN_BLOCK_CACHE_MS, blocked });
    }
    if (blocked) {
      res.status(423).json({ error: "Bata o ponto de entrada para liberar o sistema", code: "CLOCK_IN_REQUIRED" });
      return;
    }
    next();
  } catch {
    next(); // falha do banco não pode derrubar o sistema inteiro
  }
}

// ── Auto-serviço (qualquer colaborador logado vinculado, sem gate de módulo) ─

router.get("/rh-dp/me", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }
  res.json(employee);
});

router.post("/rh-dp/me/punch", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }

  const shift = employee.shiftId
    ? (await db.select().from(workShiftsTable).where(eq(workShiftsTable.id, employee.shiftId)))[0] ?? null
    : null;
  const hasBreak = !!(shift?.breakStart && shift?.breakEnd);

  const todayKey = dayKeySaoPaulo(new Date());
  const dayStart = new Date(`${todayKey}T00:00:00-03:00`);
  const dayEnd = new Date(`${todayKey}T23:59:59-03:00`);
  const todayEntries = await db.select().from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employee.id),
      eq(timeClockEntriesTable.tenantId, tenantId),
      gte(timeClockEntriesTable.at, dayStart),
      lte(timeClockEntriesTable.at, dayEnd),
    ))
    .orderBy(asc(timeClockEntriesTable.at));

  const kind = nextPunchKind(todayEntries, hasBreak);
  if (!kind) { res.status(409).json({ error: "Você já bateu todos os pontos de hoje." }); return; }

  const [created] = await db.insert(timeClockEntriesTable).values({
    tenantId, employeeId: employee.id, kind, source: "self", createdByUserId: req.session.userId,
  }).returning();
  invalidateClockInBlock(req.session.userId!);
  res.status(201).json(created);
});

router.get("/rh-dp/me/clock-status", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  // Admin nunca é obrigado a bater ponto, mesmo com cadastro de RH vinculado.
  if (req.session.userRole === "admin") { res.json({ needsClockIn: false }); return; }
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.json({ needsClockIn: false }); return; }
  const shift = employee.shiftId
    ? (await db.select().from(workShiftsTable).where(eq(workShiftsTable.id, employee.shiftId)))[0] ?? null
    : null;
  const needsClockIn = await employeeNeedsClockInToday(employee.id, tenantId, shift);
  res.json({ needsClockIn });
});

router.get("/rh-dp/me/time-bank", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }
  const range = parseDateRange(req, res); if (!range) return;
  const result = await computeTimeBank(employee.id, tenantId, range.from, range.to);
  res.json(result);
});

// ── Gestão (requireModuleAccess("rh")) ───────────────────────────────────────

router.get("/rh-dp/employees", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select({
    id: employeesTable.id,
    userId: employeesTable.userId,
    name: employeesTable.name,
    birthDate: employeesTable.birthDate,
    phone: employeesTable.phone,
    email: employeesTable.email,
    cpf: employeesTable.cpf,
    rg: employeesTable.rg,
    role: employeesTable.role,
    jobFunction: employeesTable.jobFunction,
    admissionDate: employeesTable.admissionDate,
    contractType: employeesTable.contractType,
    salaryCents: employeesTable.salaryCents,
    storeId: employeesTable.storeId,
    shiftId: employeesTable.shiftId,
    isActive: employeesTable.isActive,
    createdAt: employeesTable.createdAt,
    userName: usersTable.name,
    storeName: storesTable.name,
    shiftName: workShiftsTable.name,
  }).from(employeesTable)
    .leftJoin(usersTable, eq(employeesTable.userId, usersTable.id))
    .leftJoin(storesTable, eq(employeesTable.storeId, storesTable.id))
    .leftJoin(workShiftsTable, eq(employeesTable.shiftId, workShiftsTable.id))
    .where(eq(employeesTable.tenantId, tenantId))
    .orderBy(asc(employeesTable.name));
  res.json(rows);
});

router.post("/rh-dp/employees", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  if (!name) { res.status(400).json({ error: "Informe o nome do colaborador" }); return; }

  const contractType = typeof b.contractType === "string" && CONTRACT_TYPES.includes(b.contractType as typeof CONTRACT_TYPES[number]) ? b.contractType : null;
  const salaryCents = typeof b.salaryCents === "number" && Number.isFinite(b.salaryCents) && b.salaryCents >= 0 ? Math.round(b.salaryCents) : null;

  let userId: number | null = null;
  if (b.userId != null) {
    userId = parseInt(String(b.userId), 10);
    if (isNaN(userId)) { res.status(400).json({ error: "Usuário inválido" }); return; }
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
    if (!u) { res.status(400).json({ error: "Usuário não encontrado" }); return; }
    const [existing] = await db.select({ id: employeesTable.id }).from(employeesTable).where(and(eq(employeesTable.userId, userId), eq(employeesTable.tenantId, tenantId)));
    if (existing) { res.status(409).json({ error: "Esse usuário já está vinculado a outro colaborador" }); return; }
  }

  let storeId: number | null = null;
  if (b.storeId != null) {
    storeId = parseInt(String(b.storeId), 10);
    if (isNaN(storeId)) { res.status(400).json({ error: "Loja inválida" }); return; }
  }
  let shiftId: number | null = null;
  if (b.shiftId != null) {
    shiftId = parseInt(String(b.shiftId), 10);
    if (isNaN(shiftId)) { res.status(400).json({ error: "Escala inválida" }); return; }
  }

  const [created] = await db.insert(employeesTable).values({
    tenantId, userId, name,
    birthDate: typeof b.birthDate === "string" && b.birthDate ? b.birthDate : null,
    phone: typeof b.phone === "string" ? b.phone.trim().slice(0, 30) || null : null,
    email: typeof b.email === "string" ? b.email.trim().slice(0, 120) || null : null,
    cpf: typeof b.cpf === "string" ? b.cpf.trim().slice(0, 20) || null : null,
    rg: typeof b.rg === "string" ? b.rg.trim().slice(0, 20) || null : null,
    role: typeof b.role === "string" ? b.role.trim().slice(0, 80) || null : null,
    jobFunction: typeof b.jobFunction === "string" ? b.jobFunction.trim().slice(0, 80) || null : null,
    admissionDate: typeof b.admissionDate === "string" && b.admissionDate ? b.admissionDate : null,
    contractType, salaryCents, storeId, shiftId,
    isActive: b.isActive !== false,
  }).returning();
  res.status(201).json(created);
});

router.patch("/rh-dp/employees/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await getEmployee(id, tenantId);
  if (!existing) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  if (typeof b.name === "string") {
    const name = b.name.trim().slice(0, 120);
    if (!name) { res.status(400).json({ error: "Nome não pode ficar vazio" }); return; }
    update.name = name;
  }
  if ("birthDate" in b) update.birthDate = typeof b.birthDate === "string" && b.birthDate ? b.birthDate : null;
  if ("phone" in b) update.phone = typeof b.phone === "string" ? b.phone.trim().slice(0, 30) || null : null;
  if ("email" in b) update.email = typeof b.email === "string" ? b.email.trim().slice(0, 120) || null : null;
  if ("cpf" in b) update.cpf = typeof b.cpf === "string" ? b.cpf.trim().slice(0, 20) || null : null;
  if ("rg" in b) update.rg = typeof b.rg === "string" ? b.rg.trim().slice(0, 20) || null : null;
  if ("role" in b) update.role = typeof b.role === "string" ? b.role.trim().slice(0, 80) || null : null;
  if ("jobFunction" in b) update.jobFunction = typeof b.jobFunction === "string" ? b.jobFunction.trim().slice(0, 80) || null : null;
  if ("admissionDate" in b) update.admissionDate = typeof b.admissionDate === "string" && b.admissionDate ? b.admissionDate : null;
  if ("contractType" in b) {
    update.contractType = typeof b.contractType === "string" && CONTRACT_TYPES.includes(b.contractType as typeof CONTRACT_TYPES[number]) ? b.contractType : null;
  }
  if ("salaryCents" in b) {
    update.salaryCents = typeof b.salaryCents === "number" && Number.isFinite(b.salaryCents) && b.salaryCents >= 0 ? Math.round(b.salaryCents) : null;
  }
  if ("isActive" in b) update.isActive = b.isActive !== false;
  if ("storeId" in b) {
    const sid = b.storeId == null ? null : parseInt(String(b.storeId), 10);
    if (sid != null && isNaN(sid)) { res.status(400).json({ error: "Loja inválida" }); return; }
    update.storeId = sid;
  }
  if ("shiftId" in b) {
    const sid = b.shiftId == null ? null : parseInt(String(b.shiftId), 10);
    if (sid != null && isNaN(sid)) { res.status(400).json({ error: "Escala inválida" }); return; }
    update.shiftId = sid;
  }
  if ("userId" in b) {
    const uid = b.userId == null ? null : parseInt(String(b.userId), 10);
    if (uid != null) {
      if (isNaN(uid)) { res.status(400).json({ error: "Usuário inválido" }); return; }
      const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, uid), eq(usersTable.tenantId, tenantId)));
      if (!u) { res.status(400).json({ error: "Usuário não encontrado" }); return; }
      const [conflict] = await db.select({ id: employeesTable.id }).from(employeesTable)
        .where(and(eq(employeesTable.userId, uid), eq(employeesTable.tenantId, tenantId)));
      if (conflict && conflict.id !== id) { res.status(409).json({ error: "Esse usuário já está vinculado a outro colaborador" }); return; }
    }
    update.userId = uid;
  }

  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(employeesTable).set(update)
    .where(and(eq(employeesTable.id, id), eq(employeesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.delete("/rh-dp/employees/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(employeesTable).where(and(eq(employeesTable.id, id), eq(employeesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ── Escalas ───────────────────────────────────────────────────────────────

router.get("/rh-dp/shifts", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(workShiftsTable).where(eq(workShiftsTable.tenantId, tenantId)).orderBy(asc(workShiftsTable.name));
  res.json(rows);
});

function computeExpectedMinutes(startTime: number, endTime: number, breakStart: number | null, breakEnd: number | null): number | null {
  if (endTime <= startTime) return null;
  let total = endTime - startTime;
  if (breakStart != null && breakEnd != null) {
    if (breakEnd <= breakStart || breakStart < startTime || breakEnd > endTime) return null;
    total -= breakEnd - breakStart;
  }
  return total;
}

router.post("/rh-dp/shifts", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (!name) { res.status(400).json({ error: "Informe o nome da escala" }); return; }
  const type = b.type === "flexible" ? "flexible" : "fixed";
  const weekdays = Array.isArray(b.weekdays) ? b.weekdays.filter((n): n is number => typeof n === "number" && n >= 0 && n <= 6) : [1, 2, 3, 4, 5];

  // Escala livre: sem horário, sem expediente esperado — não exige ponto e
  // não entra no cálculo de "esperado" do banco de horas.
  if (type === "flexible") {
    const [created] = await db.insert(workShiftsTable).values({
      tenantId, name, type, weekdays,
      startTime: null, endTime: null, breakStart: null, breakEnd: null, expectedMinutesPerDay: null,
    }).returning();
    res.status(201).json(created);
    return;
  }

  const start = parseHHMM(b.startTime);
  const end = parseHHMM(b.endTime);
  if (start == null || end == null) { res.status(400).json({ error: "Horário de início/fim inválido (use HH:MM)" }); return; }
  const hasBreak = b.breakStart != null && b.breakStart !== "" && b.breakEnd != null && b.breakEnd !== "";
  const breakStart = hasBreak ? parseHHMM(b.breakStart) : null;
  const breakEnd = hasBreak ? parseHHMM(b.breakEnd) : null;
  if (hasBreak && (breakStart == null || breakEnd == null)) { res.status(400).json({ error: "Horário de intervalo inválido (use HH:MM)" }); return; }
  const expectedMinutesPerDay = computeExpectedMinutes(start, end, breakStart, breakEnd);
  if (expectedMinutesPerDay == null) { res.status(400).json({ error: "Horários da escala inconsistentes (confira início, fim e intervalo)" }); return; }

  const [created] = await db.insert(workShiftsTable).values({
    tenantId, name, type,
    startTime: b.startTime as string, endTime: b.endTime as string,
    breakStart: hasBreak ? (b.breakStart as string) : null,
    breakEnd: hasBreak ? (b.breakEnd as string) : null,
    weekdays, expectedMinutesPerDay,
  }).returning();
  res.status(201).json(created);
});

router.patch("/rh-dp/shifts/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(workShiftsTable).where(and(eq(workShiftsTable.id, id), eq(workShiftsTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Escala não encontrada" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : existing.name;
  const type = "type" in b ? (b.type === "flexible" ? "flexible" : "fixed") : existing.type;
  const weekdays = Array.isArray(b.weekdays) ? b.weekdays.filter((n): n is number => typeof n === "number" && n >= 0 && n <= 6) : (existing.weekdays as number[]);
  if (!name) { res.status(400).json({ error: "Dados da escala inválidos" }); return; }

  if (type === "flexible") {
    const [updated] = await db.update(workShiftsTable).set({
      name, type, weekdays,
      startTime: null, endTime: null, breakStart: null, breakEnd: null, expectedMinutesPerDay: null,
    }).where(and(eq(workShiftsTable.id, id), eq(workShiftsTable.tenantId, tenantId))).returning();
    res.json(updated);
    return;
  }

  const startTimeStr = typeof b.startTime === "string" ? b.startTime : existing.startTime;
  const endTimeStr = typeof b.endTime === "string" ? b.endTime : existing.endTime;
  const breakStartStr = "breakStart" in b ? (b.breakStart as string | null) : existing.breakStart;
  const breakEndStr = "breakEnd" in b ? (b.breakEnd as string | null) : existing.breakEnd;
  const start = parseHHMM(startTimeStr);
  const end = parseHHMM(endTimeStr);
  if (start == null || end == null) { res.status(400).json({ error: "Dados da escala inválidos" }); return; }
  const hasBreak = breakStartStr != null && breakStartStr !== "" && breakEndStr != null && breakEndStr !== "";
  const breakStart = hasBreak ? parseHHMM(breakStartStr) : null;
  const breakEnd = hasBreak ? parseHHMM(breakEndStr) : null;
  if (hasBreak && (breakStart == null || breakEnd == null)) { res.status(400).json({ error: "Horário de intervalo inválido" }); return; }
  const expectedMinutesPerDay = computeExpectedMinutes(start, end, breakStart, breakEnd);
  if (expectedMinutesPerDay == null) { res.status(400).json({ error: "Horários da escala inconsistentes" }); return; }

  const [updated] = await db.update(workShiftsTable).set({
    name, type, startTime: startTimeStr, endTime: endTimeStr,
    breakStart: hasBreak ? breakStartStr : null, breakEnd: hasBreak ? breakEndStr : null,
    weekdays, expectedMinutesPerDay,
  }).where(and(eq(workShiftsTable.id, id), eq(workShiftsTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.delete("/rh-dp/shifts/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.update(employeesTable).set({ shiftId: null }).where(and(eq(employeesTable.shiftId, id), eq(employeesTable.tenantId, tenantId)));
  await db.delete(workShiftsTable).where(and(eq(workShiftsTable.id, id), eq(workShiftsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ── Ponto (gestão) ────────────────────────────────────────────────────────

router.post("/rh-dp/employees/:id/punch", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const employee = await getEmployee(employeeId, tenantId);
  if (!employee) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const b = (req.body ?? {}) as { kind?: string; at?: string };
  if (!b.kind || !PUNCH_KINDS.includes(b.kind as PunchKind)) { res.status(400).json({ error: "Tipo de batida inválido" }); return; }
  let at = new Date();
  if (b.at) {
    const d = new Date(b.at);
    if (Number.isNaN(d.getTime())) { res.status(400).json({ error: "Data/hora inválida" }); return; }
    at = d;
  }
  const [created] = await db.insert(timeClockEntriesTable).values({
    tenantId, employeeId, kind: b.kind as PunchKind, at, source: "admin", createdByUserId: req.session.userId,
  }).returning();
  // Lançamento manual de "entrada" também libera o gate de ponto obrigatório
  // do colaborador, se ele tiver login vinculado.
  if (b.kind === "in" && employee.userId != null) invalidateClockInBlock(employee.userId);
  res.status(201).json(created);
});

// Lança/edita/limpa as até 4 batidas de um dia inteiro do colaborador numa
// chamada só — cada seção (in/break_start/break_end/out) é opcional: horário
// informado cria (se não existir) ou atualiza (se já existir) a batida
// daquele tipo no dia; omitido/vazio remove a batida existente daquele tipo,
// se houver. Complementa POST .../punch (uma seção por vez) sem substituí-lo.
router.put("/rh-dp/employees/:id/day", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const employee = await getEmployee(employeeId, tenantId);
  if (!employee) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }

  const b = (req.body ?? {}) as { date?: string } & Partial<Record<PunchKind, string | null>>;
  if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    res.status(400).json({ error: "Data inválida (use YYYY-MM-DD)" }); return;
  }
  const date = b.date;

  // Valida formato de cada horário informado.
  for (const k of PUNCH_KINDS) {
    const v = b[k];
    if (v != null && v !== "" && parseHHMM(v) == null) {
      res.status(400).json({ error: `Horário inválido em "${k}" (use HH:MM)` }); return;
    }
  }
  // Sequência lógica: horários informados precisam estar em ordem crescente
  // (entrada ≤ início intervalo ≤ fim intervalo ≤ saída).
  let prevMinutes: number | null = null;
  for (const k of PUNCH_KINDS) {
    const v = b[k];
    if (v == null || v === "") continue;
    const mins = parseHHMM(v)!;
    if (prevMinutes != null && mins < prevMinutes) {
      res.status(400).json({ error: "Os horários precisam estar em ordem: entrada ≤ início intervalo ≤ fim intervalo ≤ saída" });
      return;
    }
    prevMinutes = mins;
  }

  const dayStart = new Date(`${date}T00:00:00-03:00`);
  const dayEnd = new Date(`${date}T23:59:59-03:00`);
  const existing = await db.select().from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employeeId),
      eq(timeClockEntriesTable.tenantId, tenantId),
      gte(timeClockEntriesTable.at, dayStart),
      lte(timeClockEntriesTable.at, dayEnd),
    ));

  const result: Partial<Record<PunchKind, string>> = {};
  for (const k of PUNCH_KINDS) {
    const v = b[k];
    const existingForKind = existing.filter((e) => e.kind === k);

    if (v == null || v === "") {
      // Seção não informada/limpa: remove qualquer batida existente desse tipo no dia.
      if (existingForKind.length > 0) {
        await db.delete(timeClockEntriesTable).where(and(
          eq(timeClockEntriesTable.tenantId, tenantId),
          inArray(timeClockEntriesTable.id, existingForKind.map((e) => e.id)),
        ));
      }
      continue;
    }

    const at = new Date(`${date}T${v}:00-03:00`);
    if (existingForKind.length > 0) {
      // Atualiza a primeira batida desse tipo no dia; qualquer duplicata
      // extra (não deveria existir, mas por segurança) é removida.
      const [first, ...rest] = existingForKind;
      await db.update(timeClockEntriesTable)
        .set({ at, source: "admin", createdByUserId: req.session.userId })
        .where(and(eq(timeClockEntriesTable.id, first!.id), eq(timeClockEntriesTable.tenantId, tenantId)));
      if (rest.length > 0) {
        await db.delete(timeClockEntriesTable).where(and(
          eq(timeClockEntriesTable.tenantId, tenantId),
          inArray(timeClockEntriesTable.id, rest.map((e) => e.id)),
        ));
      }
    } else {
      await db.insert(timeClockEntriesTable).values({
        tenantId, employeeId, kind: k, at, source: "admin", createdByUserId: req.session.userId,
      });
    }
    result[k] = at.toISOString();
  }

  // Lançar/editar a entrada também libera o gate de ponto obrigatório, se o
  // colaborador tiver login vinculado — mesmo efeito de POST .../punch.
  if (b.in != null && b.in !== "" && employee.userId != null) invalidateClockInBlock(employee.userId);

  res.json({ ok: true, date, ...result });
});

router.delete("/rh-dp/time-clock-entries/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(timeClockEntriesTable).where(and(eq(timeClockEntriesTable.id, id), eq(timeClockEntriesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

router.get("/rh-dp/employees/:id/time-bank", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const employee = await getEmployee(employeeId, tenantId);
  if (!employee) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const range = parseDateRange(req, res); if (!range) return;
  const result = await computeTimeBank(employeeId, tenantId, range.from, range.to);
  res.json(result);
});

router.post("/rh-dp/employees/:id/time-bank/adjustments", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const employee = await getEmployee(employeeId, tenantId);
  if (!employee) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const b = (req.body ?? {}) as { minutes?: number; reason?: string };
  const minutes = typeof b.minutes === "number" && Number.isFinite(b.minutes) ? Math.round(b.minutes) : NaN;
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (!minutes || !reason) { res.status(400).json({ error: "Informe os minutos (diferente de zero) e o motivo do ajuste" }); return; }
  const [created] = await db.insert(timeBankAdjustmentsTable).values({
    tenantId, employeeId, minutes, reason, createdByUserId: req.session.userId!,
  }).returning();
  res.status(201).json(created);
});

// ── Afastamentos ──────────────────────────────────────────────────────────

router.get("/rh-dp/leave-records", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select({
    id: leaveRecordsTable.id,
    employeeId: leaveRecordsTable.employeeId,
    kind: leaveRecordsTable.kind,
    startDate: leaveRecordsTable.startDate,
    endDate: leaveRecordsTable.endDate,
    notes: leaveRecordsTable.notes,
    createdAt: leaveRecordsTable.createdAt,
    employeeName: employeesTable.name,
  }).from(leaveRecordsTable)
    .leftJoin(employeesTable, eq(leaveRecordsTable.employeeId, employeesTable.id))
    .where(eq(leaveRecordsTable.tenantId, tenantId))
    .orderBy(desc(leaveRecordsTable.startDate)).limit(500);
  res.json(rows);
});

router.post("/rh-dp/leave-records", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const employeeId = parseInt(String(b.employeeId), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "Selecione o colaborador" }); return; }
  const employee = await getEmployee(employeeId, tenantId);
  if (!employee) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const kind = typeof b.kind === "string" && LEAVE_KINDS.includes(b.kind as typeof LEAVE_KINDS[number]) ? b.kind : null;
  if (!kind) { res.status(400).json({ error: "Tipo de afastamento inválido" }); return; }
  const startDate = typeof b.startDate === "string" ? b.startDate : "";
  const endDate = typeof b.endDate === "string" ? b.endDate : "";
  if (!startDate || !endDate || endDate < startDate) { res.status(400).json({ error: "Informe um período de datas válido" }); return; }
  const [created] = await db.insert(leaveRecordsTable).values({
    tenantId, employeeId, kind, startDate, endDate,
    notes: typeof b.notes === "string" ? b.notes.trim().slice(0, 1000) || null : null,
    createdByUserId: req.session.userId!,
  }).returning();
  res.status(201).json(created);
});

router.delete("/rh-dp/leave-records/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(leaveRecordsTable).where(and(eq(leaveRecordsTable.id, id), eq(leaveRecordsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ── Relatórios ────────────────────────────────────────────────────────────

router.get("/rh-dp/reports/timesheet", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const employeeIdRaw = req.query.employeeId;
  const conditions = [
    eq(timeClockEntriesTable.tenantId, tenantId),
    gte(timeClockEntriesTable.at, range.from),
    lte(timeClockEntriesTable.at, range.to),
  ];
  if (typeof employeeIdRaw === "string" && employeeIdRaw) {
    const eid = parseInt(employeeIdRaw, 10);
    if (!isNaN(eid)) conditions.push(eq(timeClockEntriesTable.employeeId, eid));
  }
  const rows = await db.select({
    id: timeClockEntriesTable.id,
    employeeId: timeClockEntriesTable.employeeId,
    employeeName: employeesTable.name,
    kind: timeClockEntriesTable.kind,
    at: timeClockEntriesTable.at,
    source: timeClockEntriesTable.source,
  }).from(timeClockEntriesTable)
    .leftJoin(employeesTable, eq(timeClockEntriesTable.employeeId, employeesTable.id))
    .where(and(...conditions))
    .orderBy(desc(timeClockEntriesTable.at)).limit(2000);
  res.json(rows);
});

router.get("/rh-dp/reports/time-bank-summary", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const employees = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.isActive, true)))
    .orderBy(asc(employeesTable.name));
  const results = await Promise.all(employees.map(async (e) => ({
    employeeId: e.id,
    employeeName: e.name,
    ...(await computeTimeBank(e.id, tenantId, range.from, range.to)),
  })));
  res.json(results.map((r) => ({ ...r, days: undefined })));
});

router.get("/rh-dp/reports/leaves", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const fromStr = range.from.toISOString().slice(0, 10);
  const toStr = range.to.toISOString().slice(0, 10);
  const rows = await db.select({
    id: leaveRecordsTable.id,
    employeeId: leaveRecordsTable.employeeId,
    employeeName: employeesTable.name,
    kind: leaveRecordsTable.kind,
    startDate: leaveRecordsTable.startDate,
    endDate: leaveRecordsTable.endDate,
    notes: leaveRecordsTable.notes,
  }).from(leaveRecordsTable)
    .leftJoin(employeesTable, eq(leaveRecordsTable.employeeId, employeesTable.id))
    .where(and(
      eq(leaveRecordsTable.tenantId, tenantId),
      lte(leaveRecordsTable.startDate, toStr),
      gte(leaveRecordsTable.endDate, fromStr),
    ))
    .orderBy(desc(leaveRecordsTable.startDate));
  res.json(rows);
});

// ── Fechamento mensal do banco de horas ─────────────────────────────────────

router.get("/rh-dp/closures", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const month = typeof req.query.month === "string" ? req.query.month : "";
  const conditions = [eq(timeBankClosuresTable.tenantId, tenantId)];
  if (/^\d{4}-\d{2}$/.test(month)) conditions.push(eq(timeBankClosuresTable.periodMonth, month));
  const rows = await db.select().from(timeBankClosuresTable)
    .where(and(...conditions))
    .orderBy(desc(timeBankClosuresTable.periodMonth), asc(timeBankClosuresTable.employeeName));
  res.json(rows);
});

router.post("/rh-dp/closures/run", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as { month?: string };
  const month = typeof b.month === "string" && /^\d{4}-\d{2}$/.test(b.month) ? b.month : previousMonthKey(new Date());
  // Só fecha mês já encerrado — nunca o mês corrente (ainda em andamento).
  if (month >= currentMonthKey(new Date())) {
    res.status(400).json({ error: "Só é possível fechar meses já encerrados" }); return;
  }
  const created = await generateClosuresForMonth(month, tenantId);
  res.json({ ok: true, month, created });
});

router.delete("/rh-dp/closures/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(timeBankClosuresTable).where(and(eq(timeBankClosuresTable.id, id), eq(timeBankClosuresTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
