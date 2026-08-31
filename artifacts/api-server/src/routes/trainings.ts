import { Router, type IRouter } from "express";
import { db, trainingsTable, trainingCompletionsTable, trainingProgressTable, usersTable } from "@workspace/db";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor, requireTenant, tenantIdOf } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();

type QuizQuestion = { id: string; label: string; options: string[]; correct: number };
type ChecklistQuestion = { id: string; label: string; type: "text" | "options" | "rating"; options?: string[] };
const VALID_ROLES = ["admin", "supervisor", "vendedor"];
const VALID_TYPES = ["text", "video", "quiz", "checklist"];
const VALID_RECURRENCE = ["daily", "weekly", "once"];
const QUIZ_PASS_SCORE = 70; // % mínimo de acertos para concluir um quiz

// ── Datas no fuso da loja (Brasil) — usado só pelo tipo "checklist" ────────
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
function dueInfo(c: { recurrence: string | null; dayOfWeek: number | null; startDate: string | null }): { due: boolean; periodKey: string } {
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

function sanitizeChecklistQuestions(input: unknown): ChecklistQuestion[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 30) return null;
  const out: ChecklistQuestion[] = [];
  for (let i = 0; i < input.length; i++) {
    const q = input[i] as Partial<ChecklistQuestion>;
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

function sanitizeQuiz(input: unknown): QuizQuestion[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 30) return null;
  const out: QuizQuestion[] = [];
  for (let i = 0; i < input.length; i++) {
    const q = input[i] as Partial<QuizQuestion>;
    const label = typeof q?.label === "string" ? q.label.trim().slice(0, 300) : "";
    const options = Array.isArray(q?.options)
      ? q.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 200)).slice(0, 8)
      : [];
    const correct = typeof q?.correct === "number" ? Math.floor(q.correct) : -1;
    if (!label || options.length < 2 || correct < 0 || correct >= options.length) return null;
    out.push({ id: `q${i + 1}`, label, options, correct });
  }
  return out;
}

