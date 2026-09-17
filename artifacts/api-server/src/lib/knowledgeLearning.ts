// Aprendizado da base de conhecimento do robô (pedido 16/09): "ultilizar as
// mesagens de cliente para apreder e melhorar a comunicação... cada
// antedimento finalizar a ia fazer uma analise do antediento humano e
// sugeria melhorar na base de conhecimento". Duas entradas alimentam
// sugestões (kb_suggestions), nunca a base direto — o admin sempre aprova:
//   1) A caixa de texto livre na tela do Robô (admin cola informação nova,
//      IA corrige/organiza e já manda pra base — mergeIntoKnowledgeBase).
//   2) Análise automática de cada atendimento HUMANO finalizado, se
//      "Aprender com atendimentos" (bot_settings.learningEnabled) estiver
//      ligado — gera uma sugestão pendente em vez de mexer na base sozinha
//      (generateSuggestionFromConversation).
// Nunca lança: falha de IA aqui não pode derrubar finalizar atendimento nem
// salvar configuração.
import { db, botSettingsTable, kbSuggestionsTable, messagesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { getOpenAiClientForTenant } from "./aiClient";
import { logger } from "./logger";

export const MAX_KB_CHARS = 30000; // mesmo teto de PUT /bot/settings — nunca deixa a IA estourar o limite salvo.

/**
 * Reorganiza a base de conhecimento juntando o texto novo (caixa de IA do
 * admin, ou sugestão aprovada) com o que já existe — sem duplicar
 * informação, mantendo o tom e dentro do limite de caracteres. Se a IA
 * falhar, cai de volta pra um append simples (nunca perde o texto novo).
 */
export async function mergeIntoKnowledgeBase(tenantId: number, currentKb: string, newText: string): Promise<string> {
  const clean = newText.trim();
  if (!clean) return currentKb;
  const fallback = `${currentKb.trim()}${currentKb.trim() ? "\n\n" : ""}${clean}`.slice(0, MAX_KB_CHARS);
  try {
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4000,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `Você organiza a base de conhecimento do assistente virtual de uma loja de celulares (WhatsApp). Você vai receber a BASE ATUAL e um TEXTO NOVO (informação que o lojista quer adicionar ou corrigir). Sua tarefa: devolver a base de conhecimento REESCRITA, incorporando o texto novo.\n\nRegras:\n- Nunca invente informação — use só o que está na base atual e no texto novo.\n- Se o texto novo corrigir algo que já existe na base (ex.: preço, horário, endereço), a versão nova substitui a antiga — não deixe as duas.\n- Não repita a mesma informação em lugares diferentes.\n- Organize por assunto (horários, endereço, formas de pagamento, garantia, setores, tom de atendimento, etc.), mantendo os títulos/seções que já existirem quando fizer sentido.\n- Preserve o estilo e o idioma (português) do conteúdo original.\n- Responda SOMENTE com o texto final da base de conhecimento — sem comentários, sem markdown de code block, sem explicar o que você mudou.\n- O resultado tem que caber em ${MAX_KB_CHARS} caracteres.`,
        },
        {
          role: "user",
          content: `BASE ATUAL:\n${currentKb.trim() || "(vazia)"}\n\nTEXTO NOVO:\n${clean}`,
        },
      ],
    });
    const merged = completion.choices[0]?.message?.content?.trim();
    if (!merged) return fallback;
    return merged.slice(0, MAX_KB_CHARS);
  } catch (err) {
    logger.warn({ err, tenantId }, "Aprendizado IA: falha ao mesclar base de conhecimento — usando append simples");
    return fallback;
  }
}

