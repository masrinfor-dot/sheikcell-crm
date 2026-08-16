// Camada genérica de tool/function-calling do robô — não sabe nada sobre
// setor, agendamento ou qualquer domínio específico. Cada capacidade real
// (Fase 1: roteamento por setor; Fases futuras: consulta de status,
// agendamento) é registrada aqui como um BotTool e passada pra runBotAgent.
// Erro de execução de ferramenta NUNCA lança pra fora — vira um resultado de
// erro devolvido ao próprio modelo (mesma filosofia do resto do robô: falha
// da IA não pode derrubar o atendimento).
import type OpenAI from "openai";

export type BotToolContext = { tenantId: number; conversationId: number };

export type BotTool = {
  name: string;
  description: string;
  // JSON Schema dos parâmetros (formato exigido pela API de function-calling).
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: BotToolContext) => Promise<string>;
};

function toOpenAiTools(tools: BotTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export type BotAgentResult = {
  replyText: string | null;
  toolResults: { name: string; args: Record<string, unknown>; result: string }[];
};

/**
 * Uma "rodada" de chat com function-calling: manda systemPrompt+userMessage,
 * executa toda ferramenta que o modelo pedir (em sequência, cada uma isolada
 * de falha), e faz uma segunda chamada só quando alguma ferramenta rodou —
 * pra obter o texto final já considerando o resultado. Sem tools, é uma
 * chamada de chat comum.
 */
export async function runBotAgent(opts: {
  model?: string;
  maxTokens?: number;
  systemPrompt: string;
  userMessage: string;
  tools: BotTool[];
  ctx: BotToolContext;
}): Promise<BotAgentResult> {
  const { getOpenAiClientForTenant } = await import("./aiClient");
  const openai = await getOpenAiClientForTenant(opts.ctx.tenantId);
  const model = opts.model ?? "gpt-4o";
  const maxTokens = opts.maxTokens ?? 300;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  const first = await openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
    ...(opts.tools.length > 0 ? { tools: toOpenAiTools(opts.tools), tool_choice: "auto" as const } : {}),
  });
  const choice = first.choices[0];
  const toolCalls = choice?.message?.tool_calls ?? [];
  if (toolCalls.length === 0) {
    return { replyText: choice?.message?.content?.trim() || null, toolResults: [] };
  }

  const toolResults: BotAgentResult["toolResults"] = [];
  messages.push(choice!.message);
  for (const call of toolCalls) {
    if (call.type !== "function") continue;
    const tool = opts.tools.find((t) => t.name === call.function.name);
    let args: Record<string, unknown> = {};
    let result: string;
    if (!tool) {
      result = `Ferramenta desconhecida: ${call.function.name}`;
    } else {
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        result = await tool.execute(args, opts.ctx);
      } catch (err) {
        result = `Erro ao executar ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    toolResults.push({ name: call.function.name, args, result });
    messages.push({ role: "tool", tool_call_id: call.id, content: result });
  }

  const second = await openai.chat.completions.create({ model, max_tokens: maxTokens, messages });
  return { replyText: second.choices[0]?.message?.content?.trim() || null, toolResults };
}