// Só aceita links http(s) válidos (bloqueia javascript:, data: etc).
function normalizeVideoUrl(raw: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

function sanitizeRoles(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const roles = input.filter((r): r is string => typeof r === "string" && VALID_ROLES.includes(r));
  return roles.length ? Array.from(new Set(roles)) : null;
}

// Prazo pra concluir: aceita "" ou undefined como "sem prazo" (null); uma
// data em formato inválido também vira null em vez de derrubar a request —
// é um campo informativo, não vale travar o cadastro por causa dele.
function sanitizeDueDate(input: unknown): Date | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Remove o gabarito antes de mandar o quiz para quem vai responder (o
// checklist não tem "resposta certa", então suas perguntas vão inteiras).
function stripAnswers(t: typeof trainingsTable.$inferSelect) {
  const quiz = Array.isArray(t.quiz)
    ? (t.quiz as QuizQuestion[]).map(({ id, label, options }) => ({ id, label, options }))
    : null;
  return {
    id: t.id, title: t.title, description: t.description, type: t.type, content: t.content, quiz,
    mandatory: t.mandatory, dueDate: t.dueDate,
    questions: t.type === "checklist" ? (t.questions as ChecklistQuestion[] | null) : null,
    recurrence: t.recurrence, dayOfWeek: t.dayOfWeek, startDate: t.startDate,
  };
}

// ── Pendências (compartilhado com o bloqueio do sistema) ───────────────────
// Treinamentos normais (texto/vídeo/quiz): pendente = nunca concluído (uma
// vez feito, fica concluído pra sempre — repetir é opcional). Checklist:
// pendente = "devido" hoje/nesta semana E sem resposta para o período atual —
// pode voltar a ficar pendente no próximo período mesmo já tendo respondido
// antes (ver dueInfo/periodKey acima).
export async function getPendingTrainings(uid: number, role: string, tenantId: number) {
  const all = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.active, true), eq(trainingsTable.tenantId, tenantId)));
  const target = all.filter((t) => (t.targetRoles as string[]).includes(role));
  if (target.length === 0) return [];

  const normal = target.filter((t) => t.type !== "checklist");
  const checklists = target.filter((t) => t.type === "checklist");
  const results: (ReturnType<typeof stripAnswers> & { draftAnswers?: unknown; periodKey?: string })[] = [];

  if (normal.length) {
    const done = await db.select({ trainingId: trainingCompletionsTable.trainingId })
      .from(trainingCompletionsTable)
      .where(and(
        eq(trainingCompletionsTable.userId, uid),
        inArray(trainingCompletionsTable.trainingId, normal.map((t) => t.id)),
      ));
    const doneSet = new Set(done.map((d) => d.trainingId));
    const pendingNormal = normal.filter((t) => !doneSet.has(t.id));
    if (pendingNormal.length) {
      // Rascunho em andamento ("Continuar de onde parou") mesmo dentro da
      // trava de obrigatório — sem isso, um quiz longo interrompido reiniciaria do zero.
      const drafts = await db.select({ trainingId: trainingProgressTable.trainingId, answers: trainingProgressTable.answers })
        .from(trainingProgressTable)
        .where(and(eq(trainingProgressTable.userId, uid), inArray(trainingProgressTable.trainingId, pendingNormal.map((t) => t.id))));
      const draftMap = new Map(drafts.map((d) => [d.trainingId, d.answers]));
      results.push(...pendingNormal.map((t) => ({ ...stripAnswers(t), draftAnswers: draftMap.get(t.id) ?? null })));
    }
  }

  if (checklists.length) {
    const due = checklists
      .map((t) => ({ t, info: dueInfo(t) }))
      .filter((x) => x.info.due);
    if (due.length) {
      const ids = due.map((d) => d.t.id);
      const keys = Array.from(new Set(due.map((d) => d.info.periodKey)));
      const answered = await db
        .select({ trainingId: trainingCompletionsTable.trainingId, periodKey: trainingCompletionsTable.periodKey })
        .from(trainingCompletionsTable)
        .where(and(
          eq(trainingCompletionsTable.userId, uid),
          inArray(trainingCompletionsTable.trainingId, ids),
          inArray(trainingCompletionsTable.periodKey, keys),
        ));
      const doneSet = new Set(answered.map((a) => `${a.trainingId}|${a.periodKey}`));
      results.push(...due
        .filter((d) => !doneSet.has(`${d.t.id}|${d.info.periodKey}`))
        .map((d) => ({ ...stripAnswers(d.t), draftAnswers: null, periodKey: d.info.periodKey })));
    }
  }

  return results;
}

// Estatísticas de tentativas do próprio usuário, por treinamento — usado
// pela lista (myScore/attemptCount/bestScore/etc.) e pela Central de
// Treinamentos. Repetir nunca apaga nada, então isso é sempre um agregado
// sobre TODAS as linhas de training_completions daquele usuário.
type TrainingStats = {
  attemptCount: number; bestScore: number | null; lastScore: number | null;
  firstCompletedAt: Date; lastCompletedAt: Date;
};
async function getMyTrainingStats(userId: number): Promise<Map<number, TrainingStats>> {
  const rows = await db.select({
    trainingId: trainingCompletionsTable.trainingId,
    quizScore: trainingCompletionsTable.quizScore,
    createdAt: trainingCompletionsTable.createdAt,
  }).from(trainingCompletionsTable).where(eq(trainingCompletionsTable.userId, userId));
  const map = new Map<number, TrainingStats>();
  // Ordena por data pra garantir que "última" tentativa é sempre a mais recente,
  // mesmo que as linhas não venham ordenadas do banco.
  for (const r of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const cur = map.get(r.trainingId);
    if (!cur) {
      map.set(r.trainingId, {
        attemptCount: 1, bestScore: r.quizScore, lastScore: r.quizScore,
        firstCompletedAt: r.createdAt, lastCompletedAt: r.createdAt,
      });
    } else {
      cur.attemptCount++;
      cur.lastScore = r.quizScore;
      cur.lastCompletedAt = r.createdAt;
      if (r.quizScore != null && (cur.bestScore == null || r.quizScore > cur.bestScore)) cur.bestScore = r.quizScore;
    }
  }
  return map;
}

