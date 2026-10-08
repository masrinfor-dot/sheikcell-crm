import { and, asc, eq, gt } from "drizzle-orm";
import {
  db,
  employeesTable,
  employeeContractTemplatesTable,
  holidaysTable,
  leaveRecordsTable,
  rhCandidatesTable,
  rhPositionsTable,
  rhSettingsTable,
  tenantErpIntegrationsTable,
  tenantsTable,
  terminationProcessesTable,
  timeBankAdjustmentsTable,
  timesheetSignaturesTable,
  vacationRequestsTable,
  workShiftsTable,
} from "@workspace/db";
import { post } from "./erpHrSync";
import { logger } from "./logger";

// RH mudou para o ERP (07/10/2026 — parte 5: "tem que puxar tudo"): manda o
// histórico inteiro do RH daqui para o ERP Prumo, um tipo por vez, em lotes,
// com cursor por tipo (último id enviado). O ERP atualiza pelo id do CRM, então
// repetir é seguro. Quando todos terminam, marca hr_history_done_at.

type Row = typeof tenantErpIntegrationsTable.$inferSelect;
const BATCH = 200;
const VIDEOS_PER_TICK = 3;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function saveCursor(tenantId: number, cursors: Record<string, number>) {
  await db.update(tenantErpIntegrationsTable).set({ hrHistoryCursors: cursors })
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
}

/** Uma etapa do histórico: lê linhas com id > cursor e manda ao ERP. Devolve true quando acabou. */
async function step<T extends { id: number }>(
  row: Row, apiKey: string, cursors: Record<string, number>, kind: string,
  load: (after: number) => Promise<T[]>, map: (r: T) => Record<string, unknown>,
): Promise<boolean> {
  const after = cursors[kind] ?? 0;
  if (after < 0) return true; // já terminou
  const rows = await load(after);
  if (rows.length) {
    await post(row.baseUrl, apiKey, "/integrations/hr/import", { kind, items: rows.map(map) });
    cursors[kind] = rows[rows.length - 1]!.id;
  }
  if (rows.length < BATCH) cursors[kind] = -1;
  await saveCursor(row.tenantId, cursors);
  return cursors[kind] === -1;
}

