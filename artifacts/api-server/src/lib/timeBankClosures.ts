import { db, employeesTable, timeBankClosuresTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeTimeBank } from "./timeBank";
import { logger } from "./logger";

// Fechamento mensal do banco de horas: um snapshot CONGELADO por colaborador
// e mês, gerado uma vez e nunca recalculado (mesmo que ajustes/batidas
// antigos do período sejam editados depois). Padrão idêntico ao de
// generateInvoicesForMonth em saasBilling.ts — idempotente via índice único
// (tenantId, employeeId, periodMonth) + onConflictDoNothing, então rodar de
// novo pro mesmo mês é seguro e não sobrescreve o que já foi fechado.

function monthRange(periodMonth: string): { from: Date; to: Date } {
  const [y, m] = periodMonth.split("-").map(Number);
  const from = new Date(`${periodMonth}-01T00:00:00-03:00`);
  const lastDay = new Date(y!, m!, 0).getDate();
  const to = new Date(`${periodMonth}-${String(lastDay).padStart(2, "0")}T23:59:59-03:00`);
  return { from, to };
}

// Mês anterior ao de `now`, no fuso America/Sao_Paulo (não UTC) — evita
// fechar o mês errado perto da virada do dia/mês.
export function previousMonthKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value); // 1-12
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

export function currentMonthKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

/**
 * Gera o fechamento do mês `periodMonth` ("YYYY-MM") para os colaboradores.
 * Sem `tenantId`, processa todas as lojas (uso do job automático); com
 * `tenantId`, só a loja informada (uso do botão manual "Fechar mês" do
 * admin — não deve mexer em dados de outra loja). Retorna quantos foram criados.
 */
export async function generateClosuresForMonth(periodMonth: string, tenantId?: number): Promise<number> {
  const { from, to } = monthRange(periodMonth);
  const employees = tenantId != null
    ? await db.select().from(employeesTable).where(eq(employeesTable.tenantId, tenantId))
    : await db.select().from(employeesTable);
  let created = 0;
  for (const e of employees) {
    try {
      const result = await computeTimeBank(e.id, e.tenantId, from, to);
      const inserted = await db.insert(timeBankClosuresTable).values({
        tenantId: e.tenantId,
        employeeId: e.id,
        employeeName: e.name,
        periodMonth,
        workedMinutes: result.workedMinutes,
        expectedMinutes: result.expectedMinutes,
        adjustmentMinutes: result.adjustmentMinutes,
        balanceMinutes: result.balanceMinutes,
      })
        .onConflictDoNothing({ target: [timeBankClosuresTable.tenantId, timeBankClosuresTable.employeeId, timeBankClosuresTable.periodMonth] })
        .returning({ id: timeBankClosuresTable.id });
      if (inserted.length > 0) created++;
    } catch (err) {
      logger.warn({ err, employeeId: e.id, periodMonth }, "Falha ao fechar banco de horas do colaborador");
    }
  }
  return created;
}

// ── Tick automático (agendador) ──────────────────────────────────────────────
// Fecha o mês anterior a cada execução. Idempotente e barato (pula quem já
// está fechado), então sobrevive a reinícios/quedas do servidor sem precisar
// "lembrar" se já rodou — igual ao padrão de runMonthlyBilling.
let closureRunning = false;
export async function closeMonthlyTimeBanks(now: Date = new Date()): Promise<void> {
  if (closureRunning) return;
  closureRunning = true;
  try {
    const m = previousMonthKey(now);
    const created = await generateClosuresForMonth(m);
    if (created > 0) logger.info({ month: m, created }, "Fechamento mensal de banco de horas gerado automaticamente");
  } catch (err) {
    logger.warn({ err }, "Tick de fechamento mensal de banco de horas falhou");
  } finally {
    closureRunning = false;
  }
}
