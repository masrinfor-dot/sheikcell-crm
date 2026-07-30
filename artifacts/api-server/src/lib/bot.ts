// Robô de pré-atendimento: liga a máquina de estados (botEngine) ao banco,
// ao WhatsApp e à IA. Nunca lança — falha do robô não pode derrubar o webhook.
import { eq, sql } from "drizzle-orm";
import {
  db,
  botSettingsTable,
  botStatesTable,
  botUsageTable,
  conversationsTable,
  messagesTable,
  sectorsTable,
} from "@workspace/db";
import { botStep, type BotSettingsShape, type BotQuestion } from "./botEngine";
import { sendOutboundText } from "./outbound";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients } from "./conversationScope";
import { logger } from "./logger";

const DEFAULT_QUESTIONS: BotQuestion[] = [
  { question: "Para começar, o que você procura hoje?", options: ["Comprar um celular", "Assistência técnica / conserto", "Película ou acessórios", "Outro assunto"] },
  { question: "Pode me contar um pouco mais? (modelo do aparelho, o que aconteceu, ou o que procura)" },
];

export type BotSettingsRow = typeof botSettingsTable.$inferSelect;

/**
 * Busca (ou cria) a linha única de configuração do robô.
 * A linha sempre tem id=1: o insert com id fixo + onConflictDoNothing garante
 * o singleton mesmo com dois processos criando ao mesmo tempo, e a leitura
 * por id=1 é determinística.
 */
export async function getBotSettings(): Promise<BotSettingsRow> {
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1));
  if (row) return row;
  await db.insert(botSettingsTable)
    .values({ id: 1, questions: DEFAULT_QUESTIONS })
    .onConflictDoNothing();
  const [created] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1));
  return created!;
}

export function toEngineSettings(s: BotSettingsRow): BotSettingsShape {
  const qs = Array.isArray(s.questions) ? (s.questions as BotQuestion[]) : [];
  return {
    botName: s.botName,
    greeting: s.greeting,
    questions: qs,
    knowledgeBase: s.knowledgeBase,
    doneMessage: s.doneMessage,
    handoffMessage: s.handoffMessage,
    urgencyWords: s.urgencyWords,
    maxPerConversation: s.maxPerConversation,
  };
}

// ---------- controle de custo diário ----------

function todaySP(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Tenta consumir 1 resposta de IA do limite diário. Retorna false se estourou. */
async function consumeDailyAi(maxPerDay: number): Promise<boolean> {
  const day = todaySP();
  const [row] = await db.insert(botUsageTable)
    .values({ day, count: 1 })
    .onConflictDoUpdate({
      target: botUsageTable.day,
      set: { count: sql`${botUsageTable.count} + 1` },
      setWhere: sql`${botUsageTable.count} < ${maxPerDay}`,
    })
    .returning();
  return !!row; // sem linha = limite do dia estourado
}

export async function todayUsage(): Promise<number> {
  const [row] = await db.select().from(botUsageTable).where(eq(botUsageTable.day, todaySP()));
  return row?.count ?? 0;
}

// ---------- horário ----------

function withinBusinessHours(s: BotSettingsRow): boolean {
  const hm = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
  return hm >= s.hoursStart && hm < s.hoursEnd;
}

// ---------- IA ----------

async function aiAnswer(settings: BotSettingsRow, question: string): Promise<string | null> {
  try {
    const { openai } = await import("@workspace/integrations-openai-ai");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `Você é ${settings.botName}, assistente virtual de uma loja de celulares no WhatsApp. Responda em português, curto e simpático. Responda SOMENTE com base nas informações abaixo. Se a resposta não estiver nas informações, diga que vai verificar com a equipe e que um atendente já vai falar com o cliente. Nunca invente preços, prazos ou promoções.\n\nINFORMAÇÕES DA LOJA:\n${settings.knowledgeBase || "(nenhuma informação cadastrada)"}`,
        },
        { role: "user", content: question },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.warn({ err }, "Robô: falha na resposta de IA");
    return null;
  }
}

