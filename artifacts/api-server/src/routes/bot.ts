import { Router, type IRouter } from "express";
import { db, botSettingsTable, botStatesTable, conversationsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireFeature, requireTenant } from "../middlewares/auth";
import { getBotSettings, toEngineSettings, todayUsage, aiClassify } from "../lib/bot";
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

router.get("/bot/settings", requireFeature("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const s = await getBotSettings(tenantId);
  res.json({ ...s, usageToday: await todayUsage(tenantId) });
});

router.put("/bot/settings", requireFeature("robo"), async (req, res): Promise<void> => {
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

  const str = (k: string, cur: string, max: number) => String(body[k] ?? cur).trim().slice(0, max);

  const [updated] = await db.update(botSettingsTable).set({
    enabled: body["enabled"] !== undefined ? body["enabled"] === true : existing.enabled,
    botName: str("botName", existing.botName, 60) || "Assistente",
    greeting: str("greeting", existing.greeting, 1000) || existing.greeting,
    doneMessage: str("doneMessage", existing.doneMessage, 1000) || existing.doneMessage,
    handoffMessage: str("handoffMessage", existing.handoffMessage, 1000) || existing.handoffMessage,
    knowledgeBase: String(body["knowledgeBase"] ?? existing.knowledgeBase).trim().slice(0, 15000),
    urgencyWords: str("urgencyWords", existing.urgencyWords, 500),
    questions,
    mode,
    hoursStart,
    hoursEnd,
    maxPerConversation,
    maxPerDay,
    updatedAt: new Date(),
  }).where(and(eq(botSettingsTable.id, existing.id), eq(botSettingsTable.tenantId, tenantId))).returning();

  res.json({ ...updated, usageToday: await todayUsage(tenantId) });
});

// Estatísticas simples: conversas triadas pelo robô (só da loja do usuário).
// bot_states não tem tenantId — escopamos pela conversa (parent) via join.
router.get("/bot/stats", requireFeature("robo"), async (req, res): Promise<void> => {
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

router.post("/bot/test", requireFeature("robo"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const uid = req.session.userId!;
  const { message, reset } = (req.body ?? {}) as { message?: string; reset?: boolean };
  if (reset) { testStates.delete(uid); res.json({ replies: [], reset: true }); return; }
  const text = String(message ?? "").trim();
  if (!text) { res.status(400).json({ error: "Escreva uma mensagem de teste" }); return; }

  const settings = await getBotSettings(tenantId);
  const state = testStates.get(uid) ?? { stage: 0, answers: [], aiReplies: 0, active: true };
  const { step, state: next } = botStep(toEngineSettings(settings), state, text);
  testStates.set(uid, next);

  if (step.kind === "silent") {
    res.json({ replies: ["(robô ficou em silêncio — fluxo encerrado ou limite de IA atingido)"], simulated: true });
    return;
  }
  if (step.kind === "reply" || step.kind === "handoff") {
    res.json({ replies: step.replies, ended: step.kind === "handoff", simulated: true });
    return;
  }
  if (step.kind === "triage_done") {
    const { summary } = await aiClassify(tenantId, settings, step.answers);
    res.json({ replies: [...step.replies, `— [interno] Resumo para o vendedor: ${summary}`], simulated: true });
    return;
  }
  // ai_question no teste: responde de verdade com a base de conhecimento
  const { openai } = await import("@workspace/integrations-openai-ai");
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 300,
      messages: [
        { role: "system", content: `Você é ${settings.botName}, assistente virtual de uma loja de celulares no WhatsApp. Responda em português, curto e simpático, SOMENTE com base nas informações abaixo. Se não souber, diga que vai verificar com a equipe.\n\nINFORMAÇÕES DA LOJA:\n${settings.knowledgeBase || "(nenhuma informação cadastrada)"}` },
        { role: "user", content: step.question },
      ],
    });
    testStates.set(uid, { ...next, aiReplies: next.aiReplies + 1 });
    res.json({ replies: [completion.choices[0]?.message?.content?.trim() ?? "(sem resposta)"], simulated: true });
  } catch {
    res.status(503).json({ error: "IA indisponível no momento — confira a chave da OpenAI" });
  }
});

export default router;