// Rascunho ("Continuar de onde parou") do próprio usuário, por treinamento.
async function getMyDrafts(userId: number): Promise<Map<number, Record<string, number>>> {
  const rows = await db.select({
    trainingId: trainingProgressTable.trainingId,
    answers: trainingProgressTable.answers,
  }).from(trainingProgressTable).where(eq(trainingProgressTable.userId, userId));
  return new Map(rows.map((r) => [r.trainingId, (r.answers ?? {}) as Record<string, number>]));
}

const blockCache = new Map<number, { until: number; blocked: boolean }>();
const BLOCK_CACHE_MS = 60000;
function invalidateTrainingBlock(uid: number): void { blockCache.delete(uid); }

// Rotas que continuam acessíveis enquanto o usuário está travado por
// treinamento (ou checklist, que agora é só um tipo de treinamento) pendente.
export const GATE_ALLOWLIST = [
  /^\/auth\//,
  /^\/trainings\/pending$/, /^\/trainings\/\d+\/complete$/,
  // "Continuar de onde parou" e "Ver progresso" precisam funcionar mesmo com
  // o treinamento obrigatório travando o resto do sistema.
  /^\/trainings\/\d+\/progress$/, /^\/trainings\/\d+\/attempts$/,
];

export async function enforceMandatoryTrainings(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): Promise<void> {
  const uid = req.session?.userId;
  if (!uid) { next(); return; }
  if (GATE_ALLOWLIST.some((r) => r.test(req.path))) { next(); return; }
  // Sem loja na sessão (superadmin/sessão antiga): não há treinamento a exigir.
  const tenantId = tenantIdOf(req);
  if (tenantId == null) { next(); return; }
  try {
    const cached = blockCache.get(uid);
    let blocked: boolean;
    if (cached && cached.until > Date.now()) {
      blocked = cached.blocked;
    } else {
      const pending = await getPendingTrainings(uid, req.session.userRole ?? "", tenantId);
      blocked = pending.some((p) => p.mandatory);
      blockCache.set(uid, { until: Date.now() + BLOCK_CACHE_MS, blocked });
    }
    if (blocked) {
      res.status(423).json({ error: "Conclua o treinamento obrigatório para liberar o sistema", code: "TRAINING_REQUIRED" });
      return;
    }
    next();
  } catch {
    next();
  }
}

router.get("/trainings/pending", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getPendingTrainings(req.session.userId!, req.session.userRole ?? "", tenantId));
});

// Lista para consulta (todos veem os treinamentos da sua função + status).
router.get("/trainings", requireAuth, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const role = req.session.userRole ?? "";
  const isManager = role === "admin" || role === "supervisor";
  const all = await db.select().from(trainingsTable)
    .where(eq(trainingsTable.tenantId, tenantId)).orderBy(desc(trainingsTable.createdAt));
  const visible = isManager ? all : all.filter((t) => t.active && (t.targetRoles as string[]).includes(role));
  const [statsMap, draftsMap] = await Promise.all([
    getMyTrainingStats(req.session.userId!),
    getMyDrafts(req.session.userId!),
  ]);
  res.json(visible.map((t) => {
    const s = statsMap.get(t.id);
    return {
      ...(isManager ? { ...stripAnswers(t), quiz: t.quiz, targetRoles: t.targetRoles, active: t.active, createdAt: t.createdAt } : stripAnswers(t)),
      completed: !!s,
      myScore: s?.lastScore ?? null,
      attemptCount: s?.attemptCount ?? 0,
      bestScore: s?.bestScore ?? null,
      firstCompletedAt: s?.firstCompletedAt ?? null,
      lastCompletedAt: s?.lastCompletedAt ?? null,
      draftAnswers: draftsMap.get(t.id) ?? null,
    };
  }));
});

