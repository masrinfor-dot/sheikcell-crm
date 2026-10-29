// Setores do Gerente IA (ADM, Financeiro, RH, Compras, Comercial…), cada um
// com responsáveis. Tarefa de um setor sem pessoa citada vai pros
// responsáveis do setor. Lista editável em Gerente IA → Configurações.
import { and, eq, asc } from "drizzle-orm";
import { db, gerenteSectorsTable, type GerenteSector } from "@workspace/db";
import { norm } from "./gerenteRules";

export const DEFAULT_SECTORS = [
  "ADM", "Financeiro", "RH", "Compras", "Comercial", "Marketing", "Sistema", "Atacado", "Loja PP", "Loja SJ", "Loja SC", "Pessoal",
];

/** Setores ativos da loja (cria os padrões na primeira vez). */
export async function getSectors(tenantId: number): Promise<GerenteSector[]> {
  let rows = await db.select().from(gerenteSectorsTable).where(eq(gerenteSectorsTable.tenantId, tenantId)).orderBy(asc(gerenteSectorsTable.position), asc(gerenteSectorsTable.id));
  if (!rows.length) {
    await db.insert(gerenteSectorsTable).values(DEFAULT_SECTORS.map((name, position) => ({ tenantId, name, position }))).onConflictDoNothing();
    rows = await db.select().from(gerenteSectorsTable).where(eq(gerenteSectorsTable.tenantId, tenantId)).orderBy(asc(gerenteSectorsTable.position), asc(gerenteSectorsTable.id));
  }
  return rows.filter((r) => r.isActive);
}

export async function sectorNames(tenantId: number): Promise<string[]> {
  return (await getSectors(tenantId)).map((s) => s.name);
}

const ALIASES: Record<string, string> = {
  "equipe/rh": "RH", "equipe": "RH", "recursos humanos": "RH", "administrativo": "ADM", "administracao": "ADM",
  "vendas": "Comercial", "venda": "Comercial", "financas": "Financeiro", "compra": "Compras", "ti": "Sistema",
};

/** Acha o setor pelo nome (sem acento, sigla, apelido). null se não existir. */
export function matchSector(sectors: GerenteSector[], raw: string | null | undefined): GerenteSector | null {
  if (!raw || !raw.trim()) return null;
  const q = norm(raw).trim();
  const alias = ALIASES[q];
  return sectors.find((s) => norm(s.name) === q)
    ?? (alias ? sectors.find((s) => s.name === alias) : undefined)
    ?? sectors.find((s) => norm(s.name).startsWith(q) || q.startsWith(norm(s.name)))
    ?? null;
}

export async function findSector(tenantId: number, raw: string | null | undefined): Promise<GerenteSector | null> {
  return matchSector(await getSectors(tenantId), raw);
}

export async function upsertSector(tenantId: number, p: { id?: number | null; name: string; responsibleIds: number[]; isActive?: boolean }): Promise<GerenteSector> {
  const name = p.name.trim().slice(0, 40);
  const ids = [...new Set(p.responsibleIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (p.id) {
    const [u] = await db.update(gerenteSectorsTable).set({ name, responsibleIds: ids, ...(p.isActive != null ? { isActive: p.isActive } : {}) })
      .where(and(eq(gerenteSectorsTable.id, p.id), eq(gerenteSectorsTable.tenantId, tenantId))).returning();
    if (!u) throw new Error("Setor não encontrado.");
    return u;
  }
  const existing = await getSectors(tenantId);
  const [r] = await db.insert(gerenteSectorsTable).values({ tenantId, name, responsibleIds: ids, position: existing.length })
    .onConflictDoUpdate({ target: [gerenteSectorsTable.tenantId, gerenteSectorsTable.name], set: { responsibleIds: ids, isActive: true } }).returning();
  return r!;
}
