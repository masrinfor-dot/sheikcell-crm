// Cálculo do vencimento de férias (CLT), pedido 10/09 (análise Tangerino).
//
// Regra: a cada 12 meses completos desde a admissão o colaborador conclui um
// "período aquisitivo" (ganha o direito a 30 dias de férias). Ele tem então
// até os 12 meses seguintes — o "período concessivo" — para efetivamente
// tirar essas férias. O vencimento de um período aquisitivo iniciado em
// `cycleStart` é, portanto, `cycleStart + 24 meses`.
//
// Aqui achamos o PRIMEIRO período aquisitivo já completo (12 meses já
// passaram) que ainda não foi "usado" — ou seja, sem nenhum afastamento
// kind="ferias" cuja data de início caia dentro da janela de 24 meses
// daquele ciclo. Normalmente há zero ou um ciclo pendente por vez; o loop
// segue pra frente até achar o primeiro em aberto (ou esgotar 40 anos, limite
// de segurança pra nunca rodar infinito).
//
// Função pura e sem I/O de propósito — recebe as datas já buscadas do banco
// (admissionDate do colaborador + startDate de cada leave_records kind
// "ferias" já lançado) e devolve o resultado. Facilita testar e reaproveitar
// tanto no endpoint de auto-serviço (colaborador vê o próprio vencimento)
// quanto no painel do RH (lista de todos os colaboradores).

export interface VacationDeadlineInfo {
  cycleStart: string; // YYYY-MM-DD — início do período aquisitivo em aberto
  acquisitionDue: string; // YYYY-MM-DD — quando completou 12 meses (sempre <= hoje)
  dueDate: string; // YYYY-MM-DD — vencimento do período concessivo (cycleStart + 24 meses)
  daysUntilDue: number; // negativo = já venceu
  overdue: boolean;
}

function addMonthsToDateStr(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m! - 1) + months, d!));
  return dt.toISOString().slice(0, 10);
}

function daysBetween(fromStr: string, toStr: string): number {
  const a = new Date(`${fromStr}T00:00:00Z`).getTime();
  const b = new Date(`${toStr}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

const MAX_CYCLES = 40; // ~40 anos de admissão — nunca deveria chegar perto disso

export function computeVacationDeadline(
  admissionDate: string,
  takenFeriasStartDates: string[],
  now: Date = new Date(),
): VacationDeadlineInfo | null {
  const nowStr = now.toISOString().slice(0, 10);
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    const cycleStart = addMonthsToDateStr(admissionDate, cycle * 12);
    const acquisitionDue = addMonthsToDateStr(admissionDate, cycle * 12 + 12);
    if (acquisitionDue > nowStr) break; // esse ciclo (e os seguintes) ainda não completou 12 meses
    const dueDate = addMonthsToDateStr(admissionDate, cycle * 12 + 24);
    const used = takenFeriasStartDates.some((s) => s >= cycleStart && s < dueDate);
    if (used) continue;
    return { cycleStart, acquisitionDue, dueDate, daysUntilDue: daysBetween(nowStr, dueDate), overdue: dueDate < nowStr };
  }
  return null; // nenhum período aquisitivo completo em aberto (recém contratado, ou tudo já tirado em dia)
}
