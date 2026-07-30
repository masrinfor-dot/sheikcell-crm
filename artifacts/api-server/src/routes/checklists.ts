import { Router, type IRouter } from "express";
import { db, checklistsTable, checklistResponsesTable, usersTable } from "@workspace/db";
import { eq, desc, and, inArray } from "drizzle-orm";
import { requireAuth, requireFeature } from "../middlewares/auth";

const router: IRouter = Router();

type Question = { id: string; label: string; type: "text" | "options" | "rating"; options?: string[] };

const VALID_ROLES = ["admin", "supervisor", "vendedor"];
const VALID_RECURRENCE = ["daily", "weekly", "once"];

// ── Datas no fuso da loja (Brasil) ─────────────────────────────────────────
function todayParts(): { dateKey: string; weekday: number } {
  const now = new Date();
  const dateKey = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
  const weekdayName = now.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  return { dateKey, weekday };
}

// Chave da semana ISO-like: segunda como início ("YYYY-Wnn").
function weekKey(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // 0=segunda
  d.setUTCDate(d.getUTCDate() - day + 3); // quinta da semana
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Verifica se o checklist está "devido" hoje para preenchimento e qual a
// chave do período (uma resposta por período por usuário).
function dueInfo(c: { recurrence: string; dayOfWeek: number | null; startDate: string | null }): { due: boolean; periodKey: string } {
  const { dateKey, weekday } = todayParts();
  if (c.startDate && dateKey < c.startDate) return { due: false, periodKey: "" };
  if (c.recurrence === "daily") return { due: true, periodKey: dateKey };
  if (c.recurrence === "weekly") {
    const target = c.dayOfWeek ?? 1;
    // Semana começa na segunda (1) e termina no domingo (0). Fica pendente do
    // dia configurado até o fim da semana.
    const pos = (d: number) => (d + 6) % 7; // segunda=0 ... domingo=6
    return { due: pos(weekday) >= pos(target), periodKey: weekKey(dateKey) };
  }
  // once: devido a partir da data de início (ou criação)
  return { due: true, periodKey: "once" };
}

function sanitizeQuestions(input: unknown): Question[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 30) return null;
  const out: Question[] = [];
  for (let i = 0; i < input.length; i++) {
    const q = input[i] as Partial<Question>;
    const label = typeof q?.label === "string" ? q.label.trim().slice(0, 300) : "";
    const type = q?.type === "options" || q?.type === "rating" ? q.type : "text";
    if (!label) return null;
    let options: string[] | undefined;
    if (type === "options") {
      options = Array.isArray(q?.options)
        ? q.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 100)).slice(0, 10)
        : [];
      if (options.length < 2) return null;
    }
    out.push({ id: `q${i + 1}`, label, type, ...(options ? { options } : {}) });
  }
  return out;
}

function sanitizeRoles(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const roles = input.filter((r): r is string => typeof r === "string" && VALID_ROLES.includes(r));
  return roles.length ? Array.from(new Set(roles)) : null;
}

// ── Pendências (consulta compartilhada, sem N+1) ───────────────────────────
type PendingItem = {
  id: number; title: string; description: string | null;
  questions: unknown; mandatory: boolean; periodKey: string;
};

async function getPendingChecklists(uid: number, role: string): Promise<PendingItem[]> {
  const all = await db.select().from(checklistsTable).where(eq(checklistsTable.active, true));
  const due: { c: typeof all[number]; periodKey: string }[] = [];
  for (const c of all) {
    if (!(c.targetRoles as string[]).includes(role)) continue;
    const info = dueInfo(c);
    if (info.due) due.push({ c, periodKey: info.periodKey });
  }
  if (due.length === 0) return [];
  const ids = due.map((d) => d.c.id);
  const keys = Array.from(new Set(due.map((d) => d.periodKey)));
  const answered = await db
    .select({ checklistId: checklistResponsesTable.checklistId, periodKey: checklistResponsesTable.periodKey })
    .from(checklistResponsesTable)
    .where(and(
      eq(checklistResponsesTable.userId, uid),
      inArray(checklistResponsesTable.checklistId, ids),
      inArray(checklistResponsesTable.periodKey, keys),
    ));
  const done = new Set(answered.map((a) => `${a.checklistId}|${a.periodKey}`));
  return due
    .filter((d) => !done.has(`${d.c.id}|${d.periodKey}`))
    .map((d) => ({
      id: d.c.id, title: d.c.title, description: d.c.description,
      questions: d.c.questions, mandatory: d.c.mandatory, periodKey: d.periodKey,
    }));
}

