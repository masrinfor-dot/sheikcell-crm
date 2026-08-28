// Formação de preço da Vitrine de Aparelhos: a partir do custo do aparelho,
// forma o preço de venda considerando a margem de lucro bruto desejada, a
// taxa de parcelamento no cartão (forma de pagamento de referência) e o
// custo de nota fiscal — método de "markup divisor", padrão de varejo pra
// garantir a margem DEPOIS de descontar taxas variáveis (cartão) e imposto,
// em vez de aplicar a margem só "por cima" do custo puro.

export type PricingSettings = {
  defaultMarginPercent: number; // margem de lucro bruto padrão da loja (%)
  invoiceCostPercent: number; // custo de nota fiscal — impostos/tributação sobre o custo (%)
  cardFeeTable: Record<string, number>; // taxa de cartão por nº de parcelas ("1".."18") em %
  wholesaleMarginPercent: number; // margem de lucro padrão pro preço de atacado (técnico/lojista) — normalmente menor que a de varejo
};

const INSTALLMENTS = Array.from({ length: 18 }, (_, i) => String(i + 1));

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  defaultMarginPercent: 25,
  invoiceCostPercent: 0,
  cardFeeTable: Object.fromEntries(INSTALLMENTS.map((n) => [n, Math.min(2 + Number(n) * 1.1, 40)])),
  wholesaleMarginPercent: 12,
};

/** Sanitiza as configurações de precificação vindas do cliente (só números válidos, dentro de faixas seguras). */
export function sanitizePricingSettings(input: unknown): PricingSettings {
  const o = (input != null && typeof input === "object" ? input : {}) as Partial<PricingSettings>;
  const norm = (v: unknown, d: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : d;
  };
  const rawTable = (o.cardFeeTable != null && typeof o.cardFeeTable === "object" ? o.cardFeeTable : {}) as Record<string, unknown>;
  const cardFeeTable: Record<string, number> = {};
  for (const n of INSTALLMENTS) {
    cardFeeTable[n] = norm(rawTable[n], DEFAULT_PRICING_SETTINGS.cardFeeTable[n] ?? 0, 0, 50);
  }
  return {
    defaultMarginPercent: norm(o.defaultMarginPercent, DEFAULT_PRICING_SETTINGS.defaultMarginPercent, 0, 95),
    invoiceCostPercent: norm(o.invoiceCostPercent, DEFAULT_PRICING_SETTINGS.invoiceCostPercent, 0, 95),
    cardFeeTable,
    wholesaleMarginPercent: norm(o.wholesaleMarginPercent, DEFAULT_PRICING_SETTINGS.wholesaleMarginPercent, 0, 95),
  };
}

/**
 * Calcula o preço de venda a partir do custo.
 * 1. Soma o custo de nota fiscal ao custo (se ainda não estiver incluso).
 * 2. Divide pelo "divisor de margem": 1 − (margem% + taxa de cartão%) / 100.
 *    Isso garante que, mesmo pagando a taxa do cartão escolhido como
 *    referência, a loja ainda fica com a margem de lucro bruto desejada.
 */
export function calcularPrecoVenda(params: {
  custo: number;
  margemPercent: number;
  notaFiscalPercent: number;
  taxaCartaoPercent: number;
  custoJaIncluiNotaFiscal?: boolean;
}): number {
  const { custo, margemPercent, notaFiscalPercent, taxaCartaoPercent, custoJaIncluiNotaFiscal } = params;
  if (!Number.isFinite(custo) || custo <= 0) return 0;
  const custoComNota = custoJaIncluiNotaFiscal ? custo : custo * (1 + notaFiscalPercent / 100);
  const divisor = 1 - (margemPercent + taxaCartaoPercent) / 100;
  // Margem + taxa somando 100% ou mais tornaria o preço infinito/negativo —
  // trava num múltiplo do custo em vez de quebrar a tela do lojista.
  if (divisor <= 0.05) return Math.round(custoComNota * 3 * 100) / 100;
  return Math.round((custoComNota / divisor) * 100) / 100;
}

/** Valor de cada parcela no cartão para um número de parcelas (preço já formado, sem juros adicional na exibição). */
export function parcelaCartao(precoVenda: number, parcelas: number): number {
  if (!Number.isFinite(precoVenda) || parcelas <= 1) return Math.round(precoVenda * 100) / 100;
  return Math.round((precoVenda / parcelas) * 100) / 100;
}

