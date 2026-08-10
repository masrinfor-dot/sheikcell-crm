// Validação de CPF/CNPJ (dígito verificador) — sem dependência externa.
// Usado no cadastro de loja do Superadmin (responsável pessoa física ou
// jurídica). Detecta o tipo pelo tamanho depois de tirar a máscara.

function onlyDigits(v: string): string {
  return v.replace(/\D/g, "");
}

function isAllSameDigit(v: string): boolean {
  return /^(\d)\1+$/.test(v);
}

function cpfCheckDigit(digits: string, upto: number): number {
  let sum = 0;
  let weight = upto + 1;
  for (let i = 0; i < upto; i++) sum += parseInt(digits[i]!, 10) * weight--;
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isValidCpf(digits: string): boolean {
  if (digits.length !== 11 || isAllSameDigit(digits)) return false;
  const d1 = cpfCheckDigit(digits, 9);
  const d2 = cpfCheckDigit(digits, 10);
  return d1 === parseInt(digits[9]!, 10) && d2 === parseInt(digits[10]!, 10);
}

function cnpjCheckDigit(digits: string, upto: number): number {
  const weights = upto === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < upto; i++) sum += parseInt(digits[i]!, 10) * weights[i]!;
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isValidCnpj(digits: string): boolean {
  if (digits.length !== 14 || isAllSameDigit(digits)) return false;
  const d1 = cnpjCheckDigit(digits, 12);
  const d2 = cnpjCheckDigit(digits, 13);
  return d1 === parseInt(digits[12]!, 10) && d2 === parseInt(digits[13]!, 10);
}

/** Valida um CPF (11 dígitos) ou CNPJ (14 dígitos), com ou sem máscara. */
export function validateCpfCnpj(raw: string): { valid: boolean; digits: string; type: "cpf" | "cnpj" | null } {
  const digits = onlyDigits(raw);
  if (digits.length === 11) return { valid: isValidCpf(digits), digits, type: "cpf" };
  if (digits.length === 14) return { valid: isValidCnpj(digits), digits, type: "cnpj" };
  return { valid: false, digits, type: null };
}