// Cache curto do estado "bloqueado" para não pesar o banco a cada request.
const BLOCK_CACHE_MS = 60000;
const blockCache = new Map<number, { until: number; blocked: boolean }>();
export function invalidateChecklistBlock(uid: number): void { blockCache.delete(uid); }

// Middleware global: com questionário OBRIGATÓRIO pendente, o usuário só
// acessa autenticação e as rotas de pendências/resposta — o resto retorna 423.
const BLOCK_ALLOWLIST = [
  /^\/auth\//,
  /^\/checklists\/pending$/, /^\/checklists\/\d+\/respond$/,
  /^\/trainings\/pending$/, /^\/trainings\/\d+\/complete$/,
];
export async function enforceMandatoryChecklists(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): Promise<void> {
  const uid = req.session?.userId;
  if (!uid) { next(); return; }
  if (BLOCK_ALLOWLIST.some((r) => r.test(req.path))) { next(); return; }
  try {
    const cached = blockCache.get(uid);
    let blocked: boolean;
    if (cached && cached.until > Date.now()) {
      blocked = cached.blocked;
    } else {
      const pending = await getPendingChecklists(uid, req.session.userRole ?? "");
      blocked = pending.some((p) => p.mandatory);
      blockCache.set(uid, { until: Date.now() + BLOCK_CACHE_MS, blocked });
    }
    if (blocked) {
      res.status(423).json({ error: "Responda o questionário obrigatório para liberar o sistema", code: "CHECKLIST_REQUIRED" });
      return;
    }
    next();
  } catch {
    next(); // em falha do banco, não derruba o sistema inteiro
  }
}

// ── Pendências do usuário logado (para o bloqueio de uso) ─────────────────
router.get("/checklists/pending", requireAuth, async (req, res): Promise<void> => {
  const pending = await getPendingChecklists(req.session.userId!, req.session.userRole ?? "");
  res.json(pending);
});

// ── Responder ──────────────────────────────────────────────────────────────
router.post("/checklists/:id/respond", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [c] = await db.select().from(checklistsTable).where(eq(checklistsTable.id, id));
  if (!c || !c.active) { res.status(404).json({ error: "Questionário não encontrado" }); return; }
  const roles = c.targetRoles as string[];
  if (!roles.includes(req.session.userRole ?? "")) { res.status(403).json({ error: "Este questionário não é para a sua função" }); return; }
  const { due, periodKey } = dueInfo(c);
  if (!due) { res.status(400).json({ error: "Este questionário não está aberto hoje" }); return; }

  const questions = c.questions as Question[];
  const body = (req.body ?? {}) as { answers?: Record<string, string> };
  const raw = body.answers && typeof body.answers === "object" ? body.answers : {};
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const v = typeof raw[q.id] === "string" ? raw[q.id].trim().slice(0, 1000) : "";
    if (!v) { res.status(400).json({ error: `Responda a pergunta: "${q.label}"` }); return; }
    if (q.type === "options" && !(q.options ?? []).includes(v)) { res.status(400).json({ error: `Opção inválida em: "${q.label}"` }); return; }
    if (q.type === "rating" && !["1", "2", "3", "4", "5"].includes(v)) { res.status(400).json({ error: `Nota inválida em: "${q.label}"` }); return; }
    answers[q.id] = v;
  }

  try {
    const [saved] = await db.insert(checklistResponsesTable).values({
      checklistId: id, userId: req.session.userId!, periodKey, answers,
    }).returning();
    invalidateChecklistBlock(req.session.userId!);
    res.status(201).json(saved);
  } catch {
    res.status(409).json({ error: "Você já respondeu este questionário neste período" });
  }
});

