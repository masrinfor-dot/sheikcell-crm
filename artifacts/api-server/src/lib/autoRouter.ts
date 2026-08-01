import { db, routingRulesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export interface ClassifyResult {
  sectorId: number;
  ruleName: string;
  matchedKeyword: string;
}

// Multi-loja: o cache de regras é por tenant — cada loja tem suas próprias
// regras de roteamento e nunca deve enxergar as de outra loja.
type Rule = { id: number; sectorId: number; name: string; keywords: string; priority: number };
const cacheByTenant = new Map<number, { rules: Rule[]; ts: number }>();
const CACHE_TTL = 60_000;

async function getRules(tenantId: number): Promise<Rule[]> {
  const cached = cacheByTenant.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.rules;
  const rules = await db
    .select({ id: routingRulesTable.id, sectorId: routingRulesTable.sectorId, name: routingRulesTable.name, keywords: routingRulesTable.keywords, priority: routingRulesTable.priority })
    .from(routingRulesTable)
    .where(and(eq(routingRulesTable.isActive, true), eq(routingRulesTable.tenantId, tenantId)))
    .orderBy(routingRulesTable.priority);
  rules.sort((a, b) => b.priority - a.priority);
  cacheByTenant.set(tenantId, { rules, ts: Date.now() });
  return rules;
}

export function invalidateCache() {
  cacheByTenant.clear();
}

export async function classifyText(text: string, tenantId: number): Promise<ClassifyResult | null> {
  if (!text || text.trim().length === 0) return null;
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const rules = await getRules(tenantId);
  for (const rule of rules) {
    const kws = rule.keywords.split(",").map((k) => k.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")).filter(Boolean);
    for (const kw of kws) {
      if (normalized.includes(kw)) {
        return { sectorId: rule.sectorId, ruleName: rule.name, matchedKeyword: kw };
      }
    }
  }
  return null;
}