export async function sendHistory(row: Row, apiKey: string): Promise<void> {
  const t = row.tenantId;
  const cursors: Record<string, number> = { ...(row.hrHistoryCursors ?? {}) };

  // 1) Configurações: link do candidato (mesmo token), processo padrão e propósito.
  if ((cursors.settings ?? 0) >= 0) {
    const [s] = await db.select().from(rhSettingsTable).where(eq(rhSettingsTable.tenantId, t)).limit(1);
    const [tenant] = await db.select({ m: tenantsTable.companyMission, v: tenantsTable.companyVision, va: tenantsTable.companyValues })
      .from(tenantsTable).where(eq(tenantsTable.id, t));
    if (s || tenant) {
      await post(row.baseUrl, apiKey, "/integrations/hr/import", {
        kind: "settings",
        items: [{ publicToken: s?.publicToken, stages: s?.stages, companyMission: tenant?.m, companyVision: tenant?.v, companyValues: tenant?.va }],
      });
    }
    cursors.settings = -1;
    await saveCursor(t, cursors);
  }

  // Ordem importa: vagas antes de candidatos; escalas antes dos dados da ficha.
  const plan: (() => Promise<boolean>)[] = [
    () => step(row, apiKey, cursors, "positions",
      (after) => db.select().from(rhPositionsTable).where(and(eq(rhPositionsTable.tenantId, t), gt(rhPositionsTable.id, after))).orderBy(asc(rhPositionsTable.id)).limit(BATCH),
      (p) => ({ crmId: String(p.id), name: p.name, active: p.active, sortOrder: p.sortOrder, stages: p.stages })),
    () => step(row, apiKey, cursors, "candidates",
      (after) => db.select({
        id: rhCandidatesTable.id, name: rhCandidatesTable.name, phone: rhCandidatesTable.phone, email: rhCandidatesTable.email,
        city: rhCandidatesTable.city, neighborhood: rhCandidatesTable.neighborhood, cpf: rhCandidatesTable.cpf,
        positionId: rhCandidatesTable.positionId, positionName: rhCandidatesTable.positionName, status: rhCandidatesTable.status,
        statusReason: rhCandidatesTable.statusReason, answers: rhCandidatesTable.answers, interviewNotes: rhCandidatesTable.interviewNotes,
        storeTestChecklist: rhCandidatesTable.storeTestChecklist, storeTestNotes: rhCandidatesTable.storeTestNotes,
        storeTestAt: rhCandidatesTable.storeTestAt, storeTestEvaluatorName: rhCandidatesTable.storeTestEvaluatorName,
        stagesSnapshot: rhCandidatesTable.stagesSnapshot, notes: rhCandidatesTable.notes, profileResult: rhCandidatesTable.profileResult,
        profileScores: rhCandidatesTable.profileScores, createdAt: rhCandidatesTable.createdAt,
      }).from(rhCandidatesTable).where(and(eq(rhCandidatesTable.tenantId, t), gt(rhCandidatesTable.id, after))).orderBy(asc(rhCandidatesTable.id)).limit(BATCH),
      (c) => ({ ...c, crmId: String(c.id), crmPositionId: c.positionId != null ? String(c.positionId) : null, storeTestAt: iso(c.storeTestAt), createdAt: iso(c.createdAt) })),
    async () => {
      // Vídeos dos candidatos: um por chamada (são grandes).
      const after = cursors.candidate_video ?? 0;
      if (after < 0) return true;
      const rows = await db.select({ id: rhCandidatesTable.id, videoData: rhCandidatesTable.videoData })
        .from(rhCandidatesTable).where(and(eq(rhCandidatesTable.tenantId, t), gt(rhCandidatesTable.id, after)))
        .orderBy(asc(rhCandidatesTable.id)).limit(20);
      let sent = 0;
      for (const r of rows) {
        if (r.videoData) {
          if (sent >= VIDEOS_PER_TICK) break;
          try {
            await post(row.baseUrl, apiKey, "/integrations/hr/import", { kind: "candidate_video", items: [{ crmCandidateId: String(r.id), dataBase64: r.videoData }] });
          } catch (err) {
            if (String(err).includes("ERP respondeu 5")) throw err;
            logger.warn({ err, candidateId: r.id }, "ERP RH: vídeo do candidato não foi");
          }
          sent++;
        }
        cursors.candidate_video = r.id;
      }
      if (rows.length < 20 && (rows.length === 0 || cursors.candidate_video === rows[rows.length - 1]!.id)) cursors.candidate_video = -1;
      await saveCursor(t, cursors);
      return cursors.candidate_video === -1;
    },
    () => step(row, apiKey, cursors, "shifts",
      (after) => db.select().from(workShiftsTable).where(and(eq(workShiftsTable.tenantId, t), gt(workShiftsTable.id, after))).orderBy(asc(workShiftsTable.id)).limit(BATCH),
      (s) => ({ crmId: String(s.id), name: s.name, type: s.type, startTime: s.startTime, endTime: s.endTime, breakStart: s.breakStart, breakEnd: s.breakEnd, weekdays: s.weekdays, expectedMinutesPerDay: s.expectedMinutesPerDay, toleranceMinutes: s.toleranceMinutes })),
    () => step(row, apiKey, cursors, "employee_details",
      (after) => db.select().from(employeesTable).where(and(eq(employeesTable.tenantId, t), gt(employeesTable.id, after))).orderBy(asc(employeesTable.id)).limit(BATCH),
      (e) => ({
        crmEmployeeId: String(e.id), rg: e.rg, birthDate: e.birthDate, address: e.address, addressNumber: e.addressNumber,
        neighborhood: e.neighborhood, city: e.city, state: e.state, zipCode: e.zipCode, maritalStatus: e.maritalStatus,
        educationLevel: e.educationLevel, experienceDays: e.experienceDays, hiringStatus: e.hiringStatus,
        crmCandidateId: e.candidateId != null ? String(e.candidateId) : null, crmShiftId: e.shiftId != null ? String(e.shiftId) : null,
      })),
    () => step(row, apiKey, cursors, "holidays",
      (after) => db.select().from(holidaysTable).where(and(eq(holidaysTable.tenantId, t), gt(holidaysTable.id, after))).orderBy(asc(holidaysTable.id)).limit(BATCH),
      (h) => ({ crmId: String(h.id), date: h.date, name: h.name, excusesExpected: h.excusesExpected })),
    () => step(row, apiKey, cursors, "leaves",
      (after) => db.select().from(leaveRecordsTable).where(and(eq(leaveRecordsTable.tenantId, t), gt(leaveRecordsTable.id, after))).orderBy(asc(leaveRecordsTable.id)).limit(BATCH),
      (l) => ({ crmId: String(l.id), crmEmployeeId: String(l.employeeId), kind: l.kind, startDate: l.startDate, endDate: l.endDate, notes: l.notes })),
    () => step(row, apiKey, cursors, "vacation_requests",
      (after) => db.select().from(vacationRequestsTable).where(and(eq(vacationRequestsTable.tenantId, t), gt(vacationRequestsTable.id, after))).orderBy(asc(vacationRequestsTable.id)).limit(BATCH),
      (v) => ({ crmId: String(v.id), crmEmployeeId: String(v.employeeId), startDate: v.startDate, endDate: v.endDate, daysCount: v.daysCount, status: v.status, reviewNote: v.reviewNote, reviewedAt: iso(v.reviewedAt), createdAt: iso(v.createdAt), crmLeaveId: v.leaveRecordId != null ? String(v.leaveRecordId) : null })),
    () => step(row, apiKey, cursors, "adjustments",
      (after) => db.select().from(timeBankAdjustmentsTable).where(and(eq(timeBankAdjustmentsTable.tenantId, t), gt(timeBankAdjustmentsTable.id, after))).orderBy(asc(timeBankAdjustmentsTable.id)).limit(BATCH),
      (a) => ({ crmId: String(a.id), crmEmployeeId: String(a.employeeId), date: a.createdAt.toISOString().slice(0, 10), minutes: a.minutes, reason: a.reason })),
    () => step(row, apiKey, cursors, "terminations",
      (after) => db.select().from(terminationProcessesTable).where(and(eq(terminationProcessesTable.tenantId, t), gt(terminationProcessesTable.id, after))).orderBy(asc(terminationProcessesTable.id)).limit(BATCH),
      (x) => ({ ...x, crmId: String(x.id), crmEmployeeId: String(x.employeeId), concludedAt: iso(x.concludedAt), cancelledAt: iso(x.cancelledAt), createdAt: iso(x.createdAt), updatedAt: iso(x.updatedAt) })),
    () => step(row, apiKey, cursors, "signatures",
      (after) => db.select().from(timesheetSignaturesTable).where(and(eq(timesheetSignaturesTable.tenantId, t), gt(timesheetSignaturesTable.id, after))).orderBy(asc(timesheetSignaturesTable.id)).limit(BATCH),
      (s) => ({ crmId: String(s.id), crmEmployeeId: String(s.employeeId), period: s.periodMonth, workedMinutes: s.workedMinutes, expectedMinutes: s.expectedMinutes, adjustmentMinutes: s.adjustmentMinutes, balanceMinutes: s.balanceMinutes, signedAt: iso(s.signedAt) })),
    () => step(row, apiKey, cursors, "contract_templates",
      (after) => db.select().from(employeeContractTemplatesTable).where(and(eq(employeeContractTemplatesTable.tenantId, t), gt(employeeContractTemplatesTable.id, after))).orderBy(asc(employeeContractTemplatesTable.id)).limit(BATCH),
      (c) => ({ crmId: String(c.id), name: c.name, kind: c.kind, contractType: c.contractType, bodyText: c.bodyText, isDefault: c.isDefault })),
  ];

  // Um lote de cada tipo por rodada (a cada 5 min) até tudo terminar.
  let allDone = true;
  for (const run of plan) {
    const done = await run();
    if (!done) allDone = false;
  }
  if (allDone) {
    await db.update(tenantErpIntegrationsTable).set({ hrHistoryDoneAt: new Date() })
      .where(eq(tenantErpIntegrationsTable.tenantId, t));
    logger.info({ tenantId: t }, "ERP RH: histórico todo enviado ao ERP");
  }
}

export const HISTORY_KINDS = [
  "settings", "positions", "candidates", "candidate_video", "shifts", "employee_details", "holidays", "leaves",
  "vacation_requests", "adjustments", "terminations", "signatures", "contract_templates",
];
