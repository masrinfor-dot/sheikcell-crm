import { Router, type IRouter } from "express";
import { db, sheetLinksTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";

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

// Sanitiza listas de acesso: array de ids inteiros ou null (= todos).
function cleanIdList(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((v) => parseInt(String(v), 10)).filter((n) => Number.isInteger(n) && n > 0);
  const uniq = [...new Set(ids)].slice(0, 200);
  return uniq.length > 0 ? uniq : null;
}

// Lista: admin/supervisor veem todas; vendedor só vê as liberadas
// (sem restrição, ou com o setor dele, ou com o id dele).
router.get("/sheet-links", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userRole = req.session.userRole!;
  const userId = req.session.userId!;
  const userSectorId = req.session.userSectorId ?? null;
  const rows = await db.select().from(sheetLinksTable)
    .where(eq(sheetLinksTable.tenantId, tenantId))
    .orderBy(asc(sheetLinksTable.position), asc(sheetLinksTable.id));
  const visible = (userRole === "admin" || userRole === "supervisor")
    ? rows
    : rows.filter((l) => {
        const noRestriction = l.allowedSectorIds == null && l.allowedUserIds == null;
        if (noRestriction) return true;
        if (l.allowedUserIds?.includes(userId)) return true;
        if (userSectorId != null && l.allowedSectorIds?.includes(userSectorId)) return true;
        return false;
      });
  res.json(visible);
});

// Só o admin gerencia.
router.post("/sheet-links", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { name, url, allowedSectorIds, allowedUserIds } = req.body as { name?: string; url?: string; allowedSectorIds?: unknown; allowedUserIds?: unknown };
  const cleanName = (name ?? "").trim();
  const cleanUrl = normalizeUrl(url ?? "");
  if (!cleanName) { res.status(400).json({ error: "Nome é obrigatório" }); return; }
  if (!cleanUrl) { res.status(400).json({ error: "Link inválido — cole o endereço da planilha ou formulário" }); return; }
  const [inserted] = await db.insert(sheetLinksTable)
    .values({ tenantId, name: cleanName.slice(0, 80), url: cleanUrl, allowedSectorIds: cleanIdList(allowedSectorIds), allowedUserIds: cleanIdList(allowedUserIds) })
    .returning();
  res.status(201).json(inserted);
});

router.patch("/sheet-links/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { name, url, allowedSectorIds, allowedUserIds } = req.body as { name?: string; url?: string; allowedSectorIds?: unknown; allowedUserIds?: unknown };
  const update: Record<string, unknown> = {};
  if (allowedSectorIds !== undefined) update.allowedSectorIds = cleanIdList(allowedSectorIds);
  if (allowedUserIds !== undefined) update.allowedUserIds = cleanIdList(allowedUserIds);
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
    .where(and(eq(sheetLinksTable.id, id), eq(sheetLinksTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Link não encontrado" }); return; }
  res.json(updated);
});

// Reordenar: recebe a lista completa de ids na nova ordem; position = índice.
router.post("/sheet-links/reorder", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const ids = cleanIdList((req.body as { ids?: unknown }).ids);
  if (!ids || ids.length === 0) { res.status(400).json({ error: "Lista de ids inválida" }); return; }
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.update(sheetLinksTable).set({ position: i })
        .where(and(eq(sheetLinksTable.id, ids[i]!), eq(sheetLinksTable.tenantId, tenantId)));
    }
  });
  res.json({ ok: true });
});

router.delete("/sheet-links/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(sheetLinksTable)
    .where(and(eq(sheetLinksTable.id, id), eq(sheetLinksTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
