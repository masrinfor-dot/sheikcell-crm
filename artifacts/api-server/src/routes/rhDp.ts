import { Router, type IRouter, type Request, type Response } from "express";
import {
  db, employeesTable, workShiftsTable, timeClockEntriesTable, timeBankAdjustmentsTable, leaveRecordsTable,
  timeBankClosuresTable, usersTable, storesTable, tenantsTable, vacationRequestsTable, timesheetSignaturesTable,
  holidaysTable,
} from "@workspace/db";
import { eq, and, desc, asc, gte, lte, inArray, sql } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant, tenantIdOf } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { computeTimeBank, nextPunchKind, dayKeySaoPaulo, employeeNeedsClockInToday, hasSuspiciousManualPattern } from "../lib/timeBank";
import { computeVacationDeadline } from "../lib/vacationDeadline";
import { checkFaceMatch } from "../lib/facialRecognition";
import { normalizePhone } from "../lib/phone";
import { generateClosuresForMonth, previousMonthKey, currentMonthKey } from "../lib/timeBankClosures";
import { MEDIA_DIR } from "../lib/whatsappInbound";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

const router: IRouter = Router();

const PUNCH_KINDS = ["in", "break_start", "break_end", "out"] as const;
type PunchKind = (typeof PUNCH_KINDS)[number];
export const CONTRACT_TYPES = ["clt", "pj", "estagio"] as const;
const LEAVE_KINDS = ["ferias", "atestado", "falta_justificada", "falta_injustificada", "outro"] as const;

