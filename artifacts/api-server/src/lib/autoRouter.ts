import { db, routingRulesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface ClassifyResult {
  sectorId: number;
  ruleName: string;
  matchedKeyword: string;
}

let cachedRules: Array<{ id: number; sectorId: number; name: string; keywords: string; priority: number }> = [];
let cacheTs = 0;
const CACHE_TTL = 60_000;

async function getRules() {
  if (Date.now() - cacheTs < CACHE_TTL) return cachedRules;
  cachedRules = await db
    .select({ id: routingRulesTable.id, sectorId: routingRulesTable.sectorId, name: routingRulesTable.name, keywords: routingRulesTable.keywords, priority: routingRulesTable.priority })
    .from(routingRulesTable)
    .where(eq(routingRulesTable.isActive, true))
    .orderBy(routingRulesTable.priority);
  cachedRules.sort((a, b) => b.priority - a.priority);
  cacheTs = Date.now();
  return cachedRules;
}

export function invalidateCache() {
  cacheTs = 0;
}

export async function classifyText(text: string): Promise<ClassifyResult | null> {
  if (!text || text.trim().length === 0) return null;
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const rules = await getRules();
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
