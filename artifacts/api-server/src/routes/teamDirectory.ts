import { Router, type IRouter } from "express";
import { db, usersTable, sectorsTable, teamFavoritesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, requireTenant } from "../middlewares/auth";

const router: IRouter = Router();

// ── Diretório interno de contatos: colegas da equipe (nome, ramal, setor,
// avatar por iniciais) — reaproveita os usuários já cadastrados na loja.
// Qualquer usuário autenticado pode ver (não é uma tela de admin).
router.get("/team-directory", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;

  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      extension: usersTable.extension,
      storeName: usersTable.storeName,
      sectorId: usersTable.sectorId,
      sectorName: sectorsTable.name,
    })
    .from(usersTable)
    .leftJoin(sectorsTable, eq(usersTable.sectorId, sectorsTable.id))
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)))
    .orderBy(asc(usersTable.name));

  const favRows = await db.select({ favoritedUserId: teamFavoritesTable.favoritedUserId })
    .from(teamFavoritesTable)
    .where(and(eq(teamFavoritesTable.tenantId, tenantId), eq(teamFavoritesTable.userId, userId)));
  const favSet = new Set(favRows.map((f) => f.favoritedUserId));

  const contacts = rows
    .map((r) => ({ ...r, favorited: favSet.has(r.id) }))
    .sort((a, b) => Number(b.favorited) - Number(a.favorited) || a.name.localeCompare(b.name, "pt-BR"));

  res.json(contacts);
});

router.post("/team-directory/:userId/favorite", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const favoritedUserId = parseInt(String(req.params["userId"]), 10);
  if (!Number.isFinite(favoritedUserId)) { res.status(400).json({ error: "Usuário inválido" }); return; }
  const [target] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, favoritedUserId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }
  await db.insert(teamFavoritesTable)
    .values({ tenantId, userId: req.session.userId!, favoritedUserId })
    .onConflictDoNothing();
  res.json({ ok: true });
});

router.delete("/team-directory/:userId/favorite", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const favoritedUserId = parseInt(String(req.params["userId"]), 10);
  if (!Number.isFinite(favoritedUserId)) { res.status(400).json({ error: "Usuário inválido" }); return; }
  await db.delete(teamFavoritesTable)
    .where(and(
      eq(teamFavoritesTable.tenantId, tenantId),
      eq(teamFavoritesTable.userId, req.session.userId!),
      eq(teamFavoritesTable.favoritedUserId, favoritedUserId),
    ));
  res.json({ ok: true });
});

export default router;