// ── Administração (admin) ──────────────────────────────────────────────────
router.get("/checklists", requireFeature("questionarios"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(checklistsTable).orderBy(desc(checklistsTable.createdAt));
  res.json(rows);
});

router.post("/checklists", requireFeature("questionarios"), async (req, res): Promise<void> => {
  const { title, description, questions, targetRoles, recurrence, dayOfWeek, startDate, mandatory, active } = req.body ?? {};
  const t = typeof title === "string" ? title.trim().slice(0, 150) : "";
  if (!t) { res.status(400).json({ error: "Informe o título" }); return; }
  const qs = sanitizeQuestions(questions);
  if (!qs) { res.status(400).json({ error: "Perguntas inválidas (1 a 30; opções precisam de pelo menos 2 alternativas)" }); return; }
  const roles = sanitizeRoles(targetRoles);
  if (!roles) { res.status(400).json({ error: "Escolha pelo menos uma função" }); return; }
  const rec = VALID_RECURRENCE.includes(recurrence) ? recurrence : "weekly";
  const dow = rec === "weekly" ? Math.min(6, Math.max(0, parseInt(String(dayOfWeek ?? 1), 10) || 0)) : null;
  const sd = typeof startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null;
  const [created] = await db.insert(checklistsTable).values({
    title: t,
    description: typeof description === "string" ? description.trim().slice(0, 500) || null : null,
    questions: qs, targetRoles: roles, recurrence: rec, dayOfWeek: dow, startDate: sd,
    mandatory: mandatory !== false, active: active !== false,
  }).returning();
  blockCache.clear(); // alvos/pendências podem ter mudado
  res.status(201).json(created);
});

router.patch("/checklists/:id", requireFeature("questionarios"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { title, description, questions, targetRoles, recurrence, dayOfWeek, startDate, mandatory, active } = req.body ?? {};
  const update: Record<string, unknown> = {};
  if (title !== undefined) {
    const t = typeof title === "string" ? title.trim().slice(0, 150) : "";
    if (!t) { res.status(400).json({ error: "Informe o título" }); return; }
    update.title = t;
  }
  if (description !== undefined) update.description = typeof description === "string" ? description.trim().slice(0, 500) || null : null;
  if (questions !== undefined) {
    const qs = sanitizeQuestions(questions);
    if (!qs) { res.status(400).json({ error: "Perguntas inválidas" }); return; }
    update.questions = qs;
  }
  if (targetRoles !== undefined) {
    const roles = sanitizeRoles(targetRoles);
    if (!roles) { res.status(400).json({ error: "Escolha pelo menos uma função" }); return; }
    update.targetRoles = roles;
  }
  if (recurrence !== undefined && VALID_RECURRENCE.includes(recurrence)) update.recurrence = recurrence;
  if (dayOfWeek !== undefined) update.dayOfWeek = Math.min(6, Math.max(0, parseInt(String(dayOfWeek), 10) || 0));
  if (startDate !== undefined) update.startDate = typeof startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null;
  if (mandatory !== undefined) update.mandatory = !!mandatory;
  if (active !== undefined) update.active = !!active;
  const [updated] = await db.update(checklistsTable).set(update).where(eq(checklistsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Questionário não encontrado" }); return; }
  blockCache.clear();
  res.json(updated);
});

router.delete("/checklists/:id", requireFeature("questionarios"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(checklistsTable).where(eq(checklistsTable.id, id));
  blockCache.clear();
  res.json({ ok: true });
});

// Respostas de um questionário (admin).
router.get("/checklists/:id/responses", requireFeature("questionarios"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const rows = await db
    .select({
      id: checklistResponsesTable.id,
      userId: checklistResponsesTable.userId,
      userName: usersTable.name,
      periodKey: checklistResponsesTable.periodKey,
      answers: checklistResponsesTable.answers,
      createdAt: checklistResponsesTable.createdAt,
    })
    .from(checklistResponsesTable)
    .leftJoin(usersTable, eq(checklistResponsesTable.userId, usersTable.id))
    .where(eq(checklistResponsesTable.checklistId, id))
    .orderBy(desc(checklistResponsesTable.createdAt))
    .limit(500);
  res.json(rows);
});

export default router;
