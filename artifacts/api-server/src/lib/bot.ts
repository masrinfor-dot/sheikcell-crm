// Robô de pré-atendimento: liga a máquina de estados (botEngine) ao banco,
// ao WhatsApp e à IA. Nunca lança — falha do robô não pode derrubar o webhook.
import { and, eq, sql } from "drizzle-orm";
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
import { runBotAgent, type BotTool } from "./botTools";

const DEFAULT_QUESTIONS: BotQuestion[] = [
  { question: "Para começar, o que você procura hoje?", options: ["Comprar um celular", "Assistência técnica / conserto", "Película ou acessórios", "Outro assunto"] },
  { question: "Pode me contar um pouco mais? (modelo do aparelho, o que aconteceu, ou o que procura)" },
];

export type BotSettingsRow = typeof botSettingsTable.$inferSelect;

/**
 * Busca (ou cria) a linha de configuração do robô da loja (tenant).
 * Multi-loja: cada loja tem sua própria configuração — a leitura e a criação
 * são sempre escopadas pelo tenantId (a loja 1 mantém a config legada).
 */
export async function getBotSettings(tenantId: number): Promise<BotSettingsRow> {
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.tenantId, tenantId)).limit(1);
  if (row) return row;
  await db.insert(botSettingsTable)
    .values({ tenantId, questions: DEFAULT_QUESTIONS })
    .onConflictDoNothing();
  const [created] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.tenantId, tenantId)).limit(1);
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

/** Tenta consumir 1 resposta de IA do limite diário da loja. Retorna false se estourou. */
async function consumeDailyAi(tenantId: number, maxPerDay: number): Promise<boolean> {
  const day = todaySP();
  const [row] = await db.insert(botUsageTable)
    .values({ tenantId, day, count: 1 })
    .onConflictDoUpdate({
      target: [botUsageTable.tenantId, botUsageTable.day],
      set: { count: sql`${botUsageTable.count} + 1` },
      setWhere: sql`${botUsageTable.count} < ${maxPerDay}`,
    })
    .returning();
  return !!row; // sem linha = limite do dia estourado
}

export async function todayUsage(tenantId: number): Promise<number> {
  const [row] = await db.select().from(botUsageTable)
    .where(and(eq(botUsageTable.day, todaySP()), eq(botUsageTable.tenantId, tenantId)))
    .limit(1);
  return row?.count ?? 0;
}

// ---------- horário ----------

function withinBusinessHours(s: BotSettingsRow): boolean {
  const hm = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
  return hm >= s.hoursStart && hm < s.hoursEnd;
}

// ---------- roteamento por setor (ferramenta do robô) ----------

// Muda o setor da conversa e avisa em tempo real — igual ao que a
// transferência manual (PATCH /chat/conversations/:id) faz para esse mesmo
// campo. Não reproduz o resto daquela rota (reatribuir responsável, status
// "pending" etc.): o robô só atua em conversas SEM responsável (ver
// botWouldHandle), então essa parte não se aplica aqui.
async function changeSector(conversationId: number, sectorId: number): Promise<void> {
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  if (!conv || conv.sectorId === sectorId) return;
  const [updated] = await db.update(conversationsTable).set({ sectorId, updatedAt: new Date() })
    .where(eq(conversationsTable.id, conversationId)).returning();
  const next = updated ?? { ...conv, sectorId };
  broadcast("conversation_updated", next, {
    tenantId: next.tenantId,
    sectorId: next.sectorId,
    sessionKey: next.sessionKey,
    isPotential: isPotentialConversation(conv) || isPotentialConversation(next),
    restrictedTo: await restrictedRecipients(next),
  });
}

/**
 * Ferramenta de roteamento: o modelo chama isso a qualquer momento em que
 * identificar (ou corrigir) o setor certo pra conversa — não só uma vez no
 * fim do questionário fixo. `sector` é restrito por enum aos setores ativos
 * da loja, então não há fuzzy-match de nome como na versão anterior.
 */
export function routeToSectorTool(sectors: { id: number; name: string }[]): BotTool {
  return {
    name: "route_to_sector",
    description: "Direciona a conversa para o setor certo assim que entender o que o cliente precisa (não precisa esperar o cliente responder tudo). Pode chamar de novo mais tarde se o assunto mudar.",
    parameters: {
      type: "object",
      properties: {
        sector: { type: "string", enum: sectors.map((s) => s.name), description: "Nome exato do setor mais adequado" },
      },
      required: ["sector"],
    },
    execute: async (args, ctx) => {
      const name = String(args["sector"] ?? "");
      const match = sectors.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!match) return `Setor "${name}" não existe. Setores válidos: ${sectors.map((s) => s.name).join(", ")}.`;
      await changeSector(ctx.conversationId, match.id);
      return `Conversa direcionada para o setor "${match.name}".`;
    },
  };
}

// ---------- IA ----------

