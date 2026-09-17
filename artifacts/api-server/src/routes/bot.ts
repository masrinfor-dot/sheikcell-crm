import { Router, type IRouter } from "express";
import { db, botSettingsTable, botStatesTable, conversationsTable, kbSuggestionsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { getBotSettings, toEngineSettings, todayUsage, aiClassify } from "../lib/bot";
import { mergeIntoKnowledgeBase, MAX_KB_CHARS } from "../lib/knowledgeLearning";
import { botStep, type BotStateShape, type BotQuestion } from "../lib/botEngine";

const router: IRouter = Router();

function sanitizeQuestions(v: unknown): BotQuestion[] | null {
  if (!Array.isArray(v)) return null;
  const out: BotQuestion[] = [];
  for (const q of v.slice(0, 10)) {
    const question = String((q as Record<string, unknown>)?.["question"] ?? "").trim();
    if (!question) continue;
    const rawOpts = (q as Record<string, unknown>)?.["options"];
    const options = Array.isArray(rawOpts)
      ? rawOpts.map((o) => String(o).trim()).filter(Boolean).slice(0, 10)
      : undefined;
    out.push(options && options.length ? { question: question.slice(0, 300), options } : { question: question.slice(0, 300) });
  }
  return out;
}

router.get("/bot/settings", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const s = await getBotSettings(tenantId);
  res.json({ ...s, usageToday: await todayUsage(tenantId) });
});

router.put("/bot/settings", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const existing = await getBotSettings(tenantId);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const questions = body["questions"] !== undefined
    ? sanitizeQuestions(body["questions"])
    : (existing.questions as BotQuestion[]);
  if (questions === null) { res.status(400).json({ error: "Perguntas inválidas" }); return; }

  const mode = String(body["mode"] ?? existing.mode);
  if (!["always", "off_hours"].includes(mode)) { res.status(400).json({ error: "Modo inválido" }); return; }

  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const hoursStart = String(body["hoursStart"] ?? existing.hoursStart);
  const hoursEnd = String(body["hoursEnd"] ?? existing.hoursEnd);
  if (!timeRe.test(hoursStart) || !timeRe.test(hoursEnd)) { res.status(400).json({ error: "Horário inválido (use HH:MM)" }); return; }

  const maxPerConversation = parseInt(String(body["maxPerConversation"] ?? existing.maxPerConversation), 10);
  const maxPerDay = parseInt(String(body["maxPerDay"] ?? existing.maxPerDay), 10);
  if (!Number.isFinite(maxPerConversation) || maxPerConversation < 0 || maxPerConversation > 50) { res.status(400).json({ error: "Limite por conversa deve ser de 0 a 50" }); return; }
  if (!Number.isFinite(maxPerDay) || maxPerDay < 0 || maxPerDay > 5000) { res.status(400).json({ error: "Limite por dia deve ser de 0 a 5000" }); return; }

  // "Tempo de resposta digitando" (pedido 16/09) — segundos, configurável por
  // loja, 0 a 30 (0 = sem atraso extra, só o que a ponte do WhatsApp já faz).
  const typingDelaySeconds = parseInt(String(body["typingDelaySeconds"] ?? existing.typingDelaySeconds), 10);
  if (!Number.isFinite(typingDelaySeconds) || typingDelaySeconds < 0 || typingDelaySeconds > 30) { res.status(400).json({ error: "Tempo de resposta deve ser de 0 a 30 segundos" }); return; }

  const str = (k: string, cur: string, max: number) => String(body[k] ?? cur).trim().slice(0, max);

  const [updated] = await db.update(botSettingsTable).set({
    enabled: body["enabled"] !== undefined ? body["enabled"] === true : existing.enabled,
    botName: str("botName", existing.botName, 60) || "Assistente",
    greeting: str("greeting", existing.greeting, 1000) || existing.greeting,
    doneMessage: str("doneMessage", existing.doneMessage, 1000) || existing.doneMessage,
    handoffMessage: str("handoffMessage", existing.handoffMessage, 1000) || existing.handoffMessage,
    // Limite subiu de 15000 pra 30000 (16/09): base de conhecimento real da
    // loja (persona + regras de tom + direcionamento por setor + triagem)
    // passou dos 15000 e estava sendo cortada no meio de frase ao salvar,
    // sem aviso nenhum pro admin — folga generosa pra caber crescimento
    // futuro sem precisar mexer aqui de novo.
    knowledgeBase: String(body["knowledgeBase"] ?? existing.knowledgeBase).trim().slice(0, 30000),
    urgencyWords: str("urgencyWords", existing.urgencyWords, 500),
    questions,
    mode,
    hoursStart,
    hoursEnd,
    maxPerConversation,
    maxPerDay,
    typingDelaySeconds,
    // "Aprender com atendimentos" (pedido 16/09) — liga/desliga a geração
    // automática de sugestões de conhecimento a partir de atendimentos
    // humanos finalizados. Ver lib/knowledgeLearning.ts.
    learningEnabled: body["learningEnabled"] !== undefined ? body["learningEnabled"] === true : existing.learningEnabled,
    // "Avaliação de usados por conversa" (pedido 17/09) — liga/desliga a
    // ferramenta evaluate_used_device do robô. Ver lib/bot.ts.
    tradeInEnabled: body["tradeInEnabled"] !== undefined ? body["tradeInEnabled"] === true : existing.tradeInEnabled,
    updatedAt: new Date(),
  }).where(and(eq(botSettingsTable.id, existing.id), eq(botSettingsTable.tenantId, tenantId))).returning();

  res.json({ ...updated, usageToday: await todayUsage(tenantId) });
});

