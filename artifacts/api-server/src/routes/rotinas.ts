import { Router, type IRouter, type Request, type Response } from "express";
import {
  db, routineChecklistsTable, routineChecklistQuestionsTable, routineChecklistScopesTable,
  routineResponsesTable, routineUrgentBypassesTable, routineResponseEvidenceTable, routineClosuresTable, routineScoreWeightsTable,
  employeesTable, storesTable, sectorsTable, usersTable,
  type RoutineChecklist, type RoutineChecklistQuestion, type RoutineChecklistScope, type RoutineNoJustification,
} from "@workspace/db";
import { eq, and, desc, asc, isNotNull, inArray, gte, lte } from "drizzle-orm";
import { requireAuth, requireTenant, requireModule, requireAdminOrSupervisor, tenantIdOf } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { isPasswordRecentlyVerified, clearPasswordVerified } from "./auth";
import { todayInfo, isDueToday, resolveUserContext, scopeMatchesUser, isOnLeaveToday, computePontoRelative } from "../lib/routinesShared";
import { generateRoutineClosuresForMonth, previousMonthKey, currentMonthKey } from "../lib/routineClosures";
import { getScoreWeights, computeRoutineScore } from "../lib/routineScore";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";

const router: IRouter = Router();

// Fase 1: CRUD do admin (modelo de dados), sem trava/agendamento disparando.
// Fase 2 (abaixo, a partir de "Devido agora"): checklist "devido agora" pro
// usuário logado, reautenticação por senha e resposta com snapshot — ainda
// SOFT (fechável), sem travar o sistema de verdade (isso é a Fase 3).

const VALID_RECURRENCE = ["daily", "weekdays", "specific_days", "weekly", "monthly", "specific_date", "continuous"];
const VALID_QUESTION_TYPES = ["yes_no", "done_not_done", "text", "number", "value", "photo", "document", "observation"];
const VALID_EVIDENCE_TYPES = ["photo", "document"];
const VALID_ALERT_LEVELS = ["critico", "atencao"];
// Fase 3.5: lista fixa de motivo quando a resposta é negativa numa pergunta
// requiresJustificationOnNo — mesmos códigos usados no front (RotinasProdutividade,
// RoutineChecklistGate) pra rotular.
export const VALID_NO_REASONS = [
  "falta_tempo", "dependencia_colega", "dependencia_gerente", "falta_produto_peca",
  "problema_sistema", "problema_equipamento", "cliente_nao_respondeu", "nao_foi_possivel_executar", "outro",
];
// Valor que conta como "resposta negativa" por tipo de pergunta — só esses
// tipos disparam a justificativa estruturada.
const NEGATIVE_ANSWER: Record<string, string> = { yes_no: "Não", done_not_done: "Não executado" };

