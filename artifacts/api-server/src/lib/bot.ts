// Robô de pré-atendimento: liga a máquina de estados (botEngine) ao banco,
// ao WhatsApp e à IA. Nunca lança — falha do robô não pode derrubar o webhook.
import { and, eq, sql, isNull, lte, notInArray, desc } from "drizzle-orm";
import {
  db,
  botSettingsTable,
  botStatesTable,
  botUsageTable,
  conversationsTable,
  messagesTable,
  sectorsTable,
  chatLabelsTable,
  tradeInEvaluationsTable,
} from "@workspace/db";
import { botStep, type BotSettingsShape, type BotQuestion } from "./botEngine";
import { sendOutboundText } from "./outbound";
import { broadcast } from "./sseEmitter";
import { isPotentialConversation, restrictedRecipients, POTENTIAL_EXCLUDED_STATUSES } from "./conversationScope";
import { logger } from "./logger";
import { runBotAgent, type BotTool, type BotHistoryMessage } from "./botTools";
import { resolveOrCreateLabel, attachLabelToConversation } from "./labels";
import { validateTradeInAnswers, type QuestionsConfig as TradeInQuestionsConfig } from "./tradeInQuestions";
import { getQuestionsConfig as getTradeInQuestionsConfig } from "./tradeInConfig";
import { computeTradeInEstimate, type TradeInEstimate } from "./tradeInEstimate";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: "[imagem enviada pelo cliente]",
  video: "[vídeo enviado pelo cliente]",
  doc: "[documento enviado pelo cliente]",
  sticker: "[figurinha]",
  contact: "[contato compartilhado]",
  location: "[localização compartilhada]",
  poll: "[enquete]",
  product: "[produto compartilhado]",
  payment: "[pagamento]",
  group_invite: "[convite de grupo]",
};

/**
 * Últimas mensagens REAIS da conversa (mais antiga primeiro), pra dar
 * memória à IA entre uma chamada e outra — sem isso, cada resposta é cega ao
 * que já foi dito e o robô fica repetindo pergunta que o cliente já
 * respondeu (pedido 16/09: "o teste com IA precisa melhorar"). Exclui
 * mensagens internas (type "system"/"note" — ex.: o resumo de triagem, que o
 * cliente nunca viu) e a própria mensagem mais recente, já que ela é
 * repassada separadamente como a pergunta atual (userMessage).
 */
async function buildConversationHistory(conversationId: number, limit = 14): Promise<BotHistoryMessage[]> {
  try {
    const rows = await db.select({
      direction: messagesTable.direction,
      content: messagesTable.content,
      transcript: messagesTable.transcript,
      type: messagesTable.type,
      deletedAt: messagesTable.deletedAt,
    })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(limit + 1);
    const chronological = rows.reverse();
    // A última (mais recente) é a mensagem atual, já enviada como
    // userMessage — não duplica aqui.
    const withoutCurrent = chronological.slice(0, -1);
    const history: BotHistoryMessage[] = [];
    for (const m of withoutCurrent) {
      if (m.deletedAt) continue;
      if (m.type === "system" || m.type === "note") continue;
      const text = (m.type === "audio" ? (m.transcript || m.content) : m.content)
        || (m.type ? MEDIA_PLACEHOLDER[m.type] : undefined);
      if (!text || !text.trim()) continue;
      history.push({ role: m.direction === "inbound" ? "user" : "assistant", content: text.trim().slice(0, 800) });
    }
    return history;
  } catch (err) {
    logger.warn({ err, conversationId }, "Robô: falha ao montar histórico da conversa pra IA");
    return [];
  }
}

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

// ---------- etiquetas (ferramenta do robô) ----------