// ---------- caixa de IA da base de conhecimento (pedido 16/09, prévia pedido 17/09) ----------
// Admin cola informação nova/solta (ou corrige algo) numa caixa acima da
// base; a IA reorganiza e junta com a base já existente, sem duplicar. Este
// endpoint SÓ GERA A PRÉVIA — nunca salva sozinho ("ante de enviar pra base
// de conhecimento mostra como vai ficar... pra aprovar ou não ou corrigir").
// O admin revisa (e pode corrigir) o texto devolvido aqui; salvar de fato é
// um PUT /bot/settings normal, feito pelo front só depois que o admin aprova.
router.post("/bot/knowledge/merge", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const text = String((req.body as { text?: unknown } | undefined)?.text ?? "").trim();
  if (!text) { res.status(400).json({ error: "Escreva a informação que quer adicionar" }); return; }
  if (text.length > 6000) { res.status(400).json({ error: "Texto muito longo — envie em partes menores (até 6000 caracteres)" }); return; }

  const existing = await getBotSettings(tenantId);
  const merged = await mergeIntoKnowledgeBase(tenantId, existing.knowledgeBase, text);
  res.json({ knowledgeBase: merged });
});

// ---------- sugestões de conhecimento (aprendizado com atendimentos) ----------

router.get("/bot/knowledge/suggestions", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const statusParam = String(req.query.status ?? "pending");
  const status = ["pending", "approved", "rejected"].includes(statusParam) ? statusParam : "pending";
  const rows = await db.select().from(kbSuggestionsTable)
    .where(and(eq(kbSuggestionsTable.tenantId, tenantId), eq(kbSuggestionsTable.status, status)))
    .orderBy(desc(kbSuggestionsTable.createdAt))
    .limit(100);
  res.json(rows);
});

// Prévia da fusão da sugestão na base — não salva, não marca aprovada. Mesmo
// motivo da prévia manual acima: o admin revisa (e pode corrigir) antes de
// confirmar.
router.post("/bot/knowledge/suggestions/:id/preview", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [suggestion] = await db.select().from(kbSuggestionsTable)
    .where(and(eq(kbSuggestionsTable.id, id), eq(kbSuggestionsTable.tenantId, tenantId))).limit(1);
  if (!suggestion) { res.status(404).json({ error: "Sugestão não encontrada" }); return; }

  const existing = await getBotSettings(tenantId);
  const merged = await mergeIntoKnowledgeBase(tenantId, existing.knowledgeBase, suggestion.suggestion);
  res.json({ knowledgeBase: merged });
});

// Aprovar: SALVA na base + marca aprovada. Recebe no corpo o texto já
// revisado (prévia acima, possivelmente corrigida pelo admin) — sem
// "knowledgeBase" no corpo, recalcula a fusão na hora (aprovar direto, sem
// passar pela prévia). Rejeitar: só marca, nunca mexe na base.
router.post("/bot/knowledge/suggestions/:id/approve", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const uid = req.session.userId!;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [suggestion] = await db.select().from(kbSuggestionsTable)
    .where(and(eq(kbSuggestionsTable.id, id), eq(kbSuggestionsTable.tenantId, tenantId))).limit(1);
  if (!suggestion) { res.status(404).json({ error: "Sugestão não encontrada" }); return; }
  if (suggestion.status !== "pending") { res.status(400).json({ error: "Essa sugestão já foi revisada" }); return; }

  const existing = await getBotSettings(tenantId);
  const reviewedText = (req.body as { knowledgeBase?: unknown } | undefined)?.knowledgeBase;
  const merged = typeof reviewedText === "string" && reviewedText.trim()
    ? reviewedText.trim().slice(0, MAX_KB_CHARS)
    : await mergeIntoKnowledgeBase(tenantId, existing.knowledgeBase, suggestion.suggestion);
  await db.update(botSettingsTable).set({ knowledgeBase: merged, updatedAt: new Date() })
    .where(and(eq(botSettingsTable.id, existing.id), eq(botSettingsTable.tenantId, tenantId)));
  const [updatedSuggestion] = await db.update(kbSuggestionsTable)
    .set({ status: "approved", reviewedBy: uid, reviewedAt: new Date() })
    .where(and(eq(kbSuggestionsTable.id, id), eq(kbSuggestionsTable.tenantId, tenantId)))
    .returning();

  res.json({ suggestion: updatedSuggestion, knowledgeBase: merged });
});

