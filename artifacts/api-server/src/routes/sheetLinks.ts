import { Router, type IRouter } from "express";
import { db, sheetLinksTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

function normalizeUrl(raw: string): string | null {
  let u = raw.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// Toda a equipe vê as planilhas/formulários.
router.get("/sheet-links", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(sheetLinksTable)
    .orderBy(asc(sheetLinksTable.position), asc(sheetLinksTable.id));
  res.json(rows);
});

// Só o admin gerencia.
router.post("/sheet-links", requireAdmin, async (req, res): Promise<void> => {
  const { name, url } = req.body as { name?: string; url?: string };
  const cleanName = (name ?? "").trim();
  const cleanUrl = normalizeUrl(url ?? "");
  if (!cleanName) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
  if (!cleanUrl) { res.status(400).json({ error: "Link inválido — cole o endereço da planilha ou formulário" }); return; }
  const [inserted] = await db.insert(sheetLinksTable)
    .values({ name: cleanName.slice(0, 80), url: cleanUrl })
    .returning();
  res.status(201).json(inserted);
});

router.patch("/sheet-links/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { name, url } = req.body as { name?: string; url?: string };
  const update: Record<string, unknown> = {};
  if (name !== undefined) {
    const n = name.trim();
    if (!n) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
    update.name = n.slice(0, 80);
  }
  if (url !== undefined) {
    const u = normalizeUrl(url);
    if (!u) { res.status(400).json({ error: "Link inválido" }); return; }
    update.url = u;
  }
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(sheetLinksTable).set(update)
    .where(eq(sheetLinksTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Link não encontrado" }); return; }
  res.json(updated);
});

router.delete("/sheet-links/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(sheetLinksTable).where(eq(sheetLinksTable.id, id));
  res.json({ ok: true });
});

export default router;