/** Últimas mensagens reais da conversa, cliente e atendente, pra análise (não usado como resposta ao cliente). */
async function buildAttendanceTranscript(conversationId: number, limit = 60): Promise<string> {
  const rows = await db.select({
    direction: messagesTable.direction,
    content: messagesTable.content,
    transcript: messagesTable.transcript,
    type: messagesTable.type,
    senderName: messagesTable.senderName,
    deletedAt: messagesTable.deletedAt,
  })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id))
    .limit(limit);

  const lines: string[] = [];
  for (const m of rows) {
    if (m.deletedAt) continue;
    if (m.type === "system" || m.type === "note") continue; // interno, cliente nunca viu
    const who = m.direction === "inbound" ? "Cliente" : (m.senderName ? `Atendente (${m.senderName})` : "Atendente");
    const text = (m.type === "audio" && m.transcript ? m.transcript : m.content) || `[${m.type}]`;
    lines.push(`${who}: ${text.slice(0, 400)}`);
  }
  return lines.join("\n").slice(0, 8000);
}

/**
 * Analisa um atendimento HUMANO finalizado e, se a conversa revelar algo que
 * falta na base de conhecimento (informação que o atendente teve que dar na
 * mão), grava uma sugestão PENDENTE — nunca mexe na base sozinha. Chamada em
 * segundo plano pelo PATCH de finalizar atendimento; nunca lança.
 */
export async function generateSuggestionFromConversation(tenantId: number, conversationId: number): Promise<void> {
  try {
    const [settings] = await db.select({ learningEnabled: botSettingsTable.learningEnabled, knowledgeBase: botSettingsTable.knowledgeBase })
      .from(botSettingsTable).where(eq(botSettingsTable.tenantId, tenantId)).limit(1);
    if (!settings?.learningEnabled) return;

    const transcript = await buildAttendanceTranscript(conversationId);
    if (!transcript.trim()) return;

    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 400,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Você ajuda a melhorar a base de conhecimento do assistente virtual de uma loja de celulares (WhatsApp), analisando atendimentos já finalizados por um vendedor humano.\n\nLeia a BASE DE CONHECIMENTO ATUAL e a CONVERSA abaixo. Procure informação que o atendente teve que explicar na mão pro cliente (preço, prazo, política, forma de pagamento, garantia, procedimento, resposta a uma dúvida comum) e que NÃO está coberta na base atual — algo que, se estivesse na base, o robô já poderia ter respondido sozinho.\n\nResponda em JSON: {"hasSuggestion": boolean, "suggestion": string, "reasoning": string}.\n- hasSuggestion=false se a conversa não revelar nada de novo (já coberto na base, ou conversa sem informação reaproveitável — ex.: só agendou retorno, só cumprimentou). Nesse caso suggestion e reasoning podem ficar vazios.\n- hasSuggestion=true: "suggestion" é o texto pronto pra entrar na base (1-4 frases, direto, português, sem repetir o que já existe). "reasoning" é 1 frase curta explicando de onde tirou isso (o que aconteceu na conversa).\n- Nunca invente informação que não esteja na conversa.`,
        },
        {
          role: "user",
          content: `BASE DE CONHECIMENTO ATUAL:\n${settings.knowledgeBase || "(vazia)"}\n\nCONVERSA (cliente e atendente):\n${transcript}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return;
    const parsed = JSON.parse(raw) as { hasSuggestion?: boolean; suggestion?: string; reasoning?: string };
    const suggestion = String(parsed.suggestion ?? "").trim().slice(0, 1000);
    if (!parsed.hasSuggestion || !suggestion) return;

    await db.insert(kbSuggestionsTable).values({
      tenantId,
      conversationId,
      suggestion,
      reasoning: String(parsed.reasoning ?? "").trim().slice(0, 500) || null,
      status: "pending",
    });
  } catch (err) {
    logger.warn({ err, tenantId, conversationId }, "Aprendizado IA: falha ao gerar sugestão de conhecimento");
  }
}

/** Chamada pelo PATCH de finalizar atendimento — nunca atrasa nem derruba a resposta. Nunca lança. */
export function maybeGenerateKbSuggestion(tenantId: number, conversationId: number): void {
  void generateSuggestionFromConversation(tenantId, conversationId);
}
