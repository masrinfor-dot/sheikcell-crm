import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Monta um link wa.me a partir de um telefone (com ou sem DDI/formatação) e
// um texto já pronto — usado tanto no checkout da vitrine quanto na
// avaliação pública de usados, pra sempre abrir o WhatsApp da loja com a
// mesma lógica de normalização do número.
export function waLink(phone: string | null | undefined, text: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (!digits.startsWith("55")) digits = `55${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// Converte um valor formatado em BRL (ex.: "R$ 1.234,56", possivelmente
// dentro de um texto maior) pro número puro (1234.56). Usado pra poder
// abater o valor estimado do usado do total do carrinho — o backend só
// devolve o valor já formatado como string (às vezes vindo de IA, que nem
// sempre é 100% previsível no formato), então isso é best-effort: devolve
// null se não conseguir reconhecer um número, e quem chama deve tratar esse
// caso sem quebrar (não abate desconto, mas ainda mostra o texto original).
export function parseBRLToNumber(label: string | null | undefined): number | null {
  if (!label) return null;
  const match = label.match(/[\d.,]+/);
  if (!match) return null;
  let s = match[0];
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
