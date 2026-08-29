import { Router, type IRouter } from "express";
import { db, sectorsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { assertWithinLimit } from "../lib/planLimits";

const router: IRouter = Router();

router.get("/sectors", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const sectors = await db
    .select()
    .from(sectorsTable)
    .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.isActive, true)))
    .orderBy(sectorsTable.id);
  res.json(sectors);
});

router.get("/sectors/all", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const sectors = await db.select().from(sectorsTable)
    .where(eq(sectorsTable.tenantId, tenantId))
    .orderBy(sectorsTable.id);
  res.json(sectors);
});

router.post("/sectors", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { name, description, icon, color } = req.body as {
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
  };
  if (!name) {
    res.status(400).json({ error: "Nome é obrigatório" });
    return;
  }
  // Limite do plano (Fase 3 — Planos & Limites): teto de setores.
  const limitCheck = await assertWithinLimit(tenantId, "maxSectors");
  if (!limitCheck.ok) { res.status(400).json({ error: limitCheck.error }); return; }
  const [sector] = await db
    .insert(sectorsTable)
    .values({ tenantId, name, description, icon: icon ?? "smartphone", color: color ?? "#1a2e6e" })
    .returning();
  res.status(201).json(sector);
});

router.patch("/sectors/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const { name, description, icon, color, isActive } = req.body as {
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    isActive?: boolean;
  };
  const [sector] = await db
    .update(sectorsTable)
    .set({ name, description, icon, color, isActive })
    .where(and(eq(sectorsTable.id, id), eq(sectorsTable.tenantId, tenantId)))
    .returning();
  if (!sector) {
    res.status(404).json({ error: "Setor não encontrado" });
    return;
  }
  res.json(sector);
});

export default router;
