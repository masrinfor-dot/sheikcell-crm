// Normalização de telefone (BR) — usada em todo lugar que grava ou compara
// número de cliente (conversas, contatos do CRM). Sem isso, o mesmo número
// físico gera registros duplicados sempre que chega formatado de um jeito
// ligeiramente diferente do que já está salvo: com/sem DDI 55, com/sem o 9º
// dígito do celular (ex.: WhatsApp às vezes entrega o JID de um contato
// antigo sem o 9 que foi adicionado retroativamente aos celulares do Brasil).

const DDI_BR = "55";

function digitsOnly(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * Forma canônica: DDI + DDD + número, sempre com o 9º dígito quando for
 * celular brasileiro. Usar para GRAVAR — todo número novo entra no banco
 * neste formato, convergindo o histórico aos poucos conforme volta a
 * aparecer (nova mensagem, nova venda etc.).
 *
 * Conservador de propósito: só mexe em números com cara de BR (10/11 dígitos
 * sem DDI, ou já com 55 na frente) — número de outro país passa direto
 * (só remove formatação), pra nunca corromper um contato internacional.
 */
export function normalizePhone(raw: string | null | undefined): string {
  let d = digitsOnly(raw);
  if (!d) return d;

  // "0" de discagem interurbana (0DDXXXXXXXX) — só ocorre com DDD, nunca com DDI.
  if (d.startsWith("0") && d.length > 10) d = d.slice(1);

  if (d.length === 10 || d.length === 11) {
    d = DDI_BR + d;
  }

  if (d.startsWith(DDI_BR) && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(DDI_BR.length, DDI_BR.length + 2);
    const local = d.slice(DDI_BR.length + 2);
    // Celular sem o 9: local de 8 dígitos começando em 6-9 (prefixos de
    // celular antes do 9 ser adicionado). Nunca mexe em número de 8 dígitos
    // que já não tem essa cara (provável fixo).
    if (local.length === 8 && /^[6-9]/.test(local)) {
      d = DDI_BR + ddd + "9" + local;
    }
  }

  return d;
}

/**
 * Todas as variações plausíveis do MESMO número — usar para COMPARAR contra
 * dados que podem não ter passado pela normalização ainda (histórico salvo
 * antes desta correção). Inclui a forma canônica, sem DDI, e com/sem o 9º
 * dígito. Nunca cruza DDDs diferentes (não gera falso-positivo entre
 * clientes distintos).
 */
export function phoneVariants(raw: string | null | undefined): string[] {
  const canonical = normalizePhone(raw);
  if (!canonical) return [];
  const variants = new Set<string>([canonical, digitsOnly(raw)]);

  if (canonical.startsWith(DDI_BR) && (canonical.length === 12 || canonical.length === 13)) {
    const withoutDDI = canonical.slice(DDI_BR.length);
    variants.add(withoutDDI);

    const ddd = withoutDDI.slice(0, 2);
    const local = withoutDDI.slice(2);
    if (local.length === 9 && local.startsWith("9")) {
      const local8 = local.slice(1);
      variants.add(DDI_BR + ddd + local8);
      variants.add(ddd + local8);
    }
  }

  return [...variants];
}
