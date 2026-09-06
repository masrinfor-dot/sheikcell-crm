// "Tabela de valores base" (lista fixa) da Avaliação de Usados — lógica pura
// de normalização/casamento (sem DB), pra poder testar. Ver comentário no
// schema (tradeInBaseValuesTable) e o uso em routes/tradeIn.ts.

export type BaseValueRow = { brand: string; model: string; storage: string | null; baseValue: number };

// Mesmo espírito de normalizeModelForDuplicateCheck (VitrineAparelhos.tsx):
// minúsculo, sem acento, espaços colapsados — pra "iPhone 13" bater com
// "iphone   13" ou "IPHONE 13".
export function normalizeTradeInKey(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

// Acha a melhor linha da tabela pra essa marca/modelo/armazenamento:
// 1. Mesma marca+modelo+armazenamento (match exato) — melhor caso.
// 2. Mesma marca+modelo, linha sem armazenamento cadastrado (vale "qualquer
//    armazenamento") — usada quando não achar o tamanho exato.
// Retorna null se não achar nenhuma linha pra essa marca+modelo (cai pra IA).
export function findBaseValueMatch(rows: BaseValueRow[], brand: string, model: string, storage: string | null): BaseValueRow | null {
  const nBrand = normalizeTradeInKey(brand);
  const nModel = normalizeTradeInKey(model);
  const nStorage = normalizeTradeInKey(storage);
  const sameModel = rows.filter((r) => normalizeTradeInKey(r.brand) === nBrand && normalizeTradeInKey(r.model) === nModel);
  if (sameModel.length === 0) return null;
  const exact = sameModel.find((r) => normalizeTradeInKey(r.storage) === nStorage && nStorage !== "");
  if (exact) return exact;
  const wildcard = sameModel.find((r) => !r.storage);
  return wildcard ?? sameModel[0] ?? null;
}
