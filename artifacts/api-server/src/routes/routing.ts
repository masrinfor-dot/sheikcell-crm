import { Router, type IRouter } from "express";
import { db, routingRulesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { classifyText, invalidateCache } from "../lib/autoRouter";

const router: IRouter = Router();

router.get("/routing/rules", requireAuth, async (req, res): Promise<void> => {
  const rules = await db.select().from(routingRulesTable).orderBy(routingRulesTable.priority);
  res.json(rules);
});

router.post("/routing/rules", requireAuth, async (req, res): Promise<void> => {
  if (req.session.userRole !== "admin") { res.status(403).json({ error: "Apenas admins" }); return; }
  const { sectorId, name, keywords, priority } = req.body as { sectorId?: number; name?: string; keywords?: string; priority?: number };
  if (!sectorId || !name || !keywords) { res.status(400).json({ error: "sectorId, name e keywords são obrigatórios" }); return; }
  const [rule] = await db.insert(routingRulesTable).values({ sectorId, name, keywords, priority: priority ?? 0 }).returning();
  invalidateCache();
  res.status(201).json(rule);
});

router.patch("/routing/rules/:id", requireAuth, async (req, res): Promise<void> => {
  if (req.session.userRole !== "admin") { res.status(403).json({ error: "Apenas admins" }); return; }
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { name, keywords, priority, isActive, sectorId } = req.body as { name?: string; keywords?: string; priority?: number; isActive?: boolean; sectorId?: number };
  const update: Partial<{ name: string; keywords: string; priority: number; isActive: boolean; sectorId: number }> = {};
  if (name !== undefined) update.name = name;
  if (keywords !== undefined) update.keywords = keywords;
  if (priority !== undefined) update.priority = priority;
  if (isActive !== undefined) update.isActive = isActive;
  if (sectorId !== undefined) update.sectorId = sectorId;
  const [rule] = await db.update(routingRulesTable).set(update).where(eq(routingRulesTable.id, id)).returning();
  if (!rule) { res.status(404).json({ error: "Regra não encontrada" }); return; }
  invalidateCache();
  res.json(rule);
});

router.delete("/routing/rules/:id", requireAuth, async (req, res): Promise<void> => {
  if (req.session.userRole !== "admin") { res.status(403).json({ error: "Apenas admins" }); return; }
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(routingRulesTable).where(eq(routingRulesTable.id, id));
  invalidateCache();
  res.json({ ok: true });
});

router.post("/routing/classify", requireAuth, async (req, res): Promise<void> => {
  const { text } = req.body as { text?: string };
  if (!text) { res.status(400).json({ error: "text é obrigatório" }); return; }
  const result = await classifyText(text);
  res.json(result ?? { sectorId: null, ruleName: null, matchedKeyword: null });
});

export default router;