/** Preço de venda de um produto: usa a margem própria do produto se houver, senão a margem padrão da loja. */
export function precoVendaDoProduto(
  produto: { costPrice: number | null; costIncludesInvoice: boolean; marginPercentOverride: number | null },
  settings: PricingSettings,
  taxaCartaoReferenciaParcelas = 1,
): number | null {
  if (produto.costPrice == null || !Number.isFinite(produto.costPrice) || produto.costPrice <= 0) return null;
  const margemPercent = produto.marginPercentOverride ?? settings.defaultMarginPercent;
  const taxaCartaoPercent = settings.cardFeeTable[String(taxaCartaoReferenciaParcelas)] ?? 0;
  return calcularPrecoVenda({
    custo: produto.costPrice,
    margemPercent,
    notaFiscalPercent: settings.invoiceCostPercent,
    taxaCartaoPercent,
    custoJaIncluiNotaFiscal: produto.costIncludesInvoice,
  });
}

/**
 * Preço de atacado (técnico/lojista) de um produto: mesma lógica do preço de
 * venda, mas com a margem de atacado (normalmente menor) e SEM taxa de
 * cartão — venda de atacado costuma ser combinada fora do cartão (pix,
 * transferência, boleto). Usa a margem de atacado própria do produto se
 * houver, senão a margem de atacado padrão da loja.
 */
export function precoAtacadoDoProduto(
  produto: { costPrice: number | null; costIncludesInvoice: boolean; wholesaleMarginPercentOverride: number | null },
  settings: PricingSettings,
): number | null {
  if (produto.costPrice == null || !Number.isFinite(produto.costPrice) || produto.costPrice <= 0) return null;
  const margemPercent = produto.wholesaleMarginPercentOverride ?? settings.wholesaleMarginPercent;
  return calcularPrecoVenda({
    custo: produto.costPrice,
    margemPercent,
    notaFiscalPercent: settings.invoiceCostPercent,
    taxaCartaoPercent: 0,
    custoJaIncluiNotaFiscal: produto.costIncludesInvoice,
  });
}

/**
 * Preço à vista (Pix/dinheiro) de um produto: mesma lógica do preço de venda
 * (mesma margem de varejo do produto), mas SEM taxa de cartão — pra mostrar
 * junto do preço a prazo, em vez de um preço único "de cartão" pra tudo.
 */
export function precoAVistaDoProduto(
  produto: { costPrice: number | null; costIncludesInvoice: boolean; marginPercentOverride: number | null },
  settings: PricingSettings,
): number | null {
  if (produto.costPrice == null || !Number.isFinite(produto.costPrice) || produto.costPrice <= 0) return null;
  const margemPercent = produto.marginPercentOverride ?? settings.defaultMarginPercent;
  return calcularPrecoVenda({
    custo: produto.costPrice,
    margemPercent,
    notaFiscalPercent: settings.invoiceCostPercent,
    taxaCartaoPercent: 0,
    custoJaIncluiNotaFiscal: produto.costIncludesInvoice,
  });
}

/**
 * Preço a prazo em até 12x no cartão: preço total já com a taxa de 12
 * parcelas embutida (mesma fórmula de precoVendaDoProduto, só que fixando a
 * referência em 12 parcelas em vez do padrão de 1x) e o valor de cada
 * parcela — pra mostrar "ou 12x de R$X" ao lado do preço à vista.
 */
export function parcelamento12xDoProduto(
  produto: { costPrice: number | null; costIncludesInvoice: boolean; marginPercentOverride: number | null },
  settings: PricingSettings,
): { total: number; parcela: number } | null {
  const total = precoVendaDoProduto(produto, settings, 12);
  return total != null ? { total, parcela: parcelaCartao(total, 12) } : null;
}

/**
 * Preço de atacado a prazo em até 12x no cartão: mesma ideia do parcelamento
 * de varejo (parcelamento12xDoProduto), só que com a margem de atacado do
 * produto — pra mostrar "atacado à vista: R$X · ou 12x de R$Y" junto do
 * preço de atacado já existente (que já é o valor à vista, sem cartão).
 */
export function parcelamento12xAtacadoDoProduto(
  produto: { costPrice: number | null; costIncludesInvoice: boolean; wholesaleMarginPercentOverride: number | null },
  settings: PricingSettings,
): { total: number; parcela: number } | null {
  if (produto.costPrice == null || !Number.isFinite(produto.costPrice) || produto.costPrice <= 0) return null;
  const margemPercent = produto.wholesaleMarginPercentOverride ?? settings.wholesaleMarginPercent;
  const taxaCartaoPercent = settings.cardFeeTable["12"] ?? 0;
  const total = calcularPrecoVenda({
    custo: produto.costPrice,
    margemPercent,
    notaFiscalPercent: settings.invoiceCostPercent,
    taxaCartaoPercent,
    custoJaIncluiNotaFiscal: produto.costIncludesInvoice,
  });
  return { total, parcela: parcelaCartao(total, 12) };
}