// ── Evidência (Fase 4) — mesmo padrão de documents.ts: disco + UUID +
// validação de magic-bytes, separado da biblioteca geral de Documentos
// (é evidência presa a uma resposta de checklist, não um documento avulso).
const EVIDENCE_DIR = path.resolve(process.cwd(), "rotinas-evidence");
const EVIDENCE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const EVIDENCE_MIME: Record<string, Record<string, string>> = {
  photo: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
  document: { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" },
};
function evidenceContentMatchesMime(buf: Buffer, mime: string): boolean {
  const startsWith = (sig: number[]) => sig.every((b, i) => buf[i] === b);
  switch (mime) {
    case "application/pdf": return startsWith([0x25, 0x50, 0x44, 0x46]);
    case "image/jpeg": return startsWith([0xff, 0xd8, 0xff]);
    case "image/png": return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/webp": return startsWith([0x52, 0x49, 0x46, 0x46]) && buf.length > 11 && buf.toString("ascii", 8, 12) === "WEBP";
    default: return false;
  }
}
type EvidenceInput = { fileName?: unknown; mimeType?: unknown; data?: unknown };
type SavedEvidence = { questionId: number; fileName: string; storedName: string; mimeType: string; sizeBytes: number };
// Valida e grava em disco cada anexo enviado; lança { status, error } se algo
// não bater (tipo não permitido, assinatura não confere, tamanho, obrigatório
// faltando). Retorna só o que foi de fato salvo, pra inserir depois do
// insert da resposta (não cria arquivo órfão se a resposta falhar).
async function processEvidence(
  questions: RoutineChecklistQuestion[],
  rawEvidence: Record<string, unknown>,
): Promise<{ error: string } | { saved: SavedEvidence[] }> {
  const saved: SavedEvidence[] = [];
  for (const q of questions) {
    const wantsEvidence = q.requiresEvidence || q.type === "photo" || q.type === "document";
    if (!wantsEvidence) continue;
    const evidenceType = q.evidenceType ?? (q.type === "photo" || q.type === "document" ? q.type : "photo");
    const raw = rawEvidence[q.id] as EvidenceInput | undefined;
    if (!raw || typeof raw !== "object") {
      if (q.required) return { error: `Anexe uma evidência em: "${q.label}"` };
      continue;
    }
    const fileName = typeof raw.fileName === "string" && raw.fileName.trim() ? raw.fileName.trim().slice(0, 255) : "evidencia";
    const mime = typeof raw.mimeType === "string" ? raw.mimeType.split(";")[0].trim() : "";
    const allowed = EVIDENCE_MIME[evidenceType] ?? EVIDENCE_MIME.photo;
    const ext = allowed[mime];
    if (!ext) return { error: `Tipo de arquivo não permitido em: "${q.label}"` };
    if (typeof raw.data !== "string" || !raw.data) return { error: `Arquivo vazio em: "${q.label}"` };
    const buf = Buffer.from(raw.data, "base64");
    if (buf.length === 0) return { error: `Arquivo vazio em: "${q.label}"` };
    if (!evidenceContentMatchesMime(buf, mime)) return { error: `O conteúdo do arquivo não corresponde ao tipo em: "${q.label}"` };
    if (buf.length > EVIDENCE_MAX_SIZE) return { error: `Arquivo muito grande (máx. 10MB) em: "${q.label}"` };

    await mkdir(EVIDENCE_DIR, { recursive: true });
    const storedName = `${randomUUID()}.${ext}`;
    await writeFile(path.join(EVIDENCE_DIR, storedName), buf);
    saved.push({ questionId: q.id, fileName, storedName, mimeType: mime, sizeBytes: buf.length });
  }
  return { saved };
}

type QuestionInput = {
  label?: unknown; type?: unknown; required?: unknown;
  requiresEvidence?: unknown; evidenceType?: unknown;
  requiresJustificationOnNo?: unknown; alertLevel?: unknown;
};
type ScopeInput = {
  storeId?: unknown; sectorId?: unknown; jobFunction?: unknown; userId?: unknown;
};
type SanitizedQuestion = {
  label: string; type: string; required: boolean; requiresEvidence: boolean; evidenceType: string | null;
  requiresJustificationOnNo: boolean; alertLevel: string | null;
};
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
    const requiresJustificationOnNo = raw?.requiresJustificationOnNo === true && type in NEGATIVE_ANSWER;
    const alertLevel = typeof raw?.alertLevel === "string" && VALID_ALERT_LEVELS.includes(raw.alertLevel) ? raw.alertLevel : null;
    out.push({ label, type, required: raw?.required !== false, requiresEvidence, evidenceType, requiresJustificationOnNo, alertLevel });
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
  const recurrence = typeof b.recurrence === "string" && VALID_RECURRENCE.includes(b.recurrence) ? b.recurrence : "daily";
  // "continuous" não tem horário fixo — devido o expediente inteiro.
  let scheduledTime: string | null = null;
  if (recurrence !== "continuous") {
    scheduledTime = typeof b.scheduledTime === "string" && /^\d{2}:\d{2}$/.test(b.scheduledTime) ? b.scheduledTime : "";
    if (!scheduledTime) { res.status(400).json({ error: "Horário inválido (use HH:MM)" }); return; }
  }
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
  const recurrence = typeof b.recurrence === "string" && VALID_RECURRENCE.includes(b.recurrence) ? b.recurrence : existing.recurrence;
  if (b.recurrence !== undefined) update.recurrence = recurrence;
  // "continuous" não tem horário fixo; sair de "continuous" pra qualquer
  // outra recorrência exige informar um horário (não sobra um scheduledTime
  // nulo herdado de antes).
  if (recurrence === "continuous") {
    if (b.recurrence !== undefined) update.scheduledTime = null;
  } else if (b.scheduledTime !== undefined) {
    if (typeof b.scheduledTime !== "string" || !/^\d{2}:\d{2}$/.test(b.scheduledTime)) { res.status(400).json({ error: "Horário inválido (use HH:MM)" }); return; }
    update.scheduledTime = b.scheduledTime;
  } else if (b.recurrence !== undefined && !existing.scheduledTime) {
    res.status(400).json({ error: "Informe um horário pra sair de 'contínuo'" }); return;
  }
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
  // Recolhe os arquivos de evidência ANTES do delete (cascade apaga as
  // linhas do banco, mas não o arquivo em disco — isso limpa os dois).
  const orphanFiles = await db.select({ storedName: routineResponseEvidenceTable.storedName })
    .from(routineResponseEvidenceTable)
    .innerJoin(routineResponsesTable, eq(routineResponseEvidenceTable.responseId, routineResponsesTable.id))
    .where(and(eq(routineResponsesTable.checklistId, id), eq(routineResponseEvidenceTable.tenantId, tenantId)));
  await db.delete(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.id, id), eq(routineChecklistsTable.tenantId, tenantId)));
  for (const f of orphanFiles) {
    await unlink(path.join(EVIDENCE_DIR, path.basename(f.storedName))).catch(() => {});
  }
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
  const [stores, sectors, users, employees] = await Promise.all([
    db.select({ id: storesTable.id, name: storesTable.name }).from(storesTable).where(eq(storesTable.tenantId, tenantId)),
    db.select({ id: sectorsTable.id, name: sectorsTable.name }).from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId)),
    db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId)),
    // Fase 5: relatório mensal é por employeeId (Ponto), não userId — só
    // quem tem login vinculado pode ter respondido algum checklist.
    db.select({ id: employeesTable.id, name: employeesTable.name }).from(employeesTable)
      .where(and(eq(employeesTable.tenantId, tenantId), isNotNull(employeesTable.userId))),
  ]);
  res.json({ stores, sectors, users, employees });
});

