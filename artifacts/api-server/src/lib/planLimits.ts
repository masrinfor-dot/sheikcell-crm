import {
  db, usersTable, whatsappSessionsTable, storesTable, sectorsTable,
  saasContractsTable, plansTable,
  LIMIT_FIELDS, LIMIT_LABELS, ENFORCED_LIMIT_FIELDS, type LimitField, type PlanLimits,
} from "@workspace/db";
import { eq, and, count } from "drizzle-orm";

export { LIMIT_FIELDS, LIMIT_LABELS, ENFORCED_LIMIT_FIELDS, type LimitField, type PlanLimits };

/**
 * Limites efetivos de uma loja: usesCustomLimits=false usa os valores do
 * plano contratado (tudo ilimitado se não tem plano); usesCustomLimits=true
 * usa customLimits, caindo de volta pro valor do plano em qualquer chave que
 * não tenha sido personalizada (override parcial, não precisa preencher as
 * 10 de uma vez).
 */
export async function getEffectiveLimits(tenantId: number): Promise<{ limits: PlanLimits; planName: string | null; isCustom: boolean }> {
  const [contract] = await db.select().from(saasContractsTable).where(eq(saasContractsTable.tenantId, tenantId));
  let plan: typeof plansTable.$inferSelect | undefined;
  if (contract?.planId) {
    [plan] = await db.select().from(plansTable).where(eq(plansTable.id, contract.planId));
  }
  const custom = contract?.usesCustomLimits ? (contract.customLimits ?? {}) : {};
  const limits = {} as PlanLimits;
  for (const field of LIMIT_FIELDS) {
    const customVal = custom[field];
    limits[field] = customVal !== undefined ? customVal : (plan ? plan[field] : null);
  }
  return { limits, planName: plan?.name ?? null, isCustom: Boolean(contract?.usesCustomLimits) };
}

/** Quantos desse recurso a loja já usa hoje — só cobre os campos com bloqueio ativo (ver ENFORCED_LIMIT_FIELDS). */
export async function countUsage(tenantId: number, field: LimitField): Promise<number> {
  switch (field) {
    case "maxAdmins": {
      const [r] = await db.select({ n: count() }).from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "admin"), eq(usersTable.isActive, true)));
      return Number(r?.n ?? 0);
    }
    case "maxSupervisors": {
      const [r] = await db.select({ n: count() }).from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "supervisor"), eq(usersTable.isActive, true)));
      return Number(r?.n ?? 0);
    }
    case "maxAttendants": {
      const [r] = await db.select({ n: count() }).from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "vendedor"), eq(usersTable.isActive, true)));
      return Number(r?.n ?? 0);
    }
    case "maxUsersTotal": {
      const [r] = await db.select({ n: count() }).from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)));
      return Number(r?.n ?? 0);
    }
    case "maxWhatsapps": {
      const [r] = await db.select({ n: count() }).from(whatsappSessionsTable)
        .where(eq(whatsappSessionsTable.tenantId, tenantId));
      return Number(r?.n ?? 0);
    }
    case "maxBranches": {
      const [r] = await db.select({ n: count() }).from(storesTable)
        .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true)));
      return Number(r?.n ?? 0);
    }
    case "maxSectors": {
      const [r] = await db.select({ n: count() }).from(sectorsTable)
        .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.isActive, true)));
      return Number(r?.n ?? 0);
    }
    default:
      // Armazenamento, conversas mensais e robôs/IA: ainda sem contador de
      // uso implementado nesta fase.
      return 0;
  }
}

/** Uso + limite de todos os 10 recursos, pra telas de resumo (superadmin e loja). */
export async function getLimitsAndUsage(tenantId: number): Promise<{
  planName: string | null;
  isCustom: boolean;
  items: { field: LimitField; label: string; limit: number | null; used: number; enforced: boolean }[];
}> {
  const { limits, planName, isCustom } = await getEffectiveLimits(tenantId);
  const items = await Promise.all(
    LIMIT_FIELDS.map(async (field) => ({
      field,
      label: LIMIT_LABELS[field],
      limit: limits[field],
      used: await countUsage(tenantId, field),
      enforced: ENFORCED_LIMIT_FIELDS.includes(field),
    })),
  );
  return { planName, isCustom, items };
}

/**
 * Confere se dá pra criar mais um item desse recurso. Só bloqueia os campos
 * em ENFORCED_LIMIT_FIELDS — os demais (armazenamento, conversas, robôs/IA)
 * sempre passam nesta fase, mesmo com limite configurado (ainda não temos
 * contador de uso pra eles). Limite null = ilimitado, sempre passa.
 */
export async function assertWithinLimit(
  tenantId: number,
  field: LimitField,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ENFORCED_LIMIT_FIELDS.includes(field)) return { ok: true };
  const { limits } = await getEffectiveLimits(tenantId);
  const limit = limits[field];
  if (limit == null) return { ok: true };
  const used = await countUsage(tenantId, field);
  if (used >= limit) {
    return {
      ok: false,
      error: `Você atingiu o limite de ${LIMIT_LABELS[field].toLowerCase()} do seu plano (${used} de ${limit} utilizados). Fale com o suporte para aumentar seu plano.`,
    };
  }
  return { ok: true };
}
