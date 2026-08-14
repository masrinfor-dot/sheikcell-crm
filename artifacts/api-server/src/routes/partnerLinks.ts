import { Router, type IRouter } from "express";
import { db, partnerLinksTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();
router.use("/partner-links", requireModuleAccess("financeiras"));

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

// Toda a equipe vê os links das financeiras.
router.get("/partner-links", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(partnerLinksTable)
    .where(eq(partnerLinksTable.tenantId, tenantId))
    .orderBy(asc(partnerLinksTable.position), asc(partnerLinksTable.id));
  res.json(rows);
});

// Só admin/supervisor gerenciam.
router.post("/partner-links", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { name, url } = req.body as { name?: string; url?: string };
  const cleanName = (name ?? "").trim();
  const cleanUrl = normalizeUrl(url ?? "");
  if (!cleanName) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
  if (!cleanUrl) { res.status(400).json({ error: "Link inválido — use um endereço como https://financeira.com.br" }); return; }
  const [inserted] = await db.insert(partnerLinksTable)
    .values({ tenantId, name: cleanName.slice(0, 80), url: cleanUrl })
    .returning();
  res.status(201).json(inserted);
});

router.patch("/partner-links/:id", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
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
  const [updated] = await db.update(partnerLinksTable).set(update)
    .where(and(eq(partnerLinksTable.id, id), eq(partnerLinksTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Link não encontrado" }); return; }
  res.json(updated);
});

router.delete("/partner-links/:id", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(partnerLinksTable)
    .where(and(eq(partnerLinksTable.id, id), eq(partnerLinksTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
