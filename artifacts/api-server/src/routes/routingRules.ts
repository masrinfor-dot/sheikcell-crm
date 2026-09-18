// CRUD de regras de roteamento por palavra-chave (routing_rules) — pedido
// 18/09: até agora essa tabela e o motor de classificação (classifyText,
// ver lib/autoRouter.ts) existiam no código, mas SEM NENHUMA tela de
// administração pra cadastrar regra nenhuma — ficava inutilizável na
// prática. Esta rota é a primeira a dar CRUD de verdade pra ela, incluindo
// o campo skipQueue (pedido 18/09: "criar palavra chave por transferir
// atendimento para loja adequada e pular a fila", ex.: "xerox").
import { Router, type IRouter } from "express";
import { db, routingRulesTable, sectorsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { invalidateCache } from "../lib/autoRouter";

const router: IRouter = Router();

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

router.get("/routing-rules", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(routingRulesTable)
    .where(eq(routingRulesTable.tenantId, tenantId))
    .orderBy(desc(routingRulesTable.priority), routingRulesTable.id);
  res.json(rows);
});

router.post("/routing-rules", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = req.body as { sectorId?: number; name?: string; keywords?: string; priority?: number; isActive?: boolean; skipQueue?: boolean };
  const name = clean(b.name, 120);
  const keywords = clean(b.keywords, 500);
  const sectorId = Number(b.sectorId);
  if (!name) { res.status(400).json({ error: "Informe um nome pra regra" }); return; }
  if (!keywords) { res.status(400).json({ error: "Informe pelo menos uma palavra-chave" }); return; }
  if (!Number.isFinite(sectorId)) { res.status(400).json({ error: "Escolha o setor de destino" }); return; }
  const [sector] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
    .where(and(eq(sectorsTable.id, sectorId), eq(sectorsTable.tenantId, tenantId))).limit(1);
  if (!sector) { res.status(400).json({ error: "Setor inválido" }); return; }
  const priority = typeof b.priority === "number" && Number.isFinite(b.priority) ? Math.round(b.priority) : 0;
  const [created] = await db.insert(routingRulesTable).values({
    tenantId, sectorId, name, keywords, priority,
    isActive: b.isActive !== false,
    skipQueue: b.skipQueue === true,
  }).returning();
  invalidateCache();
  res.status(201).json(created);
});

router.patch("/routing-rules/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const b = req.body as { sectorId?: number; name?: string; keywords?: string; priority?: number; isActive?: boolean; skipQueue?: boolean };
  const update: Record<string, unknown> = {};
  if ("name" in b) {
    const name = clean(b.name, 120);
    if (!name) { res.status(400).json({ error: "Informe um nome pra regra" }); return; }
    update.name = name;
  }
  if ("keywords" in b) {
    const keywords = clean(b.keywords, 500);
    if (!keywords) { res.status(400).json({ error: "Informe pelo menos uma palavra-chave" }); return; }
    update.keywords = keywords;
  }
  if ("sectorId" in b) {
    const sectorId = Number(b.sectorId);
    if (!Number.isFinite(sectorId)) { res.status(400).json({ error: "Setor inválido" }); return; }
    const [sector] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
      .where(and(eq(sectorsTable.id, sectorId), eq(sectorsTable.tenantId, tenantId))).limit(1);
    if (!sector) { res.status(400).json({ error: "Setor inválido" }); return; }
    update.sectorId = sectorId;
  }
  if ("priority" in b) update.priority = typeof b.priority === "number" && Number.isFinite(b.priority) ? Math.round(b.priority) : 0;
  if ("isActive" in b) update.isActive = b.isActive !== false;
  if ("skipQueue" in b) update.skipQueue = b.skipQueue === true;
  const [updated] = await db.update(routingRulesTable).set(update)
    .where(and(eq(routingRulesTable.id, id), eq(routingRulesTable.tenantId, tenantId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Regra não encontrada" }); return; }
  invalidateCache();
  res.json(updated);
});

router.delete("/routing-rules/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [deleted] = await db.delete(routingRulesTable)
    .where(and(eq(routingRulesTable.id, id), eq(routingRulesTable.tenantId, tenantId)))
    .returning({ id: routingRulesTable.id });
  if (!deleted) { res.status(404).json({ error: "Regra não encontrada" }); return; }
  invalidateCache();
  res.json({ ok: true });
});

export default router;