// Pedido 16/09: "permite que o robô com IA direcione para setores de forma
// automática, crie e utilize etiquetas, evita repetir etiqueta ou criar com
// semelhança". A lista de etiquetas já existentes vai na descrição da
// ferramenta (mesmo padrão do enum de setores), pra IA preferir reaproveitar
// uma existente — resolveOrCreateLabel (lib/labels.ts) é a rede de segurança
// do servidor caso o modelo peça um nome só levemente diferente.
function applyLabelTool(tenantId: number, existingLabels: { name: string }[]): BotTool {
  const namesList = existingLabels.map((l) => l.name).join(", ") || "(nenhuma ainda)";
  return {
    name: "apply_label",
    description: `Aplica uma etiqueta de assunto nesta conversa pra ajudar a equipe a organizar e filtrar depois (ex.: "Orçamento", "Reclamação", "Pós-venda"). IMPORTANTE: antes de usar um nome novo, veja se alguma das etiquetas já existentes já cobre o mesmo assunto — reaproveite o nome EXATO de uma existente sempre que fizer sentido, em vez de criar uma parecida com nome diferente (ex.: não crie "Orçamentos" se já existe "Orçamento"). Etiquetas já cadastradas nesta loja: ${namesList}. Só chame quando o assunto da conversa já estiver razoavelmente claro — não precisa etiquetar toda conversa, e pode chamar de novo se o assunto mudar.`,
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Nome curto da etiqueta (2-4 palavras), reaproveitando um nome já existente sempre que possível" },
      },
      required: ["label"],
    },
    execute: async (args, ctx) => {
      const requested = String(args["label"] ?? "").trim();
      if (!requested) return "Nome de etiqueta vazio — nada foi feito.";
      const resolved = await resolveOrCreateLabel(ctx.tenantId, requested);
      if (!resolved) return "Não consegui aplicar a etiqueta.";
      await attachLabelToConversation(ctx.conversationId, resolved.name);
      return resolved.created
        ? `Etiqueta nova "${resolved.name}" criada e aplicada.`
        : `Etiqueta existente "${resolved.name}" reaproveitada e aplicada (evitei criar uma parecida).`;
    },
  };
}

// ---------- avaliação de usados por conversa (ferramenta do robô) ----------

