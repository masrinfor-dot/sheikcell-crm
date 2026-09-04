// Formas de pagamento oferecidas ao fechar a compra de aparelhos usados
// (editáveis por loja, mesmo padrão de app_settings usado em
// lib/tradeInQuestions.ts). Lógica pura (sem DB) para poder testar.

export const PAYMENT_METHODS_KEY = "trade_in_payment_methods";

// "Troca" incluída por padrão — cliente troca o aparelho usado por outro do
// estoque em vez de receber em dinheiro/Pix.
export const DEFAULT_PAYMENT_METHODS: string[] = [
  "Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito", "Transferência bancária", "Troca", "Outro",
];

// Sanitiza a lista vinda do admin: strings não vazias, sem duplicatas
// (case-insensitive), até 20 itens, 40 caracteres cada.
export function sanitizePaymentMethods(input: unknown): { methods?: string[]; error?: string } {
  if (!Array.isArray(input)) return { error: "Lista de formas de pagamento inválida" };
  if (input.length === 0) return { error: "Inclua pelo menos 1 forma de pagamento" };
  if (input.length > 20) return { error: "Máximo de 20 formas de pagamento" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const label = typeof raw === "string" ? raw.trim().slice(0, 40) : "";
    if (!label) return { error: "Toda forma de pagamento precisa de um nome" };
    const key = label.toLowerCase();
    if (seen.has(key)) return { error: `Forma de pagamento repetida: "${label}"` };
    seen.add(key);
    out.push(label);
  }
  return { methods: out };
}
