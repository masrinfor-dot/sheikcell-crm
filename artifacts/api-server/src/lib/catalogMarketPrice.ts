// Checagem de preço de mercado (Vitrine de Aparelhos): usada na revisão de
// preço da importação de lista de fornecedor, pra o lojista ver se o preço
// de VENDA calculado (custo + margem) está compatível com o que o mercado
// brasileiro (OLX, Mercado Livre, Trocafone, lojas online) cobra por aquele
// mesmo aparelho/condição, antes de finalizar a importação.

/** Extrai o primeiro objeto JSON `{...}` de um texto (a IA às vezes envolve a resposta em ```json ... ```). */
export function extractJsonObject<T>(raw: string): T | null {
  const text = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// Client mínimo compatível com o SDK da OpenAI — só a parte usada aqui
// (mesmo padrão de "responses.create com web_search_preview, cai pra
// chat.completions sem web se a Responses API falhar" do askPriceAI em
// routes/tradeIn.ts, extraído aqui como função própria pra poder testar sem
// precisar montar toda a infra de rota Express).
type MinimalOpenAiClient = {
  responses: {
    create: (params: {
      model: string;
      tools: { type: "web_search_preview" }[];
      input: string;
      max_output_tokens: number;
    }) => Promise<{ output_text?: string | null }>;
  };
  chat: {
    completions: {
      create: (params: {
        model: string;
        max_tokens: number;
        messages: { role: "user"; content: string }[];
      }) => Promise<{ choices: { message?: { content?: string | null } }[] }>;
    };
  };
};

/** Chama a IA com busca na web habilitada; se a Responses API falhar (indisponível/sem suporte), cai numa estimativa sem web. */
export async function askCatalogAIWithWebSearch(openai: MinimalOpenAiClient, prompt: string): Promise<string> {
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
      messages: [{
        role: "user",
        content: `${prompt}\n\n(Obs.: você está sem acesso à web; estime pelos preços que conhece do mercado brasileiro e diga na justificativa que é uma estimativa.)`,
      }],
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  }
}

export type MarketCheckVerdict = "compativel" | "acima" | "abaixo" | "sem_dados";

const VALID_VERDICTS: MarketCheckVerdict[] = ["compativel", "acima", "abaixo", "sem_dados"];

export function cleanMarketCheckVerdict(v: unknown): MarketCheckVerdict {
  return VALID_VERDICTS.includes(v as MarketCheckVerdict) ? (v as MarketCheckVerdict) : "sem_dados";
}

/** Monta o prompt de checagem de preço de mercado pra um aparelho da vitrine. */
export function buildMarketCheckPrompt(params: {
  device: string; // "iPhone 13 128GB", por exemplo
  conditionLabel: string; // "Excelente", "Novo", etc.
  price: number | null; // preço de venda calculado pela loja, se já tiver
}): string {
  const { device, conditionLabel, price } = params;
  return [
    `Você é um analista de precificação de uma loja de celulares novos/seminovos no Brasil.`,
    `Pesquise na web os preços ATUAIS de VENDA (preço final ao consumidor, não o preço de compra de usado) do aparelho abaixo no mercado brasileiro — marketplaces (OLX, Mercado Livre), lojas de seminovos (Trocafone, iPlace) e varejo (Magalu, Kabum) quando fizer sentido pra condição do aparelho.`,
    ``,
    `Aparelho: ${device.slice(0, 120)}`,
    `Condição/selo de qualidade do aparelho desta loja: ${conditionLabel}.`,
    price != null && Number.isFinite(price) ? `Preço de venda que esta loja pretende cobrar: R$ ${price.toFixed(2)}.` : null,
    ``,
    `Responda SOMENTE com um JSON válido, sem markdown, neste formato:`,
    `{"marketRange":"R$ X – R$ Y","verdict":"compativel","note":"1-2 frases curtas explicando o comparativo"}`,
    `"verdict" deve ser um destes: "compativel" (preço da loja está dentro ou próximo da faixa de mercado encontrada), "acima" (preço da loja está visivelmente mais caro que o mercado), "abaixo" (preço da loja está visivelmente mais barato — pode estar deixando margem na mesa), "sem_dados" (não encontrou preços confiáveis pra comparar esse modelo/condição específicos).`,
    `Se não foi informado o preço de venda da loja, ainda assim devolva a faixa de mercado encontrada e use "verdict":"sem_dados".`,
  ].filter((l): l is string => l != null).join("\n");
}
