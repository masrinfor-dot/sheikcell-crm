// Limite de avaliações por vendedor (pedido 19/09: "criar aba para colocar
// limite de avaliações por vendedor e dia/período"). Cada chamada de IA da
// Avaliação de Usados custa dinheiro, então a loja passa a poder definir uma
// cota por pessoa — X avaliações por dia, por semana ou por mês.
//
// Diferente das outras travas que já existiam:
// - COOLDOWN_MS/inFlight (routes/tradeIn.ts): segundos entre chamadas, anti-
//   duplo-clique — não é cota.
// - publicTradeInAiLimit (tenants): é do cliente final na vitrine pública,
//   contado por pessoa de fora, não por vendedor da loja.
import { db, appSettingsTable, tradeInEvaluationsTable, usersTable } from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

export type EvalLimitPeriod = "day" | "week" | "month";

export type EvalLimitConfig = {
  enabled: boolean;
  limit: number;
  period: EvalLimitPeriod;
};

const ENABLED_KEY = "tradein_eval_limit_enabled";
const COUNT_KEY = "tradein_eval_limit_count";
const PERIOD_KEY = "tradein_eval_limit_period";

// Desligado por padrão: quem nunca configurou nada continua sem cota nenhuma,
// exatamente como era antes.
const DEFAULTS: EvalLimitConfig = { enabled: false, limit: 10, period: "day" };

export const PERIOD_LABELS: Record<EvalLimitPeriod, string> = {
  day: "por dia",
  week: "por semana",
  month: "por mês",
};

// Quando a cota zera de novo, em texto pronto pra mensagem de bloqueio.
export const PERIOD_RESET_LABELS: Record<EvalLimitPeriod, string> = {
  day: "amanhã",
  week: "na segunda-feira",
  month: "no dia 1º do mês que vem",
};

function parsePeriod(raw: string | undefined): EvalLimitPeriod {
  return raw === "week" || raw === "month" ? raw : "day";
}

export async function getEvalLimitConfig(tenantId: number): Promise<EvalLimitConfig> {
  const rows = await db.select().from(appSettingsTable).where(and(
    eq(appSettingsTable.tenantId, tenantId),
    inArray(appSettingsTable.key, [ENABLED_KEY, COUNT_KEY, PERIOD_KEY]),
  ));
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const limit = parseInt(map[COUNT_KEY] ?? "", 10);
  return {
    enabled: map[ENABLED_KEY] === "true",
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULTS.limit,
    period: parsePeriod(map[PERIOD_KEY]),
  };
}

export async function saveEvalLimitConfig(tenantId: number, cfg: EvalLimitConfig): Promise<void> {
  const updates: [string, string][] = [
    [ENABLED_KEY, cfg.enabled ? "true" : "false"],
    [COUNT_KEY, String(cfg.limit)],
    [PERIOD_KEY, cfg.period],
  ];
  for (const [key, value] of updates) {
    await db.insert(appSettingsTable).values({ tenantId, key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [appSettingsTable.tenantId, appSettingsTable.key],
        set: { value, updatedAt: new Date() },
      });
  }
}

// Instante UTC da meia-noite de um dia civil no fuso da loja. O offset é
// descoberto na hora (o Brasil não tem horário de verão desde 2019, mas assim
// não quebra se voltar a ter).
function storeMidnightUtc(y: number, m: number, d: number): Date {
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
  const hourInStore = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo", hour12: false, hour: "2-digit",
    }).formatToParts(noonUtc).find((p) => p.type === "hour")?.value ?? "12",
  );
  return new Date(Date.UTC(y, m - 1, d, 12 - hourInStore, 0, 0));
}

// Começo do período corrente (dia/semana/mês civis no fuso da loja, não
// janela deslizante): o vendedor sabe que "zera amanhã", não "zera daqui a
// 24h a partir da primeira avaliação".
export function evalPeriodStart(period: EvalLimitPeriod, now: Date = new Date()): Date {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  if (period === "month") return storeMidnightUtc(y, m, 1);
  if (period === "week") {
    const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
    const wdName = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo", weekday: "short",
    }).format(noonUtc);
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const daysSinceMonday = ((wdMap[wdName] ?? 1) + 6) % 7;
    const monday = new Date(Date.UTC(y, m - 1, d - daysSinceMonday));
    return storeMidnightUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  }
  return storeMidnightUtc(y, m, d);
}

// Conta só avaliações feitas pela equipe (source "staff"): lead da vitrine
// pública não é trabalho de vendedor nenhum e não deve consumir cota.
export async function countEvaluationsBy(tenantId: number, userId: number, since: Date): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(tradeInEvaluationsTable)
    .where(and(
      eq(tradeInEvaluationsTable.tenantId, tenantId),
      eq(tradeInEvaluationsTable.userId, userId),
      eq(tradeInEvaluationsTable.source, "staff"),
      gte(tradeInEvaluationsTable.createdAt, since),
    ));
  return Number(row?.count ?? 0);
}

// Uso de cada pessoa da loja no período corrente (tela do admin).
export async function evalUsageByUser(tenantId: number, since: Date): Promise<
  { userId: number; userName: string; role: string; used: number }[]
> {
  const rows = await db.select({
    userId: usersTable.id,
    userName: usersTable.name,
    role: usersTable.role,
    used: sql<number>`count(${tradeInEvaluationsTable.id})`,
  })
    .from(usersTable)
    .leftJoin(
      tradeInEvaluationsTable,
      and(
        eq(tradeInEvaluationsTable.userId, usersTable.id),
        eq(tradeInEvaluationsTable.tenantId, tenantId),
        eq(tradeInEvaluationsTable.source, "staff"),
        gte(tradeInEvaluationsTable.createdAt, since),
      ),
    )
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)))
    .groupBy(usersTable.id, usersTable.name, usersTable.role);
  return rows
    .map((r) => ({ ...r, used: Number(r.used) }))
    .sort((a, b) => b.used - a.used || a.userName.localeCompare(b.userName));
}

// Mensagem de bloqueio quando a pessoa já estourou a cota; null = pode avaliar.
// Admin nunca é bloqueado (é quem define e ajusta o limite) — continua
// aparecendo no uso da tela só como informação.
export async function evalLimitBlockMessage(
  tenantId: number, userId: number, userRole: string,
): Promise<string | null> {
  if (userRole === "admin") return null;
  const cfg = await getEvalLimitConfig(tenantId);
  if (!cfg.enabled) return null;
  const used = await countEvaluationsBy(tenantId, userId, evalPeriodStart(cfg.period));
  if (used < cfg.limit) return null;
  return `Limite de ${cfg.limit} avaliações ${PERIOD_LABELS[cfg.period]} atingido. A cota zera ${PERIOD_RESET_LABELS[cfg.period]} — ou peça ao admin para ajustar o limite em Avaliação de Usados › Limite de avaliações.`;
}