// Pedido 17/09: "avaliação de usados com ia, para ser feita por conversas
// também" — já existia avaliação feita pela equipe (Avaliação de Usados no
// CRM) e avaliação pública (cliente preenche formulário sozinho no site,
// sem login). Esta é a terceira porta de entrada: o próprio robô do
// WhatsApp conduz a conversa (marca/modelo/questionário de estado, uma
// pergunta por vez — segue as mesmas regras de tom da base de
// conhecimento) e, quando tiver tudo, chama esta ferramenta pra calcular
// a estimativa. Sempre se comporta como a avaliação pública: só estimativa,
// nunca pede CPF/IMEI/foto pelo chat, nunca fecha negócio sozinho — vira um
// lead (source="whatsapp_bot") na mesma tela "Avaliações de usado" pra um
// vendedor confirmar e fechar. Cálculo (tabela de valores base → IA como
// fallback) compartilhado com a avaliação pública em lib/tradeInEstimate.ts.
function evaluateUsedDeviceTool(questionsConfig: TradeInQuestionsConfig): BotTool {
  const describe = (list: TradeInQuestionsConfig["apple"]) =>
    list.map((q) => `- "${q.key}": ${q.label} — opções válidas (use o texto EXATO de uma delas): ${q.options.map((o) => `"${o.label}"`).join(", ")}`).join("\n");
  return {
    name: "evaluate_used_device",
    description: `Avalia um aparelho USADO que o cliente quer vender ou trocar por outro, dando uma estimativa de valor de compra — a mesma avaliação que já existe no site da loja, só que por conversa. Use quando o cliente quiser avaliar/trocar/vender o aparelho usado dele e você já tiver marca, modelo e as respostas de TODAS as perguntas do questionário de estado (pergunte uma de cada vez, do jeito natural que já é seu costume — não precisa despejar o questionário inteiro de uma vez). Preencha "answers" com a lista de perguntas certa pra marca (Apple ou Android), usando a CHAVE e o TEXTO EXATO de uma das opções de cada pergunta — se errar o texto, a ferramenta devolve um erro dizendo o que corrigir, e você tenta de novo.\n\nPerguntas pra aparelhos Apple/iPhone:\n${describe(questionsConfig.apple)}\n\nPerguntas pra aparelhos Android (Samsung, Motorola, Xiaomi etc.):\n${describe(questionsConfig.android)}`,
    parameters: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Marca do aparelho (ex.: Apple, Samsung, Motorola, Xiaomi)" },
        model: { type: "string", description: "Modelo (ex.: iPhone 13, Galaxy S22)" },
        memory: { type: "string", description: "Armazenamento, se o cliente informou (ex.: 128GB) — opcional" },
        color: { type: "string", description: "Cor, se o cliente informou — opcional, só de referência" },
        answers: {
          type: "object",
          description: "Respostas do questionário de estado: uma propriedade por pergunta (chave = a chave exata listada acima, valor = o texto exato de uma das opções daquela pergunta). Responda TODAS as perguntas da marca certa.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["brand", "model", "answers"],
    },
    execute: async (args, ctx) => {
      const brand = String(args["brand"] ?? "").trim().slice(0, 40);
      const model = String(args["model"] ?? "").trim().slice(0, 60);
      const memory = args["memory"] ? String(args["memory"]).trim().slice(0, 20) : null;
      const color = args["color"] ? String(args["color"]).trim().slice(0, 30) : null;
      if (!brand || !model) return "Faltam marca e modelo do aparelho — pergunte ao cliente antes de chamar de novo.";
      const rawAnswers = args["answers"];
      if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) return "Faltam as respostas do questionário de estado — responda todas as perguntas da marca certa antes de chamar de novo.";

      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>).slice(0, 30)) {
        if (typeof v === "string" && v.trim()) answers[k.trim().slice(0, 60)] = v.trim().slice(0, 200);
      }

      const isApple = /apple|iphone/i.test(brand);
      const questionList = isApple ? questionsConfig.apple : questionsConfig.android;
      const validation = validateTradeInAnswers(questionList, answers);
      if (!validation.ok) {
        if (validation.status === 422) {
          return `${validation.error} Não dá pra prosseguir com avaliação automática nesse caso — explique isso ao cliente com naturalidade e ofereça encaminhar pro setor Vendas de Celulares pra uma avaliação manual.`;
        }
        return `${validation.error} Corrija e chame a ferramenta de novo usando exatamente o texto de uma das opções válidas listadas.`;
      }

      let estimate: TradeInEstimate | null;
      try {
        estimate = await computeTradeInEstimate({ tenantId: ctx.tenantId, brand, model, memory, questionList, answers });
      } catch (err) {
        logger.warn({ err }, "Robô: falha ao calcular estimativa de avaliação de usado");
        estimate = null;
      }
      if (!estimate) return "Não consegui calcular uma estimativa agora. Avise o cliente que a equipe vai avaliar manualmente e encaminhe pro setor Vendas de Celulares.";

      const dev = [brand, model, memory, color].filter(Boolean).join(" ").slice(0, 160) || "(aparelho não informado)";
      try {
        const [conv] = await db.select({ phone: conversationsTable.phone, name: conversationsTable.name })
          .from(conversationsTable).where(eq(conversationsTable.id, ctx.conversationId)).limit(1);
        const phone = conv?.phone ?? "";
        const values = {
          customerName: conv?.name || null,
          device: dev,
          brand, model, memory, color,
          answers,
          suggestedPrice: estimate.estimatedPrice,
          aiSummary: "Avaliação feita pelo assistente de IA durante a conversa no WhatsApp — confirme o valor com o cliente antes de fechar.",
        };
        // Mesmo padrão da avaliação pública: só 1 avaliação PENDENTE por
        // telefone — se o robô reavaliar (cliente corrigiu algo) antes de
        // um vendedor fechar/descartar, atualiza a mesma linha em vez de
        // duplicar o lead.
        const [existingPending] = phone
          ? await db.select().from(tradeInEvaluationsTable)
              .where(and(eq(tradeInEvaluationsTable.tenantId, ctx.tenantId), eq(tradeInEvaluationsTable.source, "whatsapp_bot"), eq(tradeInEvaluationsTable.sellerPhone, phone), isNull(tradeInEvaluationsTable.closedAt)))
              .orderBy(desc(tradeInEvaluationsTable.createdAt)).limit(1)
          : [];
        if (existingPending) {
          await db.update(tradeInEvaluationsTable).set({ ...values, createdAt: new Date() }).where(eq(tradeInEvaluationsTable.id, existingPending.id));
        } else {
          await db.insert(tradeInEvaluationsTable).values({ tenantId: ctx.tenantId, source: "whatsapp_bot", sellerPhone: phone, ...values });
        }
      } catch (err) {
        // Falha ao salvar o lead não pode impedir o cliente de receber a
        // estimativa — só loga; pior caso, a equipe não vê na lista de
        // avaliações, mas a conversa em si já registra o valor dado.
        logger.warn({ err }, "Robô: falha ao salvar lead de avaliação de usado");
      }

      return `Estimativa calculada: ${estimate.estimatedPrice} pra esse ${dev} (${estimate.method === "table" ? "tabela de valores da loja" : "pesquisa de mercado feita agora pela IA"}). É uma estimativa — o valor final é sempre confirmado por um vendedor. Informe o valor ao cliente e, se ele quiser seguir com a troca/venda, encaminhe a conversa pro setor Vendas de Celulares.`;
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
    const labels = conversationId != null
      ? await db.select({ name: chatLabelsTable.name })
          .from(chatLabelsTable).where(and(eq(chatLabelsTable.isActive, true), eq(chatLabelsTable.tenantId, tenantId)))
      : [];
    const history = conversationId != null ? await buildConversationHistory(conversationId) : [];
    const tools: BotTool[] = [];
    if (sectors.length > 0) tools.push(routeToSectorTool(sectors));
    if (conversationId != null) tools.push(applyLabelTool(tenantId, labels));
    // Avaliação de usados por conversa (pedido 17/09) — só entra na lista de
    // ferramentas quando o admin ligou o interruptor (settings.tradeInEnabled)
    // e existe uma conversa de verdade pra registrar o lead.
    let tradeInAvailable = false;
    if (conversationId != null && settings.tradeInEnabled) {
      try {
        const questionsConfig = await getTradeInQuestionsConfig(tenantId);
        tools.push(evaluateUsedDeviceTool(questionsConfig));
        tradeInAvailable = true;
      } catch (err) {
        logger.warn({ err }, "Robô: falha ao carregar config de avaliação de usados");
      }
    }
    const { replyText } = await runBotAgent({
      maxTokens: 300,
      systemPrompt: `Você é ${settings.botName}, assistente virtual de uma loja de celulares no WhatsApp. Responda em português, curto e simpático. Responda SOMENTE com base nas informações abaixo. Se a resposta não estiver nas informações, diga que vai verificar com a equipe e que um atendente já vai falar com o cliente. Nunca invente preços, prazos ou promoções.\n\nINFORMAÇÕES DA LOJA:\n${settings.knowledgeBase || "(nenhuma informação cadastrada)"}${sectors.length > 0 ? `\n\nSe perceber, pela pergunta do cliente, que o assunto é de outro setor (diferente do setor atual da conversa), chame a ferramenta route_to_sector pra corrigir — só quando tiver razoável confiança.` : ""}${conversationId != null ? `\n\nSe o assunto da conversa já estiver razoavelmente claro, use a ferramenta apply_label pra etiquetar (reaproveitando uma etiqueta existente sempre que possível).` : ""}${tradeInAvailable ? `\n\nSe o cliente quiser avaliar, trocar ou vender um aparelho usado, você pode conduzir a avaliação direto na conversa (pergunte marca, modelo e o estado do aparelho, uma pergunta por vez, do seu jeito natural de sempre) e chamar a ferramenta evaluate_used_device quando tiver tudo, pra dar uma estimativa de valor.` : ""}${history.length > 0 ? `\n\nAs mensagens anteriores desta MESMA conversa estão no histórico abaixo — leia com atenção antes de responder. NUNCA repita uma pergunta que o cliente já respondeu ali, e não peça de novo uma informação que ele já deu. Se já houver informação suficiente pra encaminhar, encaminhe (via route_to_sector) em vez de continuar perguntando.` : ""}`,
      history,
      userMessage: question,
      tools,
      ctx: { tenantId, conversationId: conversationId ?? 0 },
    });
    return replyText;
  } catch (err) {
    logger.warn({ err }, "Robô: falha na resposta de IA");
    return null;
  }
}