// Aceita: "YYYY-MM-DD" (usa início/fim do dia), "YYYY-MM-DDTHH:MM:SS" sem
// offset (interpreta no fuso America/Sao_Paulo, igual ao resto do sistema —
// nunca como hora local do servidor, que normalmente roda em UTC), ou uma
// data ISO completa com offset/Z (respeita o instante exato informado).
// Antes, "from=2026-08-01" virava meia-noite UTC = 2026-07-31 21h em SP,
// cortando as 3 primeiras horas do dia do relatório/banco de horas.
function parseDateRange(req: Request, res: Response): { from: Date; to: Date } | null {
  const parseDate = (v: unknown, boundary: "start" | "end"): Date | null => {
    if (typeof v !== "string" || !v) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T${boundary === "start" ? "00:00:00" : "23:59:59"}-03:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) {
      const d = new Date(`${v}-03:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = parseDate(req.query.to, "end") ?? new Date();
  const from = parseDate(req.query.from, "start") ?? new Date(to.getTime() - 30 * 86_400_000);
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

export async function getEmployee(id: number, tenantId: number) {
  const [row] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, id), eq(employeesTable.tenantId, tenantId)));
  return row ?? null;
}

// Selfie tirada no navegador na batida de entrada obrigatória — mesmo padrão
// de saveTradeInPhoto em routes/tradeIn.ts (base64 -> arquivo em MEDIA_DIR,
// servido por GET /chat/media/:filename em chat.ts).
const PUNCH_PHOTO_MIMES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};
const MAX_PUNCH_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

// Distância em metros entre 2 coordenadas (fórmula de Haversine) — usada só
// pra sinalizar (nunca bloquear) a batida de entrada longe demais do
// geofence da loja (pedido 15/09, análise Tangerino "Local de Interesse").
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function savePunchPhoto(base64: string, rawMimetype: string): Promise<string> {
  const mimetype = rawMimetype.split(";")[0]!.trim().toLowerCase();
  const ext = PUNCH_PHOTO_MIMES[mimetype];
  if (!ext) throw new Error("Tipo de foto não suportado (use JPG, PNG, WEBP ou HEIC)");
  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength > MAX_PUNCH_PHOTO_BYTES) throw new Error("Foto muito grande (máximo 10 MB)");
  await mkdir(MEDIA_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(MEDIA_DIR, filename), buf);
  return `/api/chat/media/${filename}`;
}

// ── Ponto obrigatório: bloqueia o uso do sistema até bater a entrada ────────
// Mesmo padrão de enforceMandatoryChecklists/enforceMandatoryTrainings
// (checklists.ts/trainings.ts): cache curto por tenant:usuário, allowlist de
// rotas sempre liberadas, 423 pro resto. Só se aplica a quem tem employee
// vinculado com escala "fixed" prevendo expediente hoje — ver
// employeeNeedsClockInToday em lib/timeBank.ts.
// REATIVADO (16/09, junto com a rodada de conformidade CLT — calendário de
// feriados, tolerância de atraso, vencimento do banco de horas, alertas de
// hora extra >2h/dia, interjornada <11h, padrão suspeito de lançamento
// manual, e geofence por loja). Esteve `false` desde 09/09 enquanto os bugs
// do módulo de RH/Ponto eram corrigidos (ver histórico abaixo) — com o
// módulo revisado, testado e ampliado nesta rodada, a exigência de bater
// ponto volta a valer. Se precisar desligar de novo por algum bug, é só
// voltar pra `false`: nada mais nesta rodada depende deste flag.
export const CLOCK_IN_GATE_ENABLED = true;

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
  if (!CLOCK_IN_GATE_ENABLED) { next(); return; }
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
          ? (await db.select().from(workShiftsTable).where(and(eq(workShiftsTable.id, employee.shiftId), eq(workShiftsTable.tenantId, tenantId))))[0] ?? null
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
    ? (await db.select().from(workShiftsTable).where(and(eq(workShiftsTable.id, employee.shiftId), eq(workShiftsTable.tenantId, tenantId))))[0] ?? null
    : null;
  const hasBreak = !!(shift?.breakStart && shift?.breakEnd);

  const todayKey = dayKeySaoPaulo(new Date());
  const dayStart = new Date(`${todayKey}T00:00:00-03:00`);
  const dayEnd = new Date(`${todayKey}T23:59:59-03:00`);
  // Turno noturno cruzando a meia-noite: uma entrada batida ontem à noite
  // sem saída ainda não fechou o turno, mesmo que o "hoje" civil já tenha
  // virado — olha até 20h pra trás pra achar esse turno em aberto. Sem isso,
  // a consulta só de "hoje" não via a entrada de ontem e deixava o
  // colaborador bater "entrada" de novo em vez de intervalo/saída.
  const lookbackStart = new Date(dayStart.getTime() - 20 * 3600_000);
  const recentEntries = await db.select().from(timeClockEntriesTable)
    .where(and(
      eq(timeClockEntriesTable.employeeId, employee.id),
      eq(timeClockEntriesTable.tenantId, tenantId),
      gte(timeClockEntriesTable.at, lookbackStart),
      lte(timeClockEntriesTable.at, dayEnd),
    ))
    .orderBy(asc(timeClockEntriesTable.at));
  const todayEntries = recentEntries.filter((e) => dayKeySaoPaulo(e.at) === todayKey);
  const lastEntry = recentEntries[recentEntries.length - 1];
  // Se a última batida (mesmo de ontem) não foi "saída", o turno está aberto
  // cruzando a virada do dia — continua a partir dela. Senão (turno já
  // fechado ou sem nenhuma batida recente), considera só as batidas de hoje.
  const effectiveEntries = lastEntry && lastEntry.kind !== "out" && dayKeySaoPaulo(lastEntry.at) !== todayKey
    ? recentEntries
    : todayEntries;

  const kind = nextPunchKind(effectiveEntries, hasBreak);
  if (!kind) { res.status(409).json({ error: "Você já bateu todos os pontos de hoje." }); return; }

  // Batida de ENTRADA feita pelo próprio colaborador (é a que o PontoGate.tsx
  // exige logo ao abrir o sistema) precisa de geolocalização sempre, e de
  // foto — MAS a foto pode ser dispensada se o navegador genuinamente não
  // conseguir acessar a câmera (sem webcam no aparelho, permissão negada,
  // câmera em uso por outro programa etc. — ver use-punch-capture.ts): nesse
  // caso o cliente manda `noPhotoReason` em vez de `photoBase64`, a batida é
  // aceita sem foto mas marcada `flagged` pra revisão do admin (painel RH →
  // Ponto). Antes, sem essa via de escape, um colaborador cujo computador não
  // tinha câmera ficava PERMANENTEMENTE travado na tela de ponto obrigatório,
  // sem conseguir usar o sistema de jeito nenhum — pior que aceitar uma
  // batida sem foto e sinalizar pra revisão. Geolocalização continua sempre
  // obrigatória (não tem via de escape pra ela).
  let proofUrl: string | null = null;
  let lat: number | null = null;
  let lng: number | null = null;
  let accuracyMeters: number | null = null;
  let flagged = false;
  let flagReason: string | null = null;
  if (kind === "in") {
    const { photoBase64, mimetype, noPhotoReason } = req.body ?? {};
    const rawLat = req.body?.lat;
    const rawLng = req.body?.lng;
    const rawAccuracy = req.body?.accuracyMeters;
    const validLat = typeof rawLat === "number" && Number.isFinite(rawLat);
    const validLng = typeof rawLng === "number" && Number.isFinite(rawLng);
    if (!validLat || !validLng) {
      res.status(400).json({ error: "Localização é obrigatória para bater o ponto de entrada." });
      return;
    }
    const hasPhoto = typeof photoBase64 === "string" && !!photoBase64 && typeof mimetype === "string" && !!mimetype;
    const skipReason = typeof noPhotoReason === "string" ? noPhotoReason.trim().slice(0, 300) : "";
    if (!hasPhoto && !skipReason) {
      res.status(400).json({ error: "Foto (ou o motivo de não conseguir tirar) é obrigatória para bater o ponto de entrada." });
      return;
    }
    if (hasPhoto) {
      try {
        proofUrl = await savePunchPhoto(photoBase64, mimetype);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Não foi possível salvar a foto." });
        return;
      }
      // Reconhecimento facial (pedido 10/09, análise Tangerino) — opt-in por
      // loja, nunca bloqueia: só marca a batida pra revisão humana quando a
      // IA aponta rosto diferente da foto de referência. null = sem sinal
      // (feature desligada, sem foto de referência, ou a própria checagem
      // falhou) — nesse caso não marca nada.
      const faceCheck = await checkFaceMatch(employee.id, tenantId, photoBase64, mimetype);
      if (faceCheck && !faceCheck.match) {
        flagged = true;
        flagReason = `Reconhecimento facial: rosto pode não corresponder à foto de referência. ${faceCheck.reason}`.trim();
      }
    } else {
      flagged = true;
      flagReason = `Sem foto (câmera indisponível no aparelho do colaborador): ${skipReason}`;
    }
    lat = rawLat;
    lng = rawLng;
    accuracyMeters = typeof rawAccuracy === "number" && Number.isFinite(rawAccuracy) ? rawAccuracy : null;

    // Geofence da loja (pedido 15/09, análise Tangerino "Local de
    // Interesse") — SINALIZA (nunca bloqueia) quando a loja do colaborador
    // tem geofence configurado e a batida veio de fora do raio permitido.
    // Loja sem geofence configurado (qualquer um dos 3 campos nulo) não
    // sinaliza nada — comportamento de sempre.
    if (employee.storeId) {
      const [store] = await db.select({
        name: storesTable.name, geofenceLat: storesTable.geofenceLat,
        geofenceLng: storesTable.geofenceLng, geofenceRadiusMeters: storesTable.geofenceRadiusMeters,
      }).from(storesTable).where(and(eq(storesTable.id, employee.storeId), eq(storesTable.tenantId, tenantId)));
      if (store?.geofenceLat != null && store.geofenceLng != null && store.geofenceRadiusMeters != null) {
        const dist = distanceMeters(rawLat, rawLng, store.geofenceLat, store.geofenceLng);
        if (dist > store.geofenceRadiusMeters) {
          flagged = true;
          const geofenceReason = `Localização fora do raio permitido da loja "${store.name}" (${Math.round(dist)}m, limite ${store.geofenceRadiusMeters}m).`;
          flagReason = flagReason ? `${flagReason} ${geofenceReason}` : geofenceReason;
        }
      }
    }
  }

  const [created] = await db.insert(timeClockEntriesTable).values({
    tenantId, employeeId: employee.id, kind, source: "self", createdByUserId: req.session.userId,
    proofUrl, lat, lng, accuracyMeters, flagged, flagReason,
  }).returning();
  invalidateClockInBlock(req.session.userId!);
  res.status(201).json(created);
});

router.get("/rh-dp/me/clock-status", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  // Gate desligado temporariamente (ver CLOCK_IN_GATE_ENABLED acima) — não
  // mostra a tela cheia de bater ponto pra ninguém enquanto o RH está em reparo.
  if (!CLOCK_IN_GATE_ENABLED) { res.json({ needsClockIn: false }); return; }
  // Admin nunca é obrigado a bater ponto, mesmo com cadastro de RH vinculado.
  if (req.session.userRole === "admin") { res.json({ needsClockIn: false }); return; }
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.json({ needsClockIn: false }); return; }
  const shift = employee.shiftId
    ? (await db.select().from(workShiftsTable).where(and(eq(workShiftsTable.id, employee.shiftId), eq(workShiftsTable.tenantId, tenantId))))[0] ?? null
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

// ── Férias: auto-serviço (pedido 10/09, análise Tangerino) ─────────────────
// O colaborador vê o próprio vencimento (se tiver período aquisitivo
// completo em aberto) e o histórico dos seus pedidos; solicita novas férias
// aqui mesmo, sem precisar do RH lançar manualmente.

router.get("/rh-dp/me/vacation", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }
  let deadline = null;
  if (employee.admissionDate) {
    const taken = await db.select({ startDate: leaveRecordsTable.startDate }).from(leaveRecordsTable)
      .where(and(eq(leaveRecordsTable.employeeId, employee.id), eq(leaveRecordsTable.tenantId, tenantId), eq(leaveRecordsTable.kind, "ferias")));
    deadline = computeVacationDeadline(employee.admissionDate, taken.map((t) => t.startDate));
  }
  const requests = await db.select().from(vacationRequestsTable)
    .where(and(eq(vacationRequestsTable.employeeId, employee.id), eq(vacationRequestsTable.tenantId, tenantId)))
    .orderBy(desc(vacationRequestsTable.createdAt)).limit(50);
  res.json({ deadline, requests });
});

router.post("/rh-dp/me/vacation-requests", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }
  const b = (req.body ?? {}) as { startDate?: string; endDate?: string };
  const startDate = typeof b.startDate === "string" ? b.startDate : "";
  const endDate = typeof b.endDate === "string" ? b.endDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
    res.status(400).json({ error: "Informe um período de datas válido" }); return;
  }
  const daysCount = Math.round((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (daysCount < 1 || daysCount > 30) { res.status(400).json({ error: "O período de férias deve ter entre 1 e 30 dias" }); return; }
  const [created] = await db.insert(vacationRequestsTable).values({
    tenantId, employeeId: employee.id, startDate, endDate, daysCount,
    requestedByUserId: req.session.userId!,
  }).returning();
  res.status(201).json(created);
});

// ── Espelho de ponto: assinatura eletrônica (pedido 10/09, análise
// Tangerino) ────────────────────────────────────────────────────────────────
// "Assinatura simples" (clique de confirmação), conforme decidido — sem
// certificado digital nem desenho de assinatura. Só é possível assinar um
// mês que já foi fechado (time_bank_closures existe pra esse período):
// evita assinar números que ainda podem mudar.

router.get("/rh-dp/me/timesheet", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }
  const rows = await db.select({
    closureId: timeBankClosuresTable.id,
    periodMonth: timeBankClosuresTable.periodMonth,
    workedMinutes: timeBankClosuresTable.workedMinutes,
    expectedMinutes: timeBankClosuresTable.expectedMinutes,
    adjustmentMinutes: timeBankClosuresTable.adjustmentMinutes,
    balanceMinutes: timeBankClosuresTable.balanceMinutes,
    signedAt: timesheetSignaturesTable.signedAt,
  }).from(timeBankClosuresTable)
    .leftJoin(timesheetSignaturesTable, eq(timesheetSignaturesTable.closureId, timeBankClosuresTable.id))
    .where(and(eq(timeBankClosuresTable.employeeId, employee.id), eq(timeBankClosuresTable.tenantId, tenantId)))
    .orderBy(desc(timeBankClosuresTable.periodMonth));
  res.json(rows);
});

router.post("/rh-dp/me/timesheet-signatures", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employee = await getEmployeeForUser(req.session.userId!, tenantId);
  if (!employee) { res.status(404).json({ error: "Você não está vinculado a um cadastro de colaborador." }); return; }
  const b = (req.body ?? {}) as { periodMonth?: string };
  const periodMonth = typeof b.periodMonth === "string" ? b.periodMonth : "";
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) { res.status(400).json({ error: "Mês inválido" }); return; }
  const [closure] = await db.select().from(timeBankClosuresTable)
    .where(and(eq(timeBankClosuresTable.employeeId, employee.id), eq(timeBankClosuresTable.tenantId, tenantId), eq(timeBankClosuresTable.periodMonth, periodMonth)));
  if (!closure) { res.status(404).json({ error: "Este mês ainda não foi fechado pelo RH — aguarde o fechamento pra poder assinar." }); return; }
  const [existing] = await db.select({ id: timesheetSignaturesTable.id }).from(timesheetSignaturesTable)
    .where(and(eq(timesheetSignaturesTable.employeeId, employee.id), eq(timesheetSignaturesTable.periodMonth, periodMonth)));
  if (existing) { res.status(409).json({ error: "Você já assinou o espelho de ponto deste mês" }); return; }
  const [created] = await db.insert(timesheetSignaturesTable).values({
    tenantId, employeeId: employee.id, periodMonth, closureId: closure.id,
    workedMinutes: closure.workedMinutes, expectedMinutes: closure.expectedMinutes,
    adjustmentMinutes: closure.adjustmentMinutes, balanceMinutes: closure.balanceMinutes,
    signedByUserId: req.session.userId!,
  }).returning();
  res.status(201).json(created);
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
    candidateId: employeesTable.candidateId,
    hiringStatus: employeesTable.hiringStatus,
    documentsUploadToken: employeesTable.documentsUploadToken,
    address: employeesTable.address,
    addressNumber: employeesTable.addressNumber,
    neighborhood: employeesTable.neighborhood,
    city: employeesTable.city,
    state: employeesTable.state,
    zipCode: employeesTable.zipCode,
    maritalStatus: employeesTable.maritalStatus,
    educationLevel: employeesTable.educationLevel,
    experienceDays: employeesTable.experienceDays,
    createdAt: employeesTable.createdAt,
    userName: usersTable.name,
    storeName: storesTable.name,
    shiftName: workShiftsTable.name,
  }).from(employeesTable)
    .leftJoin(usersTable, eq(employeesTable.userId, usersTable.id))
    .leftJoin(storesTable, eq(employeesTable.storeId, storesTable.id))
    .leftJoin(workShiftsTable, and(eq(employeesTable.shiftId, workShiftsTable.id), eq(workShiftsTable.tenantId, tenantId)))
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
    // Bug de vazamento entre lojas (09/09): sem esta checagem, dava pra
    // vincular o colaborador a uma escala (work_shifts) de OUTRA loja — o
    // nome/horário/dias dessa escala de outra loja passavam a aparecer pra
    // esta loja em toda tela e cálculo que depende do turno do colaborador.
    const [shiftRow] = await db.select({ id: workShiftsTable.id }).from(workShiftsTable)
      .where(and(eq(workShiftsTable.id, shiftId), eq(workShiftsTable.tenantId, tenantId)));
    if (!shiftRow) { res.status(400).json({ error: "Escala não encontrada" }); return; }
  }

  const [created] = await db.insert(employeesTable).values({
    tenantId, userId, name,
    birthDate: typeof b.birthDate === "string" && b.birthDate ? b.birthDate : null,
    // Normalizado (mesma função usada em conversas/CRM) — é o que permite
    // casar o telefone que manda o check-in de ponto via WhatsApp com este
    // cadastro, sem depender de o admin digitar num formato específico.
    phone: typeof b.phone === "string" && b.phone.trim() ? normalizePhone(b.phone) || null : null,
    email: typeof b.email === "string" ? b.email.trim().slice(0, 120) || null : null,
    cpf: typeof b.cpf === "string" ? b.cpf.trim().slice(0, 20) || null : null,
    rg: typeof b.rg === "string" ? b.rg.trim().slice(0, 20) || null : null,
    role: typeof b.role === "string" ? b.role.trim().slice(0, 80) || null : null,
    jobFunction: typeof b.jobFunction === "string" ? b.jobFunction.trim().slice(0, 80) || null : null,
    admissionDate: typeof b.admissionDate === "string" && b.admissionDate ? b.admissionDate : null,
    contractType, salaryCents, storeId, shiftId,
    isActive: b.isActive !== false,
    address: typeof b.address === "string" ? b.address.trim().slice(0, 200) || null : null,
    addressNumber: typeof b.addressNumber === "string" ? b.addressNumber.trim().slice(0, 20) || null : null,
    neighborhood: typeof b.neighborhood === "string" ? b.neighborhood.trim().slice(0, 120) || null : null,
    city: typeof b.city === "string" ? b.city.trim().slice(0, 120) || null : null,
    state: typeof b.state === "string" ? b.state.trim().slice(0, 2).toUpperCase() || null : null,
    zipCode: typeof b.zipCode === "string" ? b.zipCode.trim().slice(0, 12) || null : null,
    maritalStatus: typeof b.maritalStatus === "string" ? b.maritalStatus.trim().slice(0, 40) || null : null,
    educationLevel: typeof b.educationLevel === "string" ? b.educationLevel.trim().slice(0, 80) || null : null,
    experienceDays: typeof b.experienceDays === "number" && Number.isFinite(b.experienceDays) && b.experienceDays >= 0 ? Math.round(b.experienceDays) : null,
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
  if ("phone" in b) update.phone = typeof b.phone === "string" && b.phone.trim() ? normalizePhone(b.phone) || null : null;
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
  if ("address" in b) update.address = typeof b.address === "string" ? b.address.trim().slice(0, 200) || null : null;
  if ("addressNumber" in b) update.addressNumber = typeof b.addressNumber === "string" ? b.addressNumber.trim().slice(0, 20) || null : null;
  if ("neighborhood" in b) update.neighborhood = typeof b.neighborhood === "string" ? b.neighborhood.trim().slice(0, 120) || null : null;
  if ("city" in b) update.city = typeof b.city === "string" ? b.city.trim().slice(0, 120) || null : null;
  if ("state" in b) update.state = typeof b.state === "string" ? b.state.trim().slice(0, 2).toUpperCase() || null : null;
  if ("zipCode" in b) update.zipCode = typeof b.zipCode === "string" ? b.zipCode.trim().slice(0, 12) || null : null;
  if ("maritalStatus" in b) update.maritalStatus = typeof b.maritalStatus === "string" ? b.maritalStatus.trim().slice(0, 40) || null : null;
  if ("educationLevel" in b) update.educationLevel = typeof b.educationLevel === "string" ? b.educationLevel.trim().slice(0, 80) || null : null;
  if ("experienceDays" in b) {
    update.experienceDays = typeof b.experienceDays === "number" && Number.isFinite(b.experienceDays) && b.experienceDays >= 0 ? Math.round(b.experienceDays) : null;
  }
  if ("storeId" in b) {
    const sid = b.storeId == null ? null : parseInt(String(b.storeId), 10);
    if (sid != null && isNaN(sid)) { res.status(400).json({ error: "Loja inválida" }); return; }
    update.storeId = sid;
  }
  if ("shiftId" in b) {
    const sid = b.shiftId == null ? null : parseInt(String(b.shiftId), 10);
    if (sid != null && isNaN(sid)) { res.status(400).json({ error: "Escala inválida" }); return; }
    // Mesma checagem do POST acima: escala precisa ser desta loja.
    if (sid != null) {
      const [shiftRow] = await db.select({ id: workShiftsTable.id }).from(workShiftsTable)
        .where(and(eq(workShiftsTable.id, sid), eq(workShiftsTable.tenantId, tenantId)));
      if (!shiftRow) { res.status(400).json({ error: "Escala não encontrada" }); return; }
    }
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

// ── Configuração: linha oficial de check-in de ponto por WhatsApp ──────────
// Uma linha por tenant (não por loja) — mensagem com foto recebida nela é
// tratada como tentativa de check-in (ver tryConsumePontoCheckIn em
// lib/whatsappInbound.ts). Null = feature desligada (padrão).

router.get("/rh-dp/settings", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [row] = await db.select({
    pontoCheckInSessionKey: tenantsTable.pontoCheckInSessionKey,
    facialRecognitionEnabled: tenantsTable.facialRecognitionEnabled,
    companyMission: tenantsTable.companyMission,
    companyVision: tenantsTable.companyVision,
    companyValues: tenantsTable.companyValues,
    timeBankValidityMonths: tenantsTable.timeBankValidityMonths,
  }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  res.json({
    pontoCheckInSessionKey: row?.pontoCheckInSessionKey ?? null,
    facialRecognitionEnabled: row?.facialRecognitionEnabled ?? false,
    companyMission: row?.companyMission ?? null,
    companyVision: row?.companyVision ?? null,
    companyValues: row?.companyValues ?? null,
    timeBankValidityMonths: row?.timeBankValidityMonths ?? null,
  });
});

router.patch("/rh-dp/settings", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as {
    pontoCheckInSessionKey?: string | null; facialRecognitionEnabled?: boolean;
    companyMission?: string | null; companyVision?: string | null; companyValues?: string | null;
    timeBankValidityMonths?: number | null;
  };
  const update: Record<string, unknown> = {};
  if ("pontoCheckInSessionKey" in b) {
    update.pontoCheckInSessionKey = typeof b.pontoCheckInSessionKey === "string" && b.pontoCheckInSessionKey.trim()
      ? b.pontoCheckInSessionKey.trim() : null;
  }
  if ("facialRecognitionEnabled" in b) update.facialRecognitionEnabled = b.facialRecognitionEnabled === true;
  if ("companyMission" in b) update.companyMission = typeof b.companyMission === "string" ? b.companyMission.trim().slice(0, 4000) || null : null;
  if ("companyVision" in b) update.companyVision = typeof b.companyVision === "string" ? b.companyVision.trim().slice(0, 4000) || null : null;
  if ("companyValues" in b) update.companyValues = typeof b.companyValues === "string" ? b.companyValues.trim().slice(0, 4000) || null : null;
  // Vencimento do banco de horas (meses) — null/0 = sem vencimento.
  if ("timeBankValidityMonths" in b) {
    const v = b.timeBankValidityMonths;
    update.timeBankValidityMonths = typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(Math.min(60, v)) : null;
  }
  const [updated] = await db.update(tenantsTable).set(update)
    .where(eq(tenantsTable.id, tenantId))
    .returning({
      pontoCheckInSessionKey: tenantsTable.pontoCheckInSessionKey, facialRecognitionEnabled: tenantsTable.facialRecognitionEnabled,
      companyMission: tenantsTable.companyMission, companyVision: tenantsTable.companyVision, companyValues: tenantsTable.companyValues,
      timeBankValidityMonths: tenantsTable.timeBankValidityMonths,
    });
  res.json(updated);
});

// ── Escalas ───────────────────────────────────────────────────────────────

router.get("/rh-dp/shifts", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(workShiftsTable).where(eq(workShiftsTable.tenantId, tenantId)).orderBy(asc(workShiftsTable.name));
  res.json(rows);
});

// Antes, endTime <= startTime era rejeitado como "escala inconsistente" —
// impedia cadastrar qualquer escala noturna (ex.: 22:00-06:00). Agora trata
// esse caso como turno cruzando a meia-noite: a duração é o que falta até
// 24:00 mais o que já passou desde 00:00. O intervalo (breakStart/breakEnd),
// quando informado, é entendido como dentro da MESMA noite: se breakEnd for
// "menor" que breakStart, ele também cruzou a meia-noite.
function computeExpectedMinutes(startTime: number, endTime: number, breakStart: number | null, breakEnd: number | null): number | null {
  const overnight = endTime <= startTime;
  const shiftEnd = overnight ? endTime + 1440 : endTime;
  let total = shiftEnd - startTime;
  if (total <= 0) return null;
  if (breakStart != null && breakEnd != null) {
    const breakEndAdj = breakEnd <= breakStart ? breakEnd + 1440 : breakEnd;
    if (breakEndAdj <= breakStart || breakStart < startTime || breakEndAdj > shiftEnd) return null;
    total -= breakEndAdj - breakStart;
  }
  return total;
}

// Tolerância de atraso (minutos) — clamp 0-120 (sem limite não faz sentido,
// 120min de tolerância já é generoso demais pra ser um valor real).
function parseTolerance(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(120, Math.round(v)));
}

router.post("/rh-dp/shifts", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
  if (!name) { res.status(400).json({ error: "Informe o nome da escala" }); return; }
  const type = b.type === "flexible" ? "flexible" : "fixed";
  const weekdays = Array.isArray(b.weekdays) ? b.weekdays.filter((n): n is number => typeof n === "number" && n >= 0 && n <= 6) : [1, 2, 3, 4, 5];
  const toleranceMinutes = parseTolerance(b.toleranceMinutes, 10);

  // Escala livre: sem horário, sem expediente esperado — não exige ponto e
  // não entra no cálculo de "esperado" do banco de horas.
  if (type === "flexible") {
    const [created] = await db.insert(workShiftsTable).values({
      tenantId, name, type, weekdays, toleranceMinutes,
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
    weekdays, expectedMinutesPerDay, toleranceMinutes,
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
  const toleranceMinutes = "toleranceMinutes" in b ? parseTolerance(b.toleranceMinutes, existing.toleranceMinutes) : existing.toleranceMinutes;
  if (!name) { res.status(400).json({ error: "Dados da escala inválidos" }); return; }

  if (type === "flexible") {
    const [updated] = await db.update(workShiftsTable).set({
      name, type, weekdays, toleranceMinutes,
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
    weekdays, expectedMinutesPerDay, toleranceMinutes,
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

// ── Calendário de feriados (pedido 15/09, análise Tangerino) ───────────────

router.get("/rh-dp/holidays", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const yearRaw = req.query.year;
  const conditions = [eq(holidaysTable.tenantId, tenantId)];
  if (typeof yearRaw === "string" && /^\d{4}$/.test(yearRaw)) {
    conditions.push(gte(holidaysTable.date, `${yearRaw}-01-01`), lte(holidaysTable.date, `${yearRaw}-12-31`));
  }
  const rows = await db.select().from(holidaysTable).where(and(...conditions)).orderBy(asc(holidaysTable.date));
  res.json(rows);
});

router.post("/rh-dp/holidays", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as { date?: unknown; name?: unknown; excusesExpected?: unknown };
  const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  if (!date || !name) { res.status(400).json({ error: "Informe data e nome do feriado" }); return; }
  const excusesExpected = b.excusesExpected !== false;
  try {
    const [created] = await db.insert(holidaysTable).values({ tenantId, date, name, excusesExpected }).returning();
    res.status(201).json(created);
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") { res.status(409).json({ error: "Já existe um feriado cadastrado nessa data" }); return; }
    throw err;
  }
});

router.patch("/rh-dp/holidays/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const b = (req.body ?? {}) as { date?: unknown; name?: unknown; excusesExpected?: unknown };
  const update: Record<string, unknown> = {};
  if (typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) update.date = b.date;
  if (typeof b.name === "string" && b.name.trim()) update.name = b.name.trim().slice(0, 120);
  if (typeof b.excusesExpected === "boolean") update.excusesExpected = b.excusesExpected;
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  try {
    const [updated] = await db.update(holidaysTable).set(update)
      .where(and(eq(holidaysTable.id, id), eq(holidaysTable.tenantId, tenantId))).returning();
    if (!updated) { res.status(404).json({ error: "Feriado não encontrado" }); return; }
    res.json(updated);
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") { res.status(409).json({ error: "Já existe um feriado cadastrado nessa data" }); return; }
    throw err;
  }
});

router.delete("/rh-dp/holidays/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(holidaysTable).where(and(eq(holidaysTable.id, id), eq(holidaysTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// Domingo de Páscoa do ano (algoritmo de Gauss/anônimo gregoriano) — base
// pra derivar os feriados móveis (Carnaval, Sexta-feira Santa, Corpus Christi).
function easterDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// Carrega o calendário nacional padrão de um ano de uma vez (pedido 15/09,
// análise Tangerino "Calendário de Feriados" — lá já vem pré-cadastrado por
// ano). Feriados fixos nacionais (Lei 662/1949, Lei 6.802/1980, Lei
// 14.759/2023) entram como excusesExpected=true; Carnaval e Corpus Christi
// são "ponto facultativo" (não são feriado nacional decretado, variam por
// convenção/decreto local) e entram como excusesExpected=false — o admin
// pode marcar como isento manualmente se a loja realmente fechar nesses dias.
// Idempotente (onConflictDoNothing): rodar de novo não duplica nem sobrescreve
// datas que o admin já editou manualmente.
router.post("/rh-dp/holidays/seed-default", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const yearRaw = (req.body ?? {}).year;
  const year = typeof yearRaw === "number" && Number.isInteger(yearRaw) ? yearRaw : new Date().getFullYear();
  if (year < 2000 || year > 2100) { res.status(400).json({ error: "Ano inválido" }); return; }
  const easter = easterDate(year);
  const addDays = (n: number) => new Date(easter.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const items: { date: string; name: string; excusesExpected: boolean }[] = [
    { date: `${year}-01-01`, name: "Confraternização Universal", excusesExpected: true },
    { date: addDays(-48), name: "Carnaval (segunda-feira)", excusesExpected: false },
    { date: addDays(-47), name: "Carnaval (terça-feira)", excusesExpected: false },
    { date: addDays(-2), name: "Sexta-feira Santa", excusesExpected: true },
    { date: `${year}-04-21`, name: "Tiradentes", excusesExpected: true },
    { date: `${year}-05-01`, name: "Dia do Trabalho", excusesExpected: true },
    { date: addDays(60), name: "Corpus Christi", excusesExpected: false },
    { date: `${year}-09-07`, name: "Independência do Brasil", excusesExpected: true },
    { date: `${year}-10-12`, name: "Nossa Senhora Aparecida", excusesExpected: true },
    { date: `${year}-11-02`, name: "Finados", excusesExpected: true },
    { date: `${year}-11-15`, name: "Proclamação da República", excusesExpected: true },
    { date: `${year}-11-20`, name: "Consciência Negra", excusesExpected: true },
    { date: `${year}-12-25`, name: "Natal", excusesExpected: true },
  ];
  let inserted = 0;
  for (const item of items) {
    const result = await db.insert(holidaysTable).values({ tenantId, ...item }).onConflictDoNothing().returning({ id: holidaysTable.id });
    if (result.length > 0) inserted++;
  }
  res.json({ ok: true, inserted, total: items.length });
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

// Admin conferiu uma batida sinalizada (duas fotos em pouco tempo, ver
// tryConsumePontoCheckIn) e decidiu manter como está — some da lista de
// pendências sem apagar/alterar o horário registrado.
router.post("/rh-dp/time-clock-entries/:id/review", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [updated] = await db.update(timeClockEntriesTable).set({ flagged: false, flagReason: null })
    .where(and(eq(timeClockEntriesTable.id, id), eq(timeClockEntriesTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Batida não encontrada" }); return; }
  res.json(updated);
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

// ── Férias: vencimento (dashboard) + aprovação de pedidos ──────────────────

// Lista, pra cada colaborador ativo com admissão cadastrada, o período
// aquisitivo em aberto (se houver) — mesmo cálculo do auto-serviço, só que
// pra todo mundo de uma vez. Sempre recalculado (sem tabela/cron): é rápido
// (poucas centenas de colaboradores no máximo) e nunca fica desatualizado.
router.get("/rh-dp/vacation-deadlines", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employees = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.isActive, true)));
  const takenByEmployee = new Map<number, string[]>();
  const taken = await db.select({ employeeId: leaveRecordsTable.employeeId, startDate: leaveRecordsTable.startDate }).from(leaveRecordsTable)
    .where(and(eq(leaveRecordsTable.tenantId, tenantId), eq(leaveRecordsTable.kind, "ferias")));
  for (const t of taken) takenByEmployee.set(t.employeeId, [...(takenByEmployee.get(t.employeeId) ?? []), t.startDate]);
  const rows = employees
    .filter((e) => !!e.admissionDate)
    .map((e) => ({
      employeeId: e.id,
      employeeName: e.name,
      deadline: computeVacationDeadline(e.admissionDate!, takenByEmployee.get(e.id) ?? []),
    }))
    .filter((r) => r.deadline != null)
    .sort((a, b) => a.deadline!.daysUntilDue - b.deadline!.daysUntilDue);
  res.json(rows);
});

router.get("/rh-dp/vacation-requests", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select({
    id: vacationRequestsTable.id,
    employeeId: vacationRequestsTable.employeeId,
    employeeName: employeesTable.name,
    startDate: vacationRequestsTable.startDate,
    endDate: vacationRequestsTable.endDate,
    daysCount: vacationRequestsTable.daysCount,
    status: vacationRequestsTable.status,
    reviewedByUserId: vacationRequestsTable.reviewedByUserId,
    reviewedAt: vacationRequestsTable.reviewedAt,
    reviewNote: vacationRequestsTable.reviewNote,
    createdAt: vacationRequestsTable.createdAt,
  }).from(vacationRequestsTable)
    .leftJoin(employeesTable, eq(vacationRequestsTable.employeeId, employeesTable.id))
    .where(eq(vacationRequestsTable.tenantId, tenantId))
    .orderBy(desc(vacationRequestsTable.createdAt)).limit(300);
  res.json(rows);
});

router.patch("/rh-dp/vacation-requests/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [request] = await db.select().from(vacationRequestsTable)
    .where(and(eq(vacationRequestsTable.id, id), eq(vacationRequestsTable.tenantId, tenantId)));
  if (!request) { res.status(404).json({ error: "Pedido não encontrado" }); return; }
  if (request.status !== "pendente") { res.status(409).json({ error: "Este pedido já foi analisado" }); return; }
  const b = (req.body ?? {}) as { action?: string; reviewNote?: string };
  const reviewNote = typeof b.reviewNote === "string" ? b.reviewNote.trim().slice(0, 1000) || null : null;
  if (b.action === "aprovar") {
    const [leave] = await db.insert(leaveRecordsTable).values({
      tenantId, employeeId: request.employeeId, kind: "ferias",
      startDate: request.startDate, endDate: request.endDate,
      notes: reviewNote ? `Aprovado via pedido de férias: ${reviewNote}` : "Aprovado via pedido de férias do colaborador",
      createdByUserId: req.session.userId!,
    }).returning();
    const [updated] = await db.update(vacationRequestsTable).set({
      status: "aprovado", reviewedByUserId: req.session.userId!, reviewedAt: new Date(), reviewNote, leaveRecordId: leave!.id,
    }).where(eq(vacationRequestsTable.id, id)).returning();
    res.json(updated);
  } else if (b.action === "rejeitar") {
    const [updated] = await db.update(vacationRequestsTable).set({
      status: "rejeitado", reviewedByUserId: req.session.userId!, reviewedAt: new Date(), reviewNote,
    }).where(eq(vacationRequestsTable.id, id)).returning();
    res.json(updated);
  } else {
    res.status(400).json({ error: "Ação inválida (use aprovar ou rejeitar)" });
  }
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
    proofUrl: timeClockEntriesTable.proofUrl,
    flagged: timeClockEntriesTable.flagged,
    flagReason: timeClockEntriesTable.flagReason,
  }).from(timeClockEntriesTable)
    .leftJoin(employeesTable, eq(timeClockEntriesTable.employeeId, employeesTable.id))
    .where(and(...conditions))
    .orderBy(desc(timeClockEntriesTable.at)).limit(2000);
  res.json(rows);
});

// Painel DP (pedido 15/09, comparativo com a Visão Geral do Tangerino): 4
// indicadores reais do dia/mês corrente pra abrir Departamento Pessoal já
// mostrando o que precisa de atenção, sem precisar entrar em cada aba.
// Cada número aqui já existe em algum lugar do sistema (ponto, afastamentos,
// férias, banco de horas) — este endpoint só agrega, não cria dado novo.
router.get("/rh-dp/dashboard-summary", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;

  const todaySP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const startOfDay = new Date(`${todaySP}T00:00:00-03:00`);
  const endOfDay = new Date(`${todaySP}T23:59:59-03:00`);

  const employees = await db.select({ id: employeesTable.id, shiftType: workShiftsTable.type })
    .from(employeesTable)
    .leftJoin(workShiftsTable, eq(employeesTable.shiftId, workShiftsTable.id))
    .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.isActive, true)));
  const activeEmployeeIds = employees.map((e) => e.id);

  // Sem presença hoje: colaborador ativo sem nenhuma batida "in" hoje.
  let noPresenceToday = 0;
  if (activeEmployeeIds.length > 0) {
    const presentRows = await db.select({ employeeId: timeClockEntriesTable.employeeId })
      .from(timeClockEntriesTable)
      .where(and(
        eq(timeClockEntriesTable.tenantId, tenantId),
        eq(timeClockEntriesTable.kind, "in"),
        gte(timeClockEntriesTable.at, startOfDay),
        lte(timeClockEntriesTable.at, endOfDay),
        inArray(timeClockEntriesTable.employeeId, activeEmployeeIds),
      ));
    const presentSet = new Set(presentRows.map((r) => r.employeeId));
    noPresenceToday = activeEmployeeIds.filter((id) => !presentSet.has(id)).length;
  }

  // Atestados e afastamentos: pedidos de férias pendentes de aprovação
  // (único fluxo com status real) + atestados/faltas lançados nos últimos 7
  // dias (leave_records não tem status — é lançamento direto, então "recente"
  // é a aproximação de "precisa de atenção/conferência").
  const [pendingVacationRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(vacationRequestsTable)
    .where(and(eq(vacationRequestsTable.tenantId, tenantId), eq(vacationRequestsTable.status, "pendente")));
  const sevenDaysAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [recentLeavesRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(leaveRecordsTable)
    .where(and(
      eq(leaveRecordsTable.tenantId, tenantId),
      inArray(leaveRecordsTable.kind, ["atestado", "falta_justificada", "falta_injustificada"]),
      gte(leaveRecordsTable.startDate, sevenDaysAgoStr),
    ));

  // Inconsistências: pontos sinalizados pra revisão humana (foto/facial não
  // bateu, ou duas fotos em pouco tempo) — ver flagged em time_clock_entries.
  const [flaggedRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(timeClockEntriesTable)
    .where(and(eq(timeClockEntriesTable.tenantId, tenantId), eq(timeClockEntriesTable.flagged, true)));

  // Horas excedentes: só colaboradores em escala "flexible" (banco de horas
  // só soma o trabalhado, nunca desconta esperado) com saldo positivo no mês
  // corrente — mesmo cálculo de /rh-dp/reports/time-bank-summary, só que
  // filtrado a quem realmente pode ter "excedente" nesse sentido.
  const monthStart = new Date(`${todaySP.slice(0, 7)}-01T00:00:00-03:00`);
  // Calcula o banco de horas do mês corrente de TODO mundo de uma vez (antes
  // só calculava pra escala flexible) — reaproveitado tanto pra "horas
  // excedentes" quanto pros novos alertas de conformidade abaixo.
  const allResults = await Promise.all(employees.map(async (e) => ({
    id: e.id, shiftType: e.shiftType, result: await computeTimeBank(e.id, tenantId, monthStart, endOfDay),
  })));
  const flexibleResults = allResults.filter((r) => r.shiftType === "flexible");
  const overtimeEmployeesCount = flexibleResults.filter((r) => r.result.balanceMinutes > 0).length;
  const overtimeMinutesTotal = flexibleResults.reduce((sum, r) => sum + Math.max(0, r.result.balanceMinutes), 0);

  // Alertas de conformidade CLT (pedido 15/09, análise Tangerino "Controle de
  // Inconsistências") — quantos colaboradores tiveram pelo menos 1 dia
  // sinalizado no mês corrente, em cada tipo. Só informativo (ver
  // computeTimeBank em lib/timeBank.ts — nunca altera o saldo calculado).
  let overtimeAbove2hEmployees = 0;
  let restBelow11hEmployees = 0;
  for (const r of allResults) {
    if (r.result.days.some((d) => d.inconsistencies.includes("excesso_2h_diarias"))) overtimeAbove2hEmployees++;
    if (r.result.days.some((d) => d.inconsistencies.includes("interjornada_curta"))) restBelow11hEmployees++;
  }
  const suspiciousFlags = await Promise.all(employees.map((e) => hasSuspiciousManualPattern(e.id, tenantId, monthStart, endOfDay)));
  const suspiciousManualPatternEmployees = suspiciousFlags.filter(Boolean).length;

  // Banco de horas vencido (pedido 15/09) — meses já fechados com saldo
  // positivo mais velhos que o vencimento configurado da loja
  // (tenants.timeBankValidityMonths). Só ALERTA — não zera/desconta nada
  // automaticamente (não temos rotina de pagamento de horas extras pra fazer
  // esse acerto com segurança); o RH decide manualmente (compensar ou pagar).
  let timeBankExpiredEmployees = 0;
  let timeBankExpiredMinutesTotal = 0;
  const [tenantRow] = await db.select({ timeBankValidityMonths: tenantsTable.timeBankValidityMonths }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (tenantRow?.timeBankValidityMonths) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - tenantRow.timeBankValidityMonths);
    const expiredClosures = await db.select({ employeeId: timeBankClosuresTable.employeeId, balanceMinutes: timeBankClosuresTable.balanceMinutes })
      .from(timeBankClosuresTable)
      .where(and(eq(timeBankClosuresTable.tenantId, tenantId), sql`${timeBankClosuresTable.balanceMinutes} > 0`, lte(timeBankClosuresTable.closedAt, cutoff)));
    const byEmployee = new Map<number, number>();
    for (const c of expiredClosures) byEmployee.set(c.employeeId, (byEmployee.get(c.employeeId) ?? 0) + c.balanceMinutes);
    timeBankExpiredEmployees = byEmployee.size;
    timeBankExpiredMinutesTotal = [...byEmployee.values()].reduce((s, v) => s + v, 0);
  }

  res.json({
    activeEmployees: activeEmployeeIds.length,
    noPresenceToday,
    pendingVacationRequests: Number(pendingVacationRow?.count ?? 0),
    recentLeaveRecords: Number(recentLeavesRow?.count ?? 0),
    flaggedPunches: Number(flaggedRow?.count ?? 0),
    overtimeEmployeesCount,
    overtimeMinutesTotal,
    clockAlerts: {
      overtimeAbove2hEmployees,
      restBelow11hEmployees,
      suspiciousManualPatternEmployees,
      timeBankExpiredEmployees,
      timeBankExpiredMinutesTotal,
    },
  });
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
  const rows = await db.select({
    id: timeBankClosuresTable.id,
    employeeId: timeBankClosuresTable.employeeId,
    employeeName: timeBankClosuresTable.employeeName,
    periodMonth: timeBankClosuresTable.periodMonth,
    workedMinutes: timeBankClosuresTable.workedMinutes,
    expectedMinutes: timeBankClosuresTable.expectedMinutes,
    adjustmentMinutes: timeBankClosuresTable.adjustmentMinutes,
    balanceMinutes: timeBankClosuresTable.balanceMinutes,
    closedAt: timeBankClosuresTable.closedAt,
    // Assinatura eletrônica do espelho de ponto (pedido 10/09) — null = o
    // colaborador ainda não confirmou este mês.
    signedAt: timesheetSignaturesTable.signedAt,
  }).from(timeBankClosuresTable)
    .leftJoin(timesheetSignaturesTable, eq(timesheetSignaturesTable.closureId, timeBankClosuresTable.id))
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