export async function aiClassify(settings: BotSettingsRow, answers: string[]): Promise<{ summary: string; sectorId: number | null }> {
  const sectors = await db.select({ id: sectorsTable.id, name: sectorsTable.name })
    .from(sectorsTable).where(eq(sectorsTable.isActive, true));
  const qs = toEngineSettings(settings).questions;
  const qa = qs.map((q, i) => `P: ${q.question}\nR: ${answers[i] ?? "(sem resposta)"}`).join("\n");
  try {
    const { openai } = await import("@workspace/integrations-openai-ai");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Você triagem clientes de uma loja de celulares. Dadas as respostas do cliente, devolva um JSON: {"summary": "resumo de 1-2 frases do que o cliente quer, em português", "sector": "nome do setor mais adequado ou null"}. Setores disponíveis: ${sectors.map((s) => s.name).join(", ")}.`,
        },
        { role: "user", content: qa },
      ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { summary?: string; sector?: string | null };
    const summary = String(parsed.summary ?? "").slice(0, 500) || answers.join(" | ").slice(0, 500);
    const match = sectors.find((s) => s.name.toLowerCase() === String(parsed.sector ?? "").toLowerCase());
    return { summary, sectorId: match?.id ?? null };
  } catch (err) {
    logger.warn({ err }, "Robô: falha na classificação");
    return { summary: answers.join(" | ").slice(0, 500), sectorId: null };
  }
}

// ---------- fluxo principal ----------

// Fila por conversa: mensagens rápidas em sequência são processadas em ordem,
// uma por vez — nenhuma é descartada (ex.: cliente manda "2" e logo em seguida
// "quero falar com atendente").
const queues = new Map<number, Promise<void>>();

type Conv = typeof conversationsTable.$inferSelect;

/** Chamado pelo webhook a cada mensagem recebida. Nunca lança. */
export async function handleBotInbound(conv: Conv, text: string): Promise<void> {
  const prev = queues.get(conv.id) ?? Promise.resolve();
  const next = prev
    .then(() => handle(conv, text))
    .catch((err) => {
      logger.warn({ err, conversationId: conv.id }, "Robô: falha ao processar mensagem");
    });
  queues.set(conv.id, next);
  await next;
  if (queues.get(conv.id) === next) queues.delete(conv.id);
}

async function handle(conv: Conv, text: string): Promise<void> {
  if (conv.channel !== "whatsapp") return;
  if (conv.assigneeId != null) return; // vendedor já assumiu — robô fica quieto
  if (conv.status === "resolved" || conv.status === "archived") return;
  if (!text || !text.trim()) return;

  const settings = await getBotSettings();
  if (!settings.enabled) return;
  if (settings.mode === "off_hours" && withinBusinessHours(settings)) return;

  // estado da conversa
  let [state] = await db.select().from(botStatesTable).where(eq(botStatesTable.conversationId, conv.id));
  if (!state) {
    const [created] = await db.insert(botStatesTable)
      .values({ conversationId: conv.id, answers: [] })
      .onConflictDoNothing()
      .returning();
    state = created ?? (await db.select().from(botStatesTable).where(eq(botStatesTable.conversationId, conv.id)))[0];
    if (!state) return;
  }
  if (!state.active) return;

  const engineState = {
    stage: state.stage,
    answers: Array.isArray(state.answers) ? (state.answers as string[]) : [],
    aiReplies: state.aiReplies,
    active: state.active,
  };
  const { step, state: next } = botStep(toEngineSettings(settings), engineState, text);

  const saveState = (extra?: Partial<typeof botStatesTable.$inferInsert>) =>
    db.update(botStatesTable).set({
      stage: next.stage, answers: next.answers, active: next.active,
      updatedAt: new Date(), ...extra,
    }).where(eq(botStatesTable.id, state.id));

  if (step.kind === "silent") { await saveState(); return; }

  if (step.kind === "reply" || step.kind === "handoff") {
    await saveState();
    for (const r of step.replies) await sendOutboundText(conv.id, r, settings.botName);
    return;
  }

  if (step.kind === "triage_done") {
    await saveState();
    for (const r of step.replies) await sendOutboundText(conv.id, r, settings.botName);
    // Classifica com IA (respeitando o teto diário) e registra o resumo na conversa.
    const canUseAi = await consumeDailyAi(settings.maxPerDay);
    const { summary, sectorId } = canUseAi
      ? await aiClassify(settings, step.answers)
      : { summary: step.answers.join(" | ").slice(0, 500), sectorId: null };
    await db.update(botStatesTable).set({ summary }).where(eq(botStatesTable.id, state.id));
    if (sectorId != null && sectorId !== conv.sectorId) {
      await db.update(conversationsTable).set({ sectorId, updatedAt: new Date() })
        .where(eq(conversationsTable.id, conv.id));
      conv = { ...conv, sectorId };
    }
    // Mensagem interna (type system) — o vendedor vê o resumo, o cliente não recebe.
    const [sysMsg] = await db.insert(messagesTable).values({
      conversationId: conv.id,
      content: `🤖 Triagem do robô: ${summary}`,
      direction: "outbound",
      type: "system",
      status: "sent",
      senderName: settings.botName,
    }).returning();
    broadcast("message", { conversationId: conv.id, message: sysMsg }, conv.sectorId,
      isPotentialConversation(conv), await restrictedRecipients(conv));
    return;
  }

  // ai_question: dúvida livre pós-triagem
  if (!(await consumeDailyAi(settings.maxPerDay))) { await saveState(); return; }
  const answer = await aiAnswer(settings, step.question);
  await saveState({ aiReplies: state.aiReplies + 1 });
  if (answer) await sendOutboundText(conv.id, answer, settings.botName);
}