// ── Devido agora (resolução pro usuário logado) ────────────────────────────
// Funções de escopo/data compartilhadas com routineClosures.ts (Fase 5) —
// ver lib/routinesShared.ts.

type PendingRoutine = RoutineChecklist & { questions: RoutineChecklistQuestion[]; periodKey: string };

async function getPendingRoutines(tenantId: number, userId: number): Promise<PendingRoutine[]> {
  const info = todayInfo();
  const ctx = await resolveUserContext(tenantId, userId);
  if (await isOnLeaveToday(tenantId, ctx.employeeId, info.dateKey)) return [];

  const checklists = await db.select().from(routineChecklistsTable)
    .where(and(eq(routineChecklistsTable.tenantId, tenantId), eq(routineChecklistsTable.active, true)));
  const due = checklists.filter((c) => {
    if (!isDueToday(c, info)) return false;
    if (c.recurrence === "continuous" || !c.scheduledTime) return true; // devido o expediente inteiro
    return info.nowMinutes >= parseInt(c.scheduledTime.slice(0, 2), 10) * 60 + parseInt(c.scheduledTime.slice(3, 5), 10);
  });
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
    questions: p.questions.map((q) => ({
      id: q.id, label: q.label, type: q.type, required: q.required, requiresEvidence: q.requiresEvidence, evidenceType: q.evidenceType,
      requiresJustificationOnNo: q.requiresJustificationOnNo, alertLevel: q.alertLevel,
    })),
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

  const body = (req.body ?? {}) as { answers?: Record<string, unknown> };
  const raw = body.answers && typeof body.answers === "object" ? body.answers : {};
  const answers: Record<string, string | RoutineNoJustification> = {};
  for (const q of target.questions) {
    const rawVal = raw[q.id];
    // Justificativa estruturada: { value, motivo, pendencia?, comunicarA? }.
    // Só é aceita/exigida quando a pergunta marca requiresJustificationOnNo
    // e o valor bate com a resposta negativa do tipo dela.
    let value = "";
    let justification: RoutineNoJustification | null = null;
    if (rawVal && typeof rawVal === "object") {
      const j = rawVal as Record<string, unknown>;
      value = typeof j.value === "string" ? j.value.trim().slice(0, 1000) : "";
      if (q.requiresJustificationOnNo && value === NEGATIVE_ANSWER[q.type]) {
        const motivo = typeof j.motivo === "string" && VALID_NO_REASONS.includes(j.motivo) ? j.motivo : "";
        if (!motivo) { res.status(400).json({ error: `Informe o motivo em: "${q.label}"` }); return; }
        justification = {
          value, motivo,
          pendencia: typeof j.pendencia === "string" ? j.pendencia.trim().slice(0, 500) || null : null,
          comunicarA: typeof j.comunicarA === "string" ? j.comunicarA.trim().slice(0, 200) || null : null,
        };
      }
    } else {
      value = typeof rawVal === "string" ? rawVal.trim().slice(0, 1000) : "";
    }
    // Foto/documento: a evidência anexada É a resposta — não pede valor de
    // texto (validado abaixo, em processEvidence).
    const isEvidenceOnlyType = q.type === "photo" || q.type === "document";
    if (!value && q.required && !isEvidenceOnlyType) { res.status(400).json({ error: `Responda: "${q.label}"` }); return; }
    if (value) answers[q.id] = justification ?? value;
  }

  // Fase 4: valida e grava em disco ANTES de inserir a resposta — se algo
  // não bater, não sobra linha de resposta sem evidência obrigatória.
  const rawEvidence = (req.body?.evidence && typeof req.body.evidence === "object" ? req.body.evidence : {}) as Record<string, unknown>;
  const evidenceResult = await processEvidence(target.questions, rawEvidence);
  if ("error" in evidenceResult) { res.status(400).json({ error: evidenceResult.error }); return; }

  // Fase 5: cruzamento com o Ponto — só faz sentido pra checklist com
  // horário fixo (abertura/fechamento); "contínuo" não tem um instante de
  // comparação único. Puro dado pro relatório, calculado uma vez aqui e
  // nunca recalculado (mesma imutabilidade do resto da resposta).
  let respondedRelativeToPonto: string | null = null;
  if (target.recurrence !== "continuous") {
    const ctx = await resolveUserContext(tenantId, userId);
    respondedRelativeToPonto = await computePontoRelative(tenantId, ctx.employeeId, target.periodKey, new Date());
  }

  try {
    const [saved] = await db.insert(routineResponsesTable).values({
      tenantId, checklistId: id, userId, periodKey: target.periodKey, answers,
      questionsSnapshot: target.questions.map((q) => ({
        id: q.id, label: q.label, type: q.type, required: q.required, requiresEvidence: q.requiresEvidence, evidenceType: q.evidenceType,
        requiresJustificationOnNo: q.requiresJustificationOnNo, alertLevel: q.alertLevel,
      })),
      reauthAt: new Date(),
      deviceInfo: (req.headers["user-agent"] as string | undefined)?.slice(0, 300) ?? null,
      respondedRelativeToPonto,
    }).returning();
    if (evidenceResult.saved.length) {
      await db.insert(routineResponseEvidenceTable).values(
        evidenceResult.saved.map((e) => ({ tenantId, responseId: saved!.id, ...e })),
      );
    }
    clearPasswordVerified(tenantId, userId);
    invalidateRoutineBlock(tenantId, userId);
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
    userSectorId: usersTable.sectorId, sectorName: sectorsTable.name,
    userStoreId: usersTable.storeId, storeName: storesTable.name,
    periodKey: routineResponsesTable.periodKey,
    answers: routineResponsesTable.answers, questionsSnapshot: routineResponsesTable.questionsSnapshot,
    reauthAt: routineResponsesTable.reauthAt, createdAt: routineResponsesTable.createdAt,
  })
    .from(routineResponsesTable)
    .leftJoin(usersTable, eq(routineResponsesTable.userId, usersTable.id))
    .leftJoin(storesTable, eq(usersTable.storeId, storesTable.id))
    .leftJoin(sectorsTable, eq(usersTable.sectorId, sectorsTable.id))
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

  // Evidência (Fase 4) por resposta — só metadado + id (o arquivo em si sai
  // por /rotinas/evidence/:id/file, com o mesmo controle de acesso).
  const responseIds = visible.map((r) => r.id);
  const evidenceRows = responseIds.length
    ? await db.select({
        id: routineResponseEvidenceTable.id, responseId: routineResponseEvidenceTable.responseId,
        questionId: routineResponseEvidenceTable.questionId, fileName: routineResponseEvidenceTable.fileName,
        mimeType: routineResponseEvidenceTable.mimeType, sizeBytes: routineResponseEvidenceTable.sizeBytes,
        createdAt: routineResponseEvidenceTable.createdAt,
      }).from(routineResponseEvidenceTable).where(inArray(routineResponseEvidenceTable.responseId, responseIds))
    : [];
  const evidenceByResponse = new Map<number, typeof evidenceRows>();
  for (const e of evidenceRows) {
    evidenceByResponse.set(e.responseId, [...(evidenceByResponse.get(e.responseId) ?? []), e]);
  }

  res.json(visible.map(({ userSectorId: _userSectorId, ...r }) => ({ ...r, evidence: evidenceByResponse.get(r.id) ?? [] })));
});