// Concluir treinamento (texto/vídeo: direto; quiz: corrige e exige nota mínima).
router.post("/trainings/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [t] = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!t || !t.active) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  if (!(t.targetRoles as string[]).includes(req.session.userRole ?? "")) {
    res.status(403).json({ error: "Este treinamento não é para a sua função" }); return;
  }

  // Checklist: sem nota/gabarito — cada pergunta (texto/opções/nota) só
  // precisa vir preenchida. Uma resposta por período (dia/semana/único); o
  // índice parcial training_completions_period_unique barra uma 2ª resposta
  // no mesmo período (corrida entre abas).
  if (t.type === "checklist") {
    const info = dueInfo(t);
    if (!info.due) { res.status(400).json({ error: "Este questionário não está aberto hoje" }); return; }
    const questions = (t.questions ?? []) as ChecklistQuestion[];
    const raw = ((req.body ?? {}) as { answers?: Record<string, string> }).answers ?? {};
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const v = typeof raw[q.id] === "string" ? raw[q.id].trim().slice(0, 1000) : "";
      if (!v) { res.status(400).json({ error: `Responda a pergunta: "${q.label}"` }); return; }
      if (q.type === "options" && !(q.options ?? []).includes(v)) { res.status(400).json({ error: `Opção inválida em: "${q.label}"` }); return; }
      if (q.type === "rating" && !["1", "2", "3", "4", "5"].includes(v)) { res.status(400).json({ error: `Nota inválida em: "${q.label}"` }); return; }
      answers[q.id] = v;
    }
    const uid = req.session.userId!;
    let attemptNumber: number | null = null;
    for (let tries = 0; tries < 2 && attemptNumber === null; tries++) {
      const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${trainingCompletionsTable.attemptNumber}), 0)` })
        .from(trainingCompletionsTable)
        .where(and(eq(trainingCompletionsTable.trainingId, id), eq(trainingCompletionsTable.userId, uid)));
      const next = (max ?? 0) + 1;
      try {
        await db.insert(trainingCompletionsTable).values({
          tenantId, trainingId: id, userId: uid, attemptNumber: next, quizScore: null, answers, periodKey: info.periodKey,
        });
        attemptNumber = next;
      } catch (err) {
        const constraint = (err as { constraint?: string })?.constraint;
        if (constraint === "training_completions_period_unique") {
          res.status(409).json({ error: "Você já respondeu este questionário neste período" }); return;
        }
        if ((err as { code?: string })?.code === "23505" && tries === 0) continue; // corrida no attemptNumber: tenta o próximo
        req.log.error({ err }, "checklist completion insert failed");
        res.status(500).json({ error: "Erro ao registrar a resposta. Tente novamente." }); return;
      }
    }
    if (attemptNumber === null) { res.status(500).json({ error: "Erro ao registrar a resposta. Tente novamente." }); return; }
    invalidateTrainingBlock(uid);
    res.status(201).json({ ok: true, score: null, attemptNumber });
    return;
  }

  let quizScore: number | null = null;
  let answers: Record<string, number> | null = null;
  if (t.type === "quiz") {
    const quiz = (t.quiz ?? []) as QuizQuestion[];
    if (quiz.length === 0) { res.status(500).json({ error: "Este quiz está sem perguntas — avise o administrador" }); return; }
    const raw = ((req.body ?? {}) as { answers?: Record<string, number> }).answers ?? {};
    let correct = 0;
    answers = {};
    for (const q of quiz) {
      const v = raw[q.id];
      if (typeof v !== "number" || v < 0 || v >= q.options.length) {
        res.status(400).json({ error: `Responda a pergunta: "${q.label}"` }); return;
      }
      answers[q.id] = Math.floor(v);
      if (Math.floor(v) === q.correct) correct++;
    }
    quizScore = Math.round((correct / quiz.length) * 100);
    if (quizScore < QUIZ_PASS_SCORE) {
      res.status(422).json({ error: `Você acertou ${quizScore}%. É preciso pelo menos ${QUIZ_PASS_SCORE}% — revise o material e tente de novo.`, score: quizScore });
      return;
    }
  }

  // Repetir treinamento grava uma NOVA tentativa (não sobrescreve nem apaga
  // as anteriores) — attemptNumber é "maior existente + 1". Duas abas
  // enviando ao mesmo tempo podem calcular o mesmo número; se isso colidir
  // no índice único, tenta de novo uma vez com o número seguinte antes de
  // desistir (corrida rara, não vale travar o usuário por causa dela).
  const uid = req.session.userId!;
  let attemptNumber: number | null = null;
  for (let tries = 0; tries < 2 && attemptNumber === null; tries++) {
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${trainingCompletionsTable.attemptNumber}), 0)` })
      .from(trainingCompletionsTable)
      .where(and(eq(trainingCompletionsTable.trainingId, id), eq(trainingCompletionsTable.userId, uid)));
    const next = (max ?? 0) + 1;
    try {
      await db.insert(trainingCompletionsTable).values({
        tenantId, trainingId: id, userId: uid, attemptNumber: next, quizScore, answers,
      });
      attemptNumber = next;
    } catch (err) {
      if ((err as { code?: string })?.code === "23505" && tries === 0) continue; // corrida: tenta o próximo número
      req.log.error({ err }, "training completion insert failed");
      res.status(500).json({ error: "Erro ao registrar a conclusão. Tente novamente." }); return;
    }
  }
  if (attemptNumber === null) {
    res.status(500).json({ error: "Erro ao registrar a conclusão. Tente novamente." }); return;
  }
  // A tentativa foi enviada — o rascunho de "onde parou" não faz mais sentido.
  await db.delete(trainingProgressTable)
    .where(and(eq(trainingProgressTable.trainingId, id), eq(trainingProgressTable.userId, uid)));
  invalidateTrainingBlock(uid);
  res.status(201).json({ ok: true, score: quizScore, attemptNumber });
});

