import { Router, type IRouter } from "express";
import { db, filmCompatTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

// Toda a equipe consulta a compatibilidade.
router.get("/film-compat", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(filmCompatTable).orderBy(asc(filmCompatTable.film));
  res.json(rows);
});

// Só o admin edita a tabela.
router.post("/film-compat", requireAdmin, async (req, res): Promise<void> => {
  const { film, models, notes } = req.body as { film?: string; models?: string; notes?: string };
  const f = (film ?? "").trim();
  const m = (models ?? "").trim();
  if (!f) { res.status(400).json({ error: "Informe a película" }); return; }
  if (!m) { res.status(400).json({ error: "Informe os aparelhos compatíveis" }); return; }
  const [inserted] = await db.insert(filmCompatTable)
    .values({ film: f.slice(0, 120), models: m.slice(0, 1000), notes: (notes ?? "").trim().slice(0, 500) || null })
    .returning();
  res.status(201).json(inserted);
});

router.patch("/film-compat/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { film, models, notes } = req.body as { film?: string; models?: string; notes?: string | null };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (film !== undefined) {
    const f = film.trim();
    if (!f) { res.status(400).json({ error: "Informe a película" }); return; }
    update.film = f.slice(0, 120);
  }
  if (models !== undefined) {
    const m = models.trim();
    if (!m) { res.status(400).json({ error: "Informe os aparelhos compatíveis" }); return; }
    update.models = m.slice(0, 1000);
  }
  if (notes !== undefined) update.notes = (notes ?? "").trim().slice(0, 500) || null;
  const [updated] = await db.update(filmCompatTable).set(update)
    .where(eq(filmCompatTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Registro não encontrado" }); return; }
  res.json(updated);
});

router.delete("/film-compat/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(filmCompatTable).where(eq(filmCompatTable.id, id));
  res.json({ ok: true });
});

export default router;