router.post("/bot/knowledge/suggestions/:id/reject", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const uid = req.session.userId!;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [updatedSuggestion] = await db.update(kbSuggestionsTable)
    .set({ status: "rejected", reviewedBy: uid, reviewedAt: new Date() })
    .where(and(eq(kbSuggestionsTable.id, id), eq(kbSuggestionsTable.tenantId, tenantId), eq(kbSuggestionsTable.status, "pending")))
    .returning();
  if (!updatedSuggestion) { res.status(404).json({ error: "Sugestão não encontrada ou já revisada" }); return; }
  res.json({ suggestion: updatedSuggestion });
});

// Estatísticas simples: conversas triadas pelo robô (só da loja do usuário).
// bot_states não tem tenantId — escopamos pela conversa (parent) via join.
router.get("/bot/stats", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [row] = await db.select({
    total: sql<number>`count(*)::int`,
    active: sql<number>`count(*) filter (where ${botStatesTable.active})::int`,
  })
    .from(botStatesTable)
    .innerJoin(conversationsTable, eq(botStatesTable.conversationId, conversationsTable.id))
    .where(eq(conversationsTable.tenantId, tenantId));
  res.json({ conversations: row?.total ?? 0, activeFlows: row?.active ?? 0, usageToday: await todayUsage(tenantId) });
});

// ---------- modo teste (simulação, sem WhatsApp e sem banco de conversas) ----------

const testStates = new Map<number, BotStateShape>();
// Transcrição simulada por admin testando (pedido 16/09: "o teste com IA
// precisa melhorar" — sem isso, cada resposta de IA no teste era cega ao que
// já tinha sido "dito" na simulação, igual ao bug que existia em produção).
type TestHistoryMsg = { role: "user" | "assistant"; content: string };
const testHistories = new Map<number, TestHistoryMsg[]>();

router.post("/bot/test", requireModuleAccess("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const uid = req.session.userId!;
  const { message, reset } = (req.body ?? {}) as { message?: string; reset?: boolean };
  if (reset) { testStates.delete(uid); testHistories.delete(uid); res.json({ replies: [], reset: true }); return; }
  const text = String(message ?? "").trim();
  if (!text) { res.status(400).json({ error: "Escreva uma mensagem de teste" }); return; }

  const settings = await getBotSettings(tenantId);
  const state = testStates.get(uid) ?? { stage: 0, answers: [], aiReplies: 0, active: true };
  const history = testHistories.get(uid) ?? [];
  history.push({ role: "user", content: text.slice(0, 800) });
  const { step, state: next } = botStep(toEngineSettings(settings), state, text);
  testStates.set(uid, next);

  const pushReplies = (replies: string[]) => {
    for (const r of replies) history.push({ role: "assistant", content: r.slice(0, 800) });
    testHistories.set(uid, history);
  };

  if (step.kind === "silent") {
    res.json({ replies: ["(robô ficou em silêncio — fluxo encerrado ou limite de IA atingido)"], simulated: true });
    return;
  }
  if (step.kind === "reply" || step.kind === "handoff") {
    pushReplies(step.replies);
    res.json({ replies: step.replies, ended: step.kind === "handoff", simulated: true });
    return;
  }
  if (step.kind === "triage_done") {
    // Modo teste: sem conversa real, então sem ferramenta de roteamento
    // (nada pra mudar de setor de verdade) — conversationId null desliga isso.
    const { summary } = await aiClassify(tenantId, null, settings, step.answers);
    pushReplies(step.replies);
    res.json({ replies: [...step.replies, `— [interno] Resumo para o vendedor: ${summary}`], simulated: true });
    return;
  }
  // ai_question no teste: responde de verdade com a base de conhecimento,
  // já com a transcrição simulada até aqui como histórico (mesma lógica de
  // aiAnswer em lib/bot.ts, só que sem gravar nada no banco).
  const { getOpenAiClientForTenant } = await import("../lib/aiClient");
  const openai = await getOpenAiClientForTenant(tenantId);
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 300,
      messages: [
        { role: "system", content: `Você é ${settings.botName}, assistente virtual de uma loja de celulares no WhatsApp. Responda em português, curto e simpático, SOMENTE com base nas informações abaixo. Se não souber, diga que vai verificar com a equipe.\n\nINFORMAÇÕES DA LOJA:\n${settings.knowledgeBase || "(nenhuma informação cadastrada)"}${history.length > 1 ? `\n\nAs mensagens anteriores desta conversa simulada estão no histórico abaixo — nunca repita uma pergunta que o cliente já respondeu ali.` : ""}` },
        // history já inclui a mensagem atual (foi empurrada logo no início) —
        // manda tudo exceto o último item, que vira a mensagem "user" final.
        ...history.slice(0, -1).map((h) => ({ role: h.role, content: h.content }) as const),
        { role: "user", content: step.question },
      ],
    });
    const reply = completion.choices[0]?.message?.content?.trim() ?? "(sem resposta)";
    testStates.set(uid, { ...next, aiReplies: next.aiReplies + 1 });
    pushReplies([reply]);
    res.json({ replies: [reply], simulated: true });
  } catch {
    res.status(503).json({ error: "IA indisponível no momento — confira a chave da OpenAI" });
  }
});

export default router;