// Salva rascunho de respostas do quiz em andamento ("Continuar de onde
// parou"). Sobrescreve o rascunho anterior — não é histórico, é só "onde eu
// estava" antes de enviar de fato.
router.post("/trainings/:id/progress", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [t] = await db.select({ id: trainingsTable.id, targetRoles: trainingsTable.targetRoles }).from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!t) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  if (!(t.targetRoles as string[]).includes(req.session.userRole ?? "")) {
    res.status(403).json({ error: "Este treinamento não é para a sua função" }); return;
  }
  const raw = ((req.body ?? {}) as { answers?: Record<string, number> }).answers ?? {};
  const answers: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number") answers[k.slice(0, 40)] = Math.floor(v);
  await db.insert(trainingProgressTable)
    .values({ tenantId, trainingId: id, userId: req.session.userId!, answers })
    .onConflictDoUpdate({
      target: [trainingProgressTable.trainingId, trainingProgressTable.userId],
      set: { answers, updatedAt: new Date() },
    });
  res.json({ ok: true });
});

// "Recomeçar do início": descarta o rascunho em andamento.
router.delete("/trainings/:id/progress", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(trainingProgressTable)
    .where(and(eq(trainingProgressTable.trainingId, id), eq(trainingProgressTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// Histórico de TENTATIVAS do próprio usuário nesse treinamento — "Ver
// progresso" / "Ver resultado" na Central de Treinamentos. Nunca apaga nada:
// cada linha é uma conclusão passada, mais antiga primeiro (Tentativa 1, 2, 3...).
router.get("/trainings/:id/attempts", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [t] = await db.select({ id: trainingsTable.id }).from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!t) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  const rows = await db.select({
    id: trainingCompletionsTable.id,
    attemptNumber: trainingCompletionsTable.attemptNumber,
    quizScore: trainingCompletionsTable.quizScore,
    createdAt: trainingCompletionsTable.createdAt,
  }).from(trainingCompletionsTable)
    .where(and(eq(trainingCompletionsTable.trainingId, id), eq(trainingCompletionsTable.userId, req.session.userId!)))
    .orderBy(trainingCompletionsTable.attemptNumber);
  res.json(rows);
});

// ── Gestão (admin ou supervisor) ───────────────────────────────────────────
router.post("/trainings", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { title, description, type, content, quiz, questions, recurrence, dayOfWeek, startDate, targetRoles, mandatory, active, dueDate } = req.body ?? {};
  const tt = typeof title === "string" ? title.trim().slice(0, 150) : "";
  if (!tt) { res.status(400).json({ error: "Informe o título" }); return; }
  const ty = VALID_TYPES.includes(type) ? type : "text";
  const roles = sanitizeRoles(targetRoles);
  if (!roles) { res.status(400).json({ error: "Escolha pelo menos uma função" }); return; }
  let qz: QuizQuestion[] | null = null;
  let ct: string | null = null;
  let qs: ChecklistQuestion[] | null = null;
  let rec: string | null = null;
  let dow: number | null = null;
  let sd: string | null = null;
  if (ty === "checklist") {
    qs = sanitizeChecklistQuestions(questions);
    if (!qs) { res.status(400).json({ error: "Perguntas inválidas (1 a 30; opções precisam de pelo menos 2 alternativas)" }); return; }
    rec = VALID_RECURRENCE.includes(recurrence) ? recurrence : "weekly";
    dow = rec === "weekly" ? Math.min(6, Math.max(0, parseInt(String(dayOfWeek ?? 1), 10) || 0)) : null;
    sd = typeof startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null;
  } else if (ty === "quiz") {
    qz = sanitizeQuiz(quiz);
    if (!qz) { res.status(400).json({ error: "Quiz inválido (1 a 30 perguntas, cada uma com 2+ opções e a resposta certa marcada)" }); return; }
    ct = typeof content === "string" ? content.trim().slice(0, 20000) || null : null; // material de apoio opcional
  } else {
    ct = typeof content === "string" ? content.trim().slice(0, 20000) : "";
    if (!ct) { res.status(400).json({ error: ty === "video" ? "Informe o link do vídeo" : "Informe o conteúdo do treinamento" }); return; }
    if (ty === "video") {
      const safe = normalizeVideoUrl(ct);
      if (!safe) { res.status(400).json({ error: "Link de vídeo inválido — use um endereço http(s) como https://youtube.com/..." }); return; }
      ct = safe;
    }
  }
  const [created] = await db.insert(trainingsTable).values({
    tenantId,
    title: tt,
    description: typeof description === "string" ? description.trim().slice(0, 500) || null : null,
    type: ty, content: ct, quiz: qz, questions: qs, recurrence: rec, dayOfWeek: dow, startDate: sd, targetRoles: roles,
    mandatory: mandatory !== false, active: active !== false,
    dueDate: sanitizeDueDate(dueDate),
    createdBy: req.session.userId!,
  }).returning();
  blockCache.clear();
  res.status(201).json(created);
});

router.patch("/trainings/:id", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { title, description, type, content, quiz, questions, recurrence, dayOfWeek, startDate, targetRoles, mandatory, active, dueDate } = req.body ?? {};
  const update: Record<string, unknown> = {};
  if (dueDate !== undefined) update.dueDate = sanitizeDueDate(dueDate);
  if (title !== undefined) {
    const tt = typeof title === "string" ? title.trim().slice(0, 150) : "";
    if (!tt) { res.status(400).json({ error: "Informe o título" }); return; }
    update.title = tt;
  }
  if (description !== undefined) update.description = typeof description === "string" ? description.trim().slice(0, 500) || null : null;

  // Valida o registro FINAL (tipo + conteúdo/quiz/checklist coerentes entre si).
  const [existing] = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  const finalType = type !== undefined && VALID_TYPES.includes(type) ? type : existing.type;
  update.type = finalType;

  if (finalType === "checklist") {
    const rawQuestions = questions !== undefined ? questions : existing.questions;
    const qs = sanitizeChecklistQuestions(rawQuestions);
    if (!qs) { res.status(400).json({ error: "Perguntas inválidas (1 a 30; opções precisam de pelo menos 2 alternativas)" }); return; }
    update.questions = qs;
    const rawRec = recurrence !== undefined ? recurrence : existing.recurrence;
    const rec = VALID_RECURRENCE.includes(rawRec) ? rawRec : "weekly";
    update.recurrence = rec;
    const rawDow = dayOfWeek !== undefined ? dayOfWeek : existing.dayOfWeek;
    update.dayOfWeek = rec === "weekly" ? Math.min(6, Math.max(0, parseInt(String(rawDow ?? 1), 10) || 0)) : null;
    const rawSd = startDate !== undefined ? startDate : existing.startDate;
    update.startDate = typeof rawSd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawSd) ? rawSd : null;
    update.quiz = null;
    update.content = null;
    if (targetRoles !== undefined) {
      const roles = sanitizeRoles(targetRoles);
      if (!roles) { res.status(400).json({ error: "Escolha pelo menos uma função" }); return; }
      update.targetRoles = roles;
    }
    if (mandatory !== undefined) update.mandatory = !!mandatory;
    if (active !== undefined) update.active = !!active;
    const [updated] = await db.update(trainingsTable).set(update)
      .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId))).returning();
    if (!updated) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
    blockCache.clear();
    res.json(updated);
    return;
  }

  let finalContent = content !== undefined
    ? (typeof content === "string" ? content.trim().slice(0, 20000) || null : null)
    : existing.content;
  if (finalType === "quiz") {
    const rawQuiz = quiz !== undefined ? quiz : existing.quiz;
    const qz = sanitizeQuiz(rawQuiz);
    if (!qz) { res.status(400).json({ error: "Quiz inválido (1 a 30 perguntas, cada uma com 2+ opções e a resposta certa marcada)" }); return; }
    update.quiz = qz;
  } else {
    update.quiz = null;
    if (!finalContent) { res.status(400).json({ error: finalType === "video" ? "Informe o link do vídeo" : "Informe o conteúdo do treinamento" }); return; }
    if (finalType === "video") {
      const safe = normalizeVideoUrl(finalContent);
      if (!safe) { res.status(400).json({ error: "Link de vídeo inválido — use um endereço http(s)" }); return; }
      finalContent = safe;
    }
  }
  update.content = finalContent;
  update.questions = null;
  update.recurrence = null;
  update.dayOfWeek = null;
  update.startDate = null;
  if (targetRoles !== undefined) {
    const roles = sanitizeRoles(targetRoles);
    if (!roles) { res.status(400).json({ error: "Escolha pelo menos uma função" }); return; }
    update.targetRoles = roles;
  }
  if (mandatory !== undefined) update.mandatory = !!mandatory;
  if (active !== undefined) update.active = !!active;
  const [updated] = await db.update(trainingsTable).set(update)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  blockCache.clear();
  res.json(updated);
});

