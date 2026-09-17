// Estimativa "estilo cliente final" da Avaliação de Usados: tenta a tabela
// de valores base primeiro (grátis, na hora); se o modelo não estiver
// cadastrado, cai pra IA (GPT-4o + busca na web). Sempre usa a margem
// "2 - média" (nunca deixa quem não é da equipe escolher a margem, mesma
// regra de sempre). Compartilhado entre a avaliação pública da vitrine
// (routes/tradeIn.ts, tradeInPublicRouter) e a avaliação por conversa no
// WhatsApp (lib/bot.ts, pedido 17/09: "avaliação de usados com IA, pra ser
// feita por conversas também") — mesmo cálculo, duas portas de entrada.
import { db, tradeInBaseValuesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { findBaseValueMatch, type BaseValueRow } from "./tradeInBaseValues";
import { totalDeductionPercent, type QuestionCfg } from "./tradeInQuestions";
import { getMargins } from "./tradeInConfig";

export const formatBRL = (v: number): string =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Chama a IA de preços (com busca na web; cai para estimativa sem web).
export async function askTradeInPriceAI(prompt: string, tenantId: number): Promise<string> {
  const { getOpenAiClientForTenant } = await import("./aiClient");
  const openai = await getOpenAiClientForTenant(tenantId);
  try {
    const r = await openai.responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search_preview" }],
      input: prompt,
      max_output_tokens: 1024,
    });
    return (r.output_text ?? "").trim();
  } catch {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [{ role: "user", content: `${prompt}\n\n(Obs.: você está sem acesso à web; estime pelos preços que conhece do mercado brasileiro e diga na justificativa que é uma estimativa.)` }],
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  }
}

export function extractTradeInJson<T>(raw: string): T | null {
  const jsonText = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(jsonText.slice(start, end + 1)) as T; } catch { return null; }
}

export type TradeInEstimate = { method: "table" | "ai"; estimatedPrice: string };

export async function computeTradeInEstimate(opts: {
  tenantId: number;
  brand: string;
  model: string;
  memory?: string | null;
  questionList: QuestionCfg[];
  answers: Record<string, string>;
}): Promise<TradeInEstimate | null> {
  const { tenantId, brand, model, memory, questionList, answers } = opts;
  const margins = await getMargins(tenantId);
  const marginPct = margins.t2; // nunca deixa escolher — sempre a margem "média"
  const payPct = 100 - marginPct;

  // 1ª tentativa: tabela de valores base (lista fixa) — sem custo, na hora.
  const baseRows = await db.select().from(tradeInBaseValuesTable).where(eq(tradeInBaseValuesTable.tenantId, tenantId));
  const rows: BaseValueRow[] = baseRows.map((r) => ({ brand: r.brand, model: r.model, storage: r.storage, baseValue: Number(r.baseValue) }));
  const match = findBaseValueMatch(rows, brand, model, memory ?? null);
  if (match) {
    const deductionPct = totalDeductionPercent(questionList, answers);
    const estimated = Math.max(0, match.baseValue * (payPct / 100) * (1 - deductionPct / 100));
    return { method: "table", estimatedPrice: formatBRL(estimated) };
  }

  // 2ª tentativa: IA (mesmo prompt/formato usado pela avaliação pública).
  const dev = [brand, model, memory].filter(Boolean).join(" ");
  const condLines = Object.entries(answers).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const prompt = [
    `Você é o avaliador de compra de celulares usados da Sheikcell (loja no Brasil).`,
    `Pesquise na web os preços ATUAIS de venda do aparelho usado abaixo no mercado brasileiro (OLX, Mercado Livre, Trocafone).`,
    ``,
    `Aparelho: ${dev.slice(0, 120)}`,
    `Estado informado pelo cliente:`,
    condLines || "- (sem detalhes)",
    ``,
    `Regras da sugestão:`,
    `1. Estime a faixa de preço que esse aparelho usado é VENDIDO hoje no Brasil, já descontando o estado informado.`,
    `2. A loja trabalha com margem de ${marginPct}% nesta avaliação: sugira um valor de COMPRA em torno de ${payPct}% do valor de revenda estimado.`,
    ``,
    `Responda SOMENTE com um JSON válido, sem markdown, neste formato:`,
    `{"suggestedPrice":"R$ Z"}`,
  ].join("\n");

  const parsed = extractTradeInJson<{ suggestedPrice?: string }>(await askTradeInPriceAI(prompt, tenantId));
  const suggestedPrice = (parsed?.suggestedPrice ?? "").toString().slice(0, 100);
  if (!suggestedPrice) return null;
  return { method: "ai", estimatedPrice: suggestedPrice };
}
