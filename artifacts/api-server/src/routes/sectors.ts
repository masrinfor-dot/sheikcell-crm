import { Router, type IRouter } from "express";
import { db, sectorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/sectors", requireAuth, async (_req, res): Promise<void> => {
  const sectors = await db
    .select()
    .from(sectorsTable)
    .where(eq(sectorsTable.isActive, true))
    .orderBy(sectorsTable.id);
  res.json(sectors);
});

router.get("/sectors/all", requireAdmin, async (_req, res): Promise<void> => {
  const sectors = await db.select().from(sectorsTable).orderBy(sectorsTable.id);
  res.json(sectors);
});

router.post("/sectors", requireAdmin, async (req, res): Promise<void> => {
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
  const [sector] = await db
    .insert(sectorsTable)
    .values({ name, description, icon: icon ?? "smartphone", color: color ?? "#1a2e6e" })
    .returning();
  res.status(201).json(sector);
});

router.patch("/sectors/:id", requireAdmin, async (req, res): Promise<void> => {
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
    .where(eq(sectorsTable.id, id))
    .returning();
  if (!sector) {
    res.status(404).json({ error: "Setor não encontrado" });
    return;
  }
  res.json(sector);
});

export default router;