router.delete("/trainings/:id", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  blockCache.clear();
  res.json({ ok: true });
});

// Quem concluiu (admin/supervisor) — agora mostra TODAS as tentativas de
// todo mundo (não só a mais recente por pessoa), já que repetir não apaga
// histórico. attemptNumber deixa claro quando é a 2ª, 3ª... tentativa da
// mesma pessoa.
router.get("/trainings/:id/completions", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  // Filho (conclusões) escopa pelo pai: confirma que o treinamento é da loja.
  const [parent] = await db.select({ id: trainingsTable.id }).from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!parent) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  const rows = await db
    .select({
      id: trainingCompletionsTable.id,
      userId: trainingCompletionsTable.userId,
      userName: usersTable.name,
      attemptNumber: trainingCompletionsTable.attemptNumber,
      quizScore: trainingCompletionsTable.quizScore,
      answers: trainingCompletionsTable.answers,
      periodKey: trainingCompletionsTable.periodKey,
      forcedByAdminId: trainingCompletionsTable.forcedByAdminId,
      createdAt: trainingCompletionsTable.createdAt,
    })
    .from(trainingCompletionsTable)
    .leftJoin(usersTable, eq(trainingCompletionsTable.userId, usersTable.id))
    .where(eq(trainingCompletionsTable.trainingId, id))
    .orderBy(desc(trainingCompletionsTable.createdAt))
    .limit(500);
  res.json(rows);
});