// ── Baixar/visualizar evidência (Fase 4) — mesmo controle de acesso 3
// camadas do /responses (admin tudo, supervisor o setor dele, funcionário só
// a própria), verificado aqui de novo porque é uma rota de arquivo separada. ──
router.get("/rotinas/evidence/:id/file", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [row] = await db.select({
    fileName: routineResponseEvidenceTable.fileName, storedName: routineResponseEvidenceTable.storedName,
    mimeType: routineResponseEvidenceTable.mimeType, responseUserId: routineResponsesTable.userId,
    responseUserSectorId: usersTable.sectorId,
  })
    .from(routineResponseEvidenceTable)
    .innerJoin(routineResponsesTable, eq(routineResponseEvidenceTable.responseId, routineResponsesTable.id))
    .leftJoin(usersTable, eq(routineResponsesTable.userId, usersTable.id))
    .where(and(eq(routineResponseEvidenceTable.id, id), eq(routineResponseEvidenceTable.tenantId, tenantId)));
  if (!row) { res.status(404).json({ error: "Evidência não encontrada" }); return; }

  const role = req.session.userRole;
  const ownSectorId = req.session.userSectorId;
  const allowed = role === "admin"
    || row.responseUserId === req.session.userId
    || (role === "supervisor" && ownSectorId != null && row.responseUserSectorId === ownSectorId);
  if (!allowed) { res.status(403).json({ error: "Sem acesso a esta evidência" }); return; }

  const filepath = path.join(EVIDENCE_DIR, path.basename(row.storedName));
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado no servidor" }); return; }
  const INLINE_SAFE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader("Content-Disposition", `${INLINE_SAFE.has(row.mimeType) ? "inline" : "attachment"}; filename="${encodeURIComponent(row.fileName)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filepath);
});

// ── Atendimento urgente (Fase 3) ────────────────────────────────────────
// Libera temporariamente a trava sem marcar o checklist como respondido —
// só grava que o bypass foi usado (auditoria) e libera por uma janela curta.
const URGENT_BYPASS_MS = 20 * 60_000; // 20 minutos
const urgentBypassCache = new Map<string, number>(); // "tenantId:userId" -> expira em (epoch ms)

function hasActiveUrgentBypass(tenantId: number, userId: number): boolean {
  const exp = urgentBypassCache.get(`${tenantId}:${userId}`);
  return !!exp && exp > Date.now();
}

router.post("/rotinas/checklists/:id/urgent-bypass", requireAuth, requireModule("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const pending = await getPendingRoutines(tenantId, userId);
  const target = pending.find((p) => p.id === id && p.mandatory);
  if (!target) { res.status(404).json({ error: "Checklist obrigatório não está pendente pra você agora" }); return; }

  await db.insert(routineUrgentBypassesTable).values({ tenantId, checklistId: id, userId });
  const bypassUntil = Date.now() + URGENT_BYPASS_MS;
  urgentBypassCache.set(`${tenantId}:${userId}`, bypassUntil);
  res.json({ ok: true, bypassUntil: new Date(bypassUntil).toISOString() });
});

// ── Trava dura: bloqueia (423) enquanto houver checklist OBRIGATÓRIO
// pendente, igual ao enforceMandatoryChecklists (checklists.ts) — mas com
// allowlist mais larga: atendimento (chat/internal-chat) nunca trava, pra
// não interromper mensagem em andamento nem encerrar atendimento ativo
// (item 44 do relatório mestre). "Atendimento urgente" libera tudo por uma
// janela curta, mesmo com checklist ainda pendente.
const BLOCK_ALLOWLIST = [
  /^\/auth\//,
  /^\/rotinas\/pending$/,
  /^\/rotinas\/checklists\/\d+\/respond$/,
  /^\/rotinas\/checklists\/\d+\/urgent-bypass$/,
  /^\/chat\//,
  /^\/internal-chat\//,
];
const BLOCK_CACHE_MS = 60_000;
const blockCache = new Map<string, { until: number; blocked: boolean }>();
export function invalidateRoutineBlock(tenantId: number, userId: number): void {
  blockCache.delete(`${tenantId}:${userId}`);
}

export async function enforceMandatoryRoutines(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): Promise<void> {
  const uid = req.session?.userId;
  if (!uid) { next(); return; }
  if (BLOCK_ALLOWLIST.some((r) => r.test(req.path))) { next(); return; }
  const tenantId = tenantIdOf(req);
  if (tenantId == null) { next(); return; }
  if (hasActiveUrgentBypass(tenantId, uid)) { next(); return; }
  try {
    const cacheKey = `${tenantId}:${uid}`;
    const cached = blockCache.get(cacheKey);
    let blocked: boolean;
    if (cached && cached.until > Date.now()) {
      blocked = cached.blocked;
    } else {
      const pending = await getPendingRoutines(tenantId, uid);
      blocked = pending.some((p) => p.mandatory);
      blockCache.set(cacheKey, { until: Date.now() + BLOCK_CACHE_MS, blocked });
    }
    if (blocked) {
      res.status(423).json({ error: "Responda o checklist obrigatório para liberar o sistema", code: "ROUTINE_REQUIRED" });
      return;
    }
    next();
  } catch {
    next(); // em falha do banco, não derruba o sistema inteiro
  }
}

// ── Fechamento mensal + relatório (Fase 5) — mesmo padrão de
// /rh-dp/closures (rhDp.ts): listar, gerar (admin, mês já encerrado só),
// apagar (correção). Congelado — nunca recalculado por cima do que já
// fechou (idempotente via índice único, ver routineClosures.ts). ──
router.get("/rotinas/closures", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = req.query.employeeId ? parseInt(String(req.query.employeeId), 10) : null;
  const periodMonth = typeof req.query.periodMonth === "string" && /^\d{4}-\d{2}$/.test(req.query.periodMonth) ? req.query.periodMonth : null;
  const conditions = [eq(routineClosuresTable.tenantId, tenantId)];
  if (employeeId != null && !isNaN(employeeId)) conditions.push(eq(routineClosuresTable.employeeId, employeeId));
  if (periodMonth) conditions.push(eq(routineClosuresTable.periodMonth, periodMonth));
  // Fase 6: enriquece com loja/setor — o relatório por loja reaproveita a
  // mesma hierarquia de navegação Loja → Setor → Funcionário de Documentos,
  // agregando esta mesma lista no front (ver RotinasProdutividade.tsx).
  const rows = await db.select({
    id: routineClosuresTable.id, employeeId: routineClosuresTable.employeeId, employeeName: routineClosuresTable.employeeName,
    periodMonth: routineClosuresTable.periodMonth,
    totalDue: routineClosuresTable.totalDue, totalAnswered: routineClosuresTable.totalAnswered, totalOnTime: routineClosuresTable.totalOnTime,
    totalWithPendency: routineClosuresTable.totalWithPendency, totalUrgentBypass: routineClosuresTable.totalUrgentBypass,
    pontoBeforeEntry: routineClosuresTable.pontoBeforeEntry, pontoAfterEntry: routineClosuresTable.pontoAfterEntry, pontoNoRecord: routineClosuresTable.pontoNoRecord,
    closedAt: routineClosuresTable.closedAt, approvedAt: routineClosuresTable.approvedAt, approvedByUserId: routineClosuresTable.approvedByUserId,
    storeId: employeesTable.storeId, storeName: storesTable.name, sectorId: usersTable.sectorId, sectorName: sectorsTable.name,
  })
    .from(routineClosuresTable)
    .leftJoin(employeesTable, eq(routineClosuresTable.employeeId, employeesTable.id))
    .leftJoin(storesTable, eq(employeesTable.storeId, storesTable.id))
    .leftJoin(usersTable, eq(employeesTable.userId, usersTable.id))
    .leftJoin(sectorsTable, eq(usersTable.sectorId, sectorsTable.id))
    .where(and(...conditions))
    .orderBy(desc(routineClosuresTable.periodMonth), asc(routineClosuresTable.employeeName));
  res.json(rows);
});

router.post("/rotinas/closures/run", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as { month?: string };
  const month = typeof b.month === "string" && /^\d{4}-\d{2}$/.test(b.month) ? b.month : previousMonthKey(new Date());
  // Só fecha mês já encerrado — nunca o mês corrente (ainda em andamento).
  if (month >= currentMonthKey(new Date())) {
    res.status(400).json({ error: "Só é possível fechar meses já encerrados" }); return;
  }
  const created = await generateRoutineClosuresForMonth(month, tenantId);
  res.json({ ok: true, month, created });
});

router.delete("/rotinas/closures/:id", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(routineClosuresTable).where(and(eq(routineClosuresTable.id, id), eq(routineClosuresTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ── Score/ranking (Fase 6) ──────────────────────────────────────────────
router.get("/rotinas/score-weights", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getScoreWeights(tenantId));
});

router.patch("/rotinas/score-weights", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const clamp = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : fallback);
  const current = await getScoreWeights(tenantId);
  const weightOnTime = clamp(b.weightOnTime, current.weightOnTime);
  const weightNoPendency = clamp(b.weightNoPendency, current.weightNoPendency);
  const weightNoUrgentAbuse = clamp(b.weightNoUrgentAbuse, current.weightNoUrgentAbuse);
  if (weightOnTime + weightNoPendency + weightNoUrgentAbuse === 0) {
    res.status(400).json({ error: "A soma dos pesos não pode ser zero" }); return;
  }
  await db.insert(routineScoreWeightsTable).values({ tenantId, weightOnTime, weightNoPendency, weightNoUrgentAbuse })
    .onConflictDoUpdate({ target: routineScoreWeightsTable.tenantId, set: { weightOnTime, weightNoPendency, weightNoUrgentAbuse, updatedAt: new Date() } });
  res.json({ weightOnTime, weightNoPendency, weightNoUrgentAbuse });
});

// Ranking: só vendedor/técnico (role "vendedor" — gerente de loja é role
// "supervisor" e fica de fora, já que é quem supervisiona). Sem
// reconhecimento visual ainda (Fase 7) — só a lista ordenada com o score e
// os componentes que formaram ele (transparência, item 55).
router.get("/rotinas/ranking", requireModuleAccess("rotinas"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const periodMonth = typeof req.query.periodMonth === "string" && /^\d{4}-\d{2}$/.test(req.query.periodMonth) ? req.query.periodMonth : previousMonthKey(new Date());
  const storeId = req.query.storeId ? parseInt(String(req.query.storeId), 10) : null;

  const conditions = [eq(routineClosuresTable.tenantId, tenantId), eq(routineClosuresTable.periodMonth, periodMonth), eq(usersTable.role, "vendedor")];
  if (storeId != null && !isNaN(storeId)) conditions.push(eq(employeesTable.storeId, storeId));

  const rows = await db.select({
    closure: routineClosuresTable,
    storeId: employeesTable.storeId, storeName: storesTable.name, sectorName: sectorsTable.name, jobFunction: employeesTable.jobFunction,
  })
    .from(routineClosuresTable)
    .innerJoin(employeesTable, eq(routineClosuresTable.employeeId, employeesTable.id))
    .innerJoin(usersTable, eq(employeesTable.userId, usersTable.id))
    .leftJoin(storesTable, eq(employeesTable.storeId, storesTable.id))
    .leftJoin(sectorsTable, eq(usersTable.sectorId, sectorsTable.id))
    .where(and(...conditions));

  const weights = await getScoreWeights(tenantId);
  const ranked = rows
    .map((r) => {
      const breakdown = computeRoutineScore(r.closure, weights);
      if (!breakdown) return null;
      return {
        employeeId: r.closure.employeeId, employeeName: r.closure.employeeName,
        storeId: r.storeId, storeName: r.storeName, sectorName: r.sectorName, jobFunction: r.jobFunction,
        totalDue: r.closure.totalDue, totalAnswered: r.closure.totalAnswered,
        approved: r.closure.approvedAt != null,
        ...breakdown,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score);

  res.json({ periodMonth, weights, ranking: ranked });
});

// ── Aprovação do supervisor (Fase 6) — revisa pendência/urgência antes do
// fechamento do mês contar "de verdade" no ranking. Escopo: admin vê tudo,
// supervisor só o setor dele (mesmo padrão 3 camadas do resto do módulo —
// a sessão só carrega setor, não loja, então "loja" aqui é aproximado pelo
// setor do funcionário, consistente com o resto de Rotinas). ──
async function assertReviewAccess(req: Request, res: Response, targetUserId: number): Promise<boolean> {
  if (req.session.userRole === "admin") return true;
  if (req.session.userRole !== "supervisor") { res.status(403).json({ error: "Sem permissão pra revisar" }); return false; }
  const tenantId = tenantIdOf(req)!;
  const [target] = await db.select({ sectorId: usersTable.sectorId }).from(usersTable)
    .where(and(eq(usersTable.id, targetUserId), eq(usersTable.tenantId, tenantId)));
  if (!target || target.sectorId == null || target.sectorId !== req.session.userSectorId) {
    res.status(403).json({ error: "Sem permissão pra revisar funcionário de outro setor" }); return false;
  }
  return true;
}

router.post("/rotinas/responses/:id/review", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [target] = await db.select({ userId: routineResponsesTable.userId }).from(routineResponsesTable)
    .where(and(eq(routineResponsesTable.id, id), eq(routineResponsesTable.tenantId, tenantId)));
  if (!target) { res.status(404).json({ error: "Resposta não encontrada" }); return; }
  if (!(await assertReviewAccess(req, res, target.userId))) return;

  const b = (req.body ?? {}) as { status?: unknown; note?: unknown };
  const status = b.status === "approved" || b.status === "contested" ? b.status : null;
  if (!status) { res.status(400).json({ error: "Status inválido (use 'approved' ou 'contested')" }); return; }
  const [updated] = await db.update(routineResponsesTable).set({
    pendencyReviewStatus: status, pendencyReviewedByUserId: req.session.userId!,
    pendencyReviewNote: typeof b.note === "string" ? b.note.trim().slice(0, 500) || null : null,
    pendencyReviewedAt: new Date(),
  }).where(and(eq(routineResponsesTable.id, id), eq(routineResponsesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.post("/rotinas/urgent-bypasses/:id/review", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [target] = await db.select({ userId: routineUrgentBypassesTable.userId }).from(routineUrgentBypassesTable)
    .where(and(eq(routineUrgentBypassesTable.id, id), eq(routineUrgentBypassesTable.tenantId, tenantId)));
  if (!target) { res.status(404).json({ error: "Registro não encontrado" }); return; }
  if (!(await assertReviewAccess(req, res, target.userId))) return;

  const b = (req.body ?? {}) as { status?: unknown; note?: unknown };
  const status = b.status === "approved" || b.status === "contested" ? b.status : null;
  if (!status) { res.status(400).json({ error: "Status inválido (use 'approved' ou 'contested')" }); return; }
  const [updated] = await db.update(routineUrgentBypassesTable).set({
    reviewStatus: status, reviewedByUserId: req.session.userId!,
    reviewNote: typeof b.note === "string" ? b.note.trim().slice(0, 500) || null : null,
    reviewedAt: new Date(),
  }).where(and(eq(routineUrgentBypassesTable.id, id), eq(routineUrgentBypassesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

// Lista o que falta revisar num mês (admin vê tudo, supervisor só o setor
// dele) — alimenta a tela de aprovação antes de POST /closures/:id/approve.
router.get("/rotinas/review/pending", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const periodMonth = typeof req.query.periodMonth === "string" && /^\d{4}-\d{2}$/.test(req.query.periodMonth) ? req.query.periodMonth : previousMonthKey(new Date());
  const sectorScope = req.session.userRole === "supervisor" ? req.session.userSectorId : undefined;

  const pendencyRows = await db.select({
    id: routineResponsesTable.id, userId: routineResponsesTable.userId, userName: usersTable.name, sectorId: usersTable.sectorId,
    periodKey: routineResponsesTable.periodKey, answers: routineResponsesTable.answers,
    reviewStatus: routineResponsesTable.pendencyReviewStatus,
  })
    .from(routineResponsesTable)
    .leftJoin(usersTable, eq(routineResponsesTable.userId, usersTable.id))
    .where(and(
      eq(routineResponsesTable.tenantId, tenantId),
      gte(routineResponsesTable.periodKey, `${periodMonth}-01`), lte(routineResponsesTable.periodKey, `${periodMonth}-31`),
    ));
  const pendencies = pendencyRows.filter((r) =>
    Object.values(r.answers).some((v) => typeof v === "object" && !!v.pendencia)
    && r.reviewStatus == null
    && (sectorScope == null || r.sectorId === sectorScope),
  );

  const monthStart = new Date(`${periodMonth}-01T00:00:00-03:00`);
  const [y, m] = periodMonth.split("-").map(Number);
  const monthEnd = new Date(`${periodMonth}-${String(new Date(y!, m!, 0).getDate()).padStart(2, "0")}T23:59:59-03:00`);
  const bypassRows = await db.select({
    id: routineUrgentBypassesTable.id, userId: routineUrgentBypassesTable.userId, userName: usersTable.name, sectorId: usersTable.sectorId,
    createdAt: routineUrgentBypassesTable.createdAt, reviewStatus: routineUrgentBypassesTable.reviewStatus,
  })
    .from(routineUrgentBypassesTable)
    .leftJoin(usersTable, eq(routineUrgentBypassesTable.userId, usersTable.id))
    .where(and(
      eq(routineUrgentBypassesTable.tenantId, tenantId),
      gte(routineUrgentBypassesTable.createdAt, monthStart), lte(routineUrgentBypassesTable.createdAt, monthEnd),
    ));
  const bypasses = bypassRows.filter((r) => r.reviewStatus == null && (sectorScope == null || r.sectorId === sectorScope));

  res.json({
    periodMonth,
    pendencies: pendencies.map(({ sectorId: _s, reviewStatus: _r, ...r }) => r),
    urgentBypasses: bypasses.map(({ sectorId: _s, reviewStatus: _r, ...r }) => r),
  });
});

router.post("/rotinas/closures/:id/approve", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [closure] = await db.select().from(routineClosuresTable)
    .where(and(eq(routineClosuresTable.id, id), eq(routineClosuresTable.tenantId, tenantId)));
  if (!closure) { res.status(404).json({ error: "Fechamento não encontrado" }); return; }
  const [employee] = await db.select({ userId: employeesTable.userId }).from(employeesTable)
    .where(and(eq(employeesTable.id, closure.employeeId), eq(employeesTable.tenantId, tenantId)));
  if (!employee?.userId) { res.status(404).json({ error: "Funcionário sem usuário vinculado" }); return; }
  if (!(await assertReviewAccess(req, res, employee.userId))) return;

  const periodMonth = closure.periodMonth;
  const responses = await db.select({ answers: routineResponsesTable.answers, reviewStatus: routineResponsesTable.pendencyReviewStatus })
    .from(routineResponsesTable)
    .where(and(
      eq(routineResponsesTable.tenantId, tenantId), eq(routineResponsesTable.userId, employee.userId),
      gte(routineResponsesTable.periodKey, `${periodMonth}-01`), lte(routineResponsesTable.periodKey, `${periodMonth}-31`),
    ));
  const unreviewedPendencies = responses.filter((r) => Object.values(r.answers).some((v) => typeof v === "object" && !!v.pendencia) && r.reviewStatus == null).length;

  const monthStart = new Date(`${periodMonth}-01T00:00:00-03:00`);
  const [y, m] = periodMonth.split("-").map(Number);
  const monthEnd = new Date(`${periodMonth}-${String(new Date(y!, m!, 0).getDate()).padStart(2, "0")}T23:59:59-03:00`);
  const bypasses = await db.select({ reviewStatus: routineUrgentBypassesTable.reviewStatus }).from(routineUrgentBypassesTable)
    .where(and(
      eq(routineUrgentBypassesTable.tenantId, tenantId), eq(routineUrgentBypassesTable.userId, employee.userId),
      gte(routineUrgentBypassesTable.createdAt, monthStart), lte(routineUrgentBypassesTable.createdAt, monthEnd),
    ));
  const unreviewedBypasses = bypasses.filter((b) => b.reviewStatus == null).length;

  if (unreviewedPendencies + unreviewedBypasses > 0) {
    res.status(400).json({
      error: `Ainda falta revisar ${unreviewedPendencies} pendência(s) e ${unreviewedBypasses} atendimento(s) urgente(s) antes de aprovar o mês`,
      unreviewedPendencies, unreviewedBypasses,
    });
    return;
  }

  const [updated] = await db.update(routineClosuresTable)
    .set({ approvedAt: new Date(), approvedByUserId: req.session.userId! })
    .where(and(eq(routineClosuresTable.id, id), eq(routineClosuresTable.tenantId, tenantId)))
    .returning();
  res.json(updated);
});

export default router;