async function aiAnswer(tenantId: number, conversationId: number | null, settings: BotSettingsRow, question: string): Promise<string | null> {
  try {
    const sectors = conversationId != null
      ? await db.select({ id: sectorsTable.id, name: sectorsTable.name })
          .from(sectorsTable).where(and(eq(sectorsTable.isActive, true), eq(sectorsTable.tenantId, tenantId)))
      : [];
    const { replyText } = await runBotAgent({
      maxTokens: 300,
      systemPrompt: `Você é ${settings.botName}, assistente virtual de uma loja de celulares no WhatsApp. Responda em português, curto e simpático. Responda SOMENTE com base nas informações abaixo. Se a resposta não estiver nas informações, diga que vai verificar com a equipe e que um atendente já vai falar com o cliente. Nunca invente preços, prazos ou promoções.\n\nINFORMAÇÕES DA LOJA:\n${settings.knowledgeBase || "(nenhuma informação cadastrada)"}${sectors.length > 0 ? `\n\nSe perceber, pela pergunta do cliente, que o assunto é de outro setor (diferente do setor atual da conversa), chame a ferramenta route_to_sector pra corrigir — só quando tiver razoável confiança.` : ""}`,
      userMessage: question,
      tools: sectors.length > 0 ? [routeToSectorTool(sectors)] : [],
      ctx: { tenantId, conversationId: conversationId ?? 0 },
    });
    return replyText;
  } catch (err) {
    logger.warn({ err }, "Robô: falha na resposta de IA");
    return null;
  }
}

export async function aiClassify(tenantId: number, conversationId: number | null, settings: BotSettingsRow, answers: string[]): Promise<{ summary: string }> {
  // Multi-loja: só considera os setores DESTA loja na triagem.
  const sectors = await db.select({ id: sectorsTable.id, name: sectorsTable.name })
    .from(sectorsTable).where(and(eq(sectorsTable.isActive, true), eq(sectorsTable.tenantId, tenantId)));
  const qs = toEngineSettings(settings).questions;
  const qa = qs.map((q, i) => `P: ${q.question}\nR: ${answers[i] ?? "(sem resposta)"}`).join("\n");
  try {
    const { replyText } = await runBotAgent({
      maxTokens: 200,
      systemPrompt: `Você faz a triagem de clientes de uma loja de celulares. Leia as respostas do cliente e: 1) responda com um resumo de 1-2 frases (em português) do que o cliente quer, pro atendente humano ler rápido; 2) se conseguir identificar com razoável confiança qual setor deve atender, chame a ferramenta route_to_sector. Setores disponíveis: ${sectors.map((s) => s.name).join(", ") || "(nenhum)"}.`,
      userMessage: qa,
      tools: conversationId != null && sectors.length > 0 ? [routeToSectorTool(sectors)] : [],
      ctx: { tenantId, conversationId: conversationId ?? 0 },
    });
    const summary = (replyText || answers.join(" | ")).slice(0, 500);
    return { summary };
  } catch (err) {
    logger.warn({ err }, "Robô: falha na classificação");
    return { summary: answers.join(" | ").slice(0, 500) };
  }
}

// ---------- fluxo principal ----------

// Fila por conversa: mensagens rápidas em sequência são processadas em ordem,
// uma por vez — nenhuma é descartada (ex.: cliente manda "2" e logo em seguida
// "quero falar com atendente").
const queues = new Map<number, Promise<void>>();

type Conv = typeof conversationsTable.$inferSelect;

/** Chamado pelo webhook a cada mensagem recebida. Nunca lança. */
/**
 * Checagem BARATA de elegibilidade do robô, sem efeitos colaterais. Usada
 * antes de gastar com transcrição de áudio: se o robô não fosse responder,
 * não pagamos o Whisper à toa.
 */
export async function botWouldHandle(conv: Conv): Promise<boolean> {
  if (conv.channel !== "whatsapp") return false;
  if (conv.assigneeId != null) return false;
  if (conv.status === "resolved" || conv.status === "archived") return false;
  const settings = await getBotSettings(conv.tenantId);
  if (!settings.enabled) return false;
  if (settings.mode === "off_hours" && withinBusinessHours(settings)) return false;
  const [state] = await db.select({ active: botStatesTable.active })
    .from(botStatesTable).where(eq(botStatesTable.conversationId, conv.id));
  return state ? state.active : true; // sem estado ainda = conversa nova, robô atende
}

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

  const tenantId = conv.tenantId;
  const settings = await getBotSettings(tenantId);
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
    // A própria classificação pode rotear o setor (ferramenta route_to_sector,
    // já com seu próprio update+broadcast) — recarrega a conversa depois pra
    // escopar a mensagem de resumo abaixo pro setor certo.
    const canUseAi = await consumeDailyAi(tenantId, settings.maxPerDay);
    const { summary } = canUseAi
      ? await aiClassify(tenantId, conv.id, settings, step.answers)
      : { summary: step.answers.join(" | ").slice(0, 500) };
    await db.update(botStatesTable).set({ summary }).where(eq(botStatesTable.id, state.id));
    const [freshConv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv.id));
    if (freshConv) conv = freshConv;
    // Mensagem interna (type system) — o vendedor vê o resumo, o cliente não recebe.
    const [sysMsg] = await db.insert(messagesTable).values({
      tenantId: conv.tenantId,
      conversationId: conv.id,
      content: `🤖 Triagem do robô: ${summary}`,
      direction: "outbound",
      type: "system",
      status: "sent",
      senderName: settings.botName,
    }).returning();
    broadcast("message", { conversationId: conv.id, message: sysMsg },
      { tenantId: conv.tenantId, sectorId: conv.sectorId, sessionKey: conv.sessionKey, isPotential: isPotentialConversation(conv), restrictedTo: await restrictedRecipients(conv) });
    return;
  }

  // ai_question: dúvida livre pós-triagem
  if (!(await consumeDailyAi(tenantId, settings.maxPerDay))) { await saveState(); return; }
  const answer = await aiAnswer(tenantId, conv.id, settings, step.question);
  await saveState({ aiReplies: state.aiReplies + 1 });
  if (answer) await sendOutboundText(conv.id, answer, settings.botName);
}