// Quem ainda está pendente (da(s) função(ões)-alvo) — pra admin/supervisor
// decidir quem precisa de um empurrão ou de um "destravar" manual (abaixo).
router.get("/trainings/:id/pending-users", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [t] = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!t) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  const roles = t.targetRoles as string[];
  const targetUsers = await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), inArray(usersTable.role, roles)));
  if (targetUsers.length === 0) { res.json([]); return; }
  // Checklist: "pendente" é por PERÍODO atual (pode ter respondido semana
  // passada e estar pendente de novo hoje) — não "nunca respondeu".
  if (t.type === "checklist") {
    const info = dueInfo(t);
    if (!info.due) { res.json([]); return; } // hoje/esta semana não é dia de responder: ninguém pendente
    const answered = await db.select({ userId: trainingCompletionsTable.userId }).from(trainingCompletionsTable)
      .where(and(
        eq(trainingCompletionsTable.trainingId, id),
        eq(trainingCompletionsTable.periodKey, info.periodKey),
        inArray(trainingCompletionsTable.userId, targetUsers.map((u) => u.id)),
      ));
    const doneSet = new Set(answered.map((a) => a.userId));
    res.json(targetUsers.filter((u) => !doneSet.has(u.id)));
    return;
  }
  const done = await db.select({ userId: trainingCompletionsTable.userId }).from(trainingCompletionsTable)
    .where(and(eq(trainingCompletionsTable.trainingId, id), inArray(trainingCompletionsTable.userId, targetUsers.map((u) => u.id))));
  const doneSet = new Set(done.map((d) => d.userId));
  res.json(targetUsers.filter((u) => !doneSet.has(u.id)));
});

