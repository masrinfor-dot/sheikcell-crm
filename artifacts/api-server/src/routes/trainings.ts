import { Router, type IRouter } from "express";
import { db, trainingsTable, trainingCompletionsTable, trainingProgressTable, usersTable } from "@workspace/db";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor, requireTenant, tenantIdOf } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();

type QuizQuestion = { id: string; label: string; options: string[]; correct: number };
const VALID_ROLES = ["admin", "supervisor", "vendedor"];
const VALID_TYPES = ["text", "video", "quiz"];
const QUIZ_PASS_SCORE = 70; // % mínimo de acertos para concluir um quiz

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

// Remove o gabarito antes de mandar o quiz para quem vai responder.
function stripAnswers(t: typeof trainingsTable.$inferSelect) {
  const quiz = Array.isArray(t.quiz)
    ? (t.quiz as QuizQuestion[]).map(({ id, label, options }) => ({ id, label, options }))
    : null;
  return { id: t.id, title: t.title, description: t.description, type: t.type, content: t.content, quiz, mandatory: t.mandatory };
}

// ── Pendências (compartilhado com o bloqueio do sistema) ───────────────────
export async function getPendingTrainings(uid: number, role: string, tenantId: number) {
  const all = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.active, true), eq(trainingsTable.tenantId, tenantId)));
  const target = all.filter((t) => (t.targetRoles as string[]).includes(role));
  if (target.length === 0) return [];
  const done = await db.select({ trainingId: trainingCompletionsTable.trainingId })
    .from(trainingCompletionsTable)
    .where(and(
      eq(trainingCompletionsTable.userId, uid),
      inArray(trainingCompletionsTable.trainingId, target.map((t) => t.id)),
    ));
  const doneSet = new Set(done.map((d) => d.trainingId));
  const pending = target.filter((t) => !doneSet.has(t.id));
  if (pending.length === 0) return [];
  // Rascunho em andamento ("Continuar de onde parou") mesmo dentro da trava
  // de obrigatório — sem isso, um quiz longo interrompido reiniciaria do zero.
  const drafts = await db.select({ trainingId: trainingProgressTable.trainingId, answers: trainingProgressTable.answers })
    .from(trainingProgressTable)
    .where(and(eq(trainingProgressTable.userId, uid), inArray(trainingProgressTable.trainingId, pending.map((t) => t.id))));
  const draftMap = new Map(drafts.map((d) => [d.trainingId, d.answers]));
  return pending.map((t) => ({ ...stripAnswers(t), draftAnswers: draftMap.get(t.id) ?? null }));
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
// treinamento OU questionário pendente (as duas travas compartilham a lista).
export const GATE_ALLOWLIST = [
  /^\/auth\//,
  /^\/checklists\/pending$/, /^\/checklists\/\d+\/respond$/,
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
  const { title, description, type, content, quiz, targetRoles, mandatory, active } = req.body ?? {};
  const tt = typeof title === "string" ? title.trim().slice(0, 150) : "";
  if (!tt) { res.status(400).json({ error: "Informe o título" }); return; }
  const ty = VALID_TYPES.includes(type) ? type : "text";
  const roles = sanitizeRoles(targetRoles);
  if (!roles) { res.status(400).json({ error: "Escolha pelo menos uma função" }); return; }
  let qz: QuizQuestion[] | null = null;
  let ct: string | null = null;
  if (ty === "quiz") {
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
    type: ty, content: ct, quiz: qz, targetRoles: roles,
    mandatory: mandatory !== false, active: active !== false,
    createdBy: req.session.userId!,
  }).returning();
  blockCache.clear();
  res.status(201).json(created);
});

router.patch("/trainings/:id", requireAdminOrSupervisor, requireModuleAccess("treinamentos"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { title, description, type, content, quiz, targetRoles, mandatory, active } = req.body ?? {};
  const update: Record<string, unknown> = {};
  if (title !== undefined) {
    const tt = typeof title === "string" ? title.trim().slice(0, 150) : "";
    if (!tt) { res.status(400).json({ error: "Informe o título" }); return; }
    update.title = tt;
  }
  if (description !== undefined) update.description = typeof description === "string" ? description.trim().slice(0, 500) || null : null;

  // Valida o registro FINAL (tipo + conteúdo + quiz coerentes entre si).
  const [existing] = await db.select().from(trainingsTable)
    .where(and(eq(trainingsTable.id, id), eq(trainingsTable.tenantId, tenantId)));
  if (!existing) { res.status(404).json({ error: "Treinamento não encontrado" }); return; }
  const finalType = type !== undefined && VALID_TYPES.includes(type) ? type : existing.type;
  update.type = finalType;
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
      createdAt: trainingCompletionsTable.createdAt,
    })
    .from(trainingCompletionsTable)
    .leftJoin(usersTable, eq(trainingCompletionsTable.userId, usersTable.id))
    .where(eq(trainingCompletionsTable.trainingId, id))
    .orderBy(desc(trainingCompletionsTable.createdAt))
    .limit(500);
  res.json(rows);
});

export default router;