export async function aiClassify(tenantId: number, conversationId: number | null, settings: BotSettingsRow, answers: string[]): Promise<{ summary: string }> {
  // Multi-loja: só considera os setores e etiquetas DESTA loja na triagem.
  const sectors = await db.select({ id: sectorsTable.id, name: sectorsTable.name })
    .from(sectorsTable).where(and(eq(sectorsTable.isActive, true), eq(sectorsTable.tenantId, tenantId)));
  const labels = await db.select({ name: chatLabelsTable.name })
    .from(chatLabelsTable).where(and(eq(chatLabelsTable.isActive, true), eq(chatLabelsTable.tenantId, tenantId)));
  const qs = toEngineSettings(settings).questions;
  const qa = qs.map((q, i) => `P: ${q.question}\nR: ${answers[i] ?? "(sem resposta)"}`).join("\n");
  const tools: BotTool[] = [];
  if (conversationId != null && sectors.length > 0) tools.push(routeToSectorTool(sectors));
  if (conversationId != null) tools.push(applyLabelTool(tenantId, labels));
  try {
    const { replyText } = await runBotAgent({
      maxTokens: 200,
      systemPrompt: `Você faz a triagem de clientes de uma loja de celulares. Leia as respostas do cliente e: 1) responda com um resumo de 1-2 frases (em português) do que o cliente quer, pro atendente humano ler rápido; 2) se conseguir identificar com razoável confiança qual setor deve atender, chame a ferramenta route_to_sector; 3) se o assunto já estiver claro, chame também apply_label pra etiquetar (reaproveitando uma etiqueta existente sempre que possível). Setores disponíveis: ${sectors.map((s) => s.name).join(", ") || "(nenhum)"}.`,
      userMessage: qa,
      tools,
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

// ---------- fila numerada por setor ----------
// Pedido do lojista (09/09): quando o robô termina a triagem e a conversa
// entra de fato na fila de "Potenciais" daquele setor, avisa ao cliente — UMA
// VEZ só, aqui em "triage_done" (decisão dele: não fica atualizando a cada
// mudança na fila). A posição é aproximada: conta quantos "Potenciais" (sem
// responsável, e não pending/resolved/archived — mesma regra de
// isPotentialConversation) do MESMO setor e loja começaram a conversa antes
// (ou junto) dessa. Inclui a própria conversa, por isso o mínimo é 1.
async function queuePositionInSector(tenantId: number, sectorId: number, createdAt: Date): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.sectorId, sectorId),
      eq(conversationsTable.isArchived, false),
      isNull(conversationsTable.assigneeId),
      notInArray(conversationsTable.status, [...POTENTIAL_EXCLUDED_STATUSES]),
      lte(conversationsTable.createdAt, createdAt),
    ));
  return row?.count ?? 1;
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
    if (settings.typingDelaySeconds > 0) await sleep(settings.typingDelaySeconds * 1000);
    for (const r of step.replies) await sendOutboundText(conv.id, r, settings.botName);
    return;
  }

  if (step.kind === "triage_done") {
    await saveState();
    if (settings.typingDelaySeconds > 0) await sleep(settings.typingDelaySeconds * 1000);
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

    // Fila numerada por setor (pedido do lojista, 09/09): agora que a
    // triagem terminou e o setor está definido, avisa a posição — só nesse
    // momento, uma vez. Só faz sentido se a conversa continuar sem
    // responsável (isPotentialConversation) — se por acaso um vendedor já
    // assumiu enquanto o robô ainda processava, não avisa posição nenhuma.
    if (isPotentialConversation(conv) && conv.sectorId != null) {
      try {
        const [sector] = await db.select({ name: sectorsTable.name })
          .from(sectorsTable).where(eq(sectorsTable.id, conv.sectorId)).limit(1);
        const position = await queuePositionInSector(conv.tenantId, conv.sectorId, conv.createdAt);
        const setorLabel = sector?.name ? ` do setor ${sector.name}` : "";
        await sendOutboundText(
          conv.id,
          `📋 Você está na fila de atendimento${setorLabel}. Posição: Nº ${position}. Já vamos te chamar!`,
          settings.botName,
        );
      } catch (err) {
        logger.warn({ err, conversationId: conv.id }, "Robô: falha ao avisar posição na fila");
      }
    }
    return;
  }

  // ai_question: dúvida livre pós-triagem
  if (!(await consumeDailyAi(tenantId, settings.maxPerDay))) { await saveState(); return; }
  const answer = await aiAnswer(tenantId, conv.id, settings, step.question);
  await saveState({ aiReplies: state.aiReplies + 1 });
  if (answer) {
    // "Tempo de resposta digitando" (pedido 16/09), configurável por loja —
    // some ao humanPacing que a ponte do WhatsApp já faz sozinha por
    // tamanho de texto; este é um atraso extra antes de mandar, pra não
    // parecer robótico respondendo instantâneo a uma pergunta livre.
    if (settings.typingDelaySeconds > 0) await sleep(settings.typingDelaySeconds * 1000);
    await sendOutboundText(conv.id, answer, settings.botName);
  }
}