// "Destravar sistema": libera UM usuário específico sem ele ter concluído de
// verdade — grava uma conclusão marcada com forcedByAdminId pra ficar
// rastreável (aparece na lista de conclusões com uma nota, ver frontend).
// Pedido do lojista: precisa de uma saída manual pra quando o treinamento
// travou alguém e não dá pra esperar a pessoa concluir (treinamento com
// problema, urgência de acesso etc.).
router.post("/trainings/:id/force-unlock", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const userId = parseInt(String((req.body ?? {}).userId), 10);
  if (isNaN(userId)) { res.status(400).json({ error: "Escolha um usuário" }); return; }

  const [t] = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!t) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  const [target] = await db.select({ id: usersTable.id, role: usersTable.role }).from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  // Checklist: marca o unlock como resposta do PERÍODO atual (se hoje/esta
  // semana for dia de responder) — senão a pessoa continuaria "pendente" de
  // novo no mesmo período assim que o cache de bloqueio expirasse.
  const periodKey = t.type === "checklist" ? (dueInfo(t).due ? dueInfo(t).periodKey : null) : null;

  const [{ maxAttempt } = { maxAttempt: 0 }] = await db.select({ maxAttempt: sql<number>`coalesce(max(${trainingCompletionsTable.attemptNumber}), 0)` })
    .from(trainingCompletionsTable)
    .where(and(eq(trainingCompletionsTable.trainingId, id), eq(trainingCompletionsTable.userId, userId)));
  await db.insert(trainingCompletionsTable).values({
    tenantId, trainingId: id, userId,
    attemptNumber: (maxAttempt ?? 0) + 1,
    quizScore: null, answers: null, periodKey,
    forcedByAdminId: req.session.userId!,
  });
  invalidateTrainingBlock(userId);
  res.json({ ok: true });
});

export default router;
