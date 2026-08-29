import { Router, type IRouter } from "express";
import { db, storesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { assertWithinLimit } from "../lib/planLimits";

const router: IRouter = Router();

// Lista de lojas — todo usuário autenticado pode ver (alimenta os selects
// de cadastro de vendedor e de cliente). Sempre dentro da loja (tenant).
router.get("/stores", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const includeInactive = req.query.all === "1" && req.session.userRole === "admin";
  const rows = includeInactive
    ? await db.select().from(storesTable).where(eq(storesTable.tenantId, tenantId)).orderBy(asc(storesTable.name))
    : await db.select().from(storesTable).where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true))).orderBy(asc(storesTable.name));
  res.json(rows);
});

// Cadastrar loja (só admin)
router.post("/stores", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  if (!name) { res.status(400).json({ error: "Informe o nome da loja" }); return; }
  // Limite do plano (Fase 3 — Planos & Limites): teto de lojas/filiais.
  const limitCheck = await assertWithinLimit(tenantId, "maxBranches");
  if (!limitCheck.ok) { res.status(400).json({ error: limitCheck.error }); return; }
  try {
    const [store] = await db.insert(storesTable).values({ tenantId, name }).returning();
    res.status(201).json(store);
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "Já existe uma loja com esse nome" });
      return;
    }
    console.error("[stores] falha ao criar loja:", err);
    res.status(500).json({ error: "Erro ao cadastrar loja" });
  }
});

// Valida um nome de loja enviado em outros cadastros: precisa existir na
// lista de lojas ativas DA LOJA (tenant), ser o valor legado inalterado, ou a
// lista estar vazia (instalações antigas sem lojas cadastradas continuam com
// texto livre).
export async function isValidStoreName(name: string, tenantId: number, currentValue?: string | null): Promise<boolean> {
  if (currentValue != null && name === currentValue) return true;
  const stores = await db.select({ name: storesTable.name }).from(storesTable)
    .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true)));
  if (stores.length === 0) return true;
  return stores.some((s) => s.name === name);
}

// Editar loja (renomear / ativar / desativar)
router.patch("/stores/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const update: Partial<{ name: string; isActive: boolean }> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 120);
  if (typeof req.body?.isActive === "boolean") update.isActive = req.body.isActive;
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  try {
    const [store] = await db.update(storesTable).set(update)
      .where(and(eq(storesTable.id, id), eq(storesTable.tenantId, tenantId))).returning();
    if (!store) { res.status(404).json({ error: "Loja não encontrada" }); return; }
    res.json(store);
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "Já existe uma loja com esse nome" });
      return;
    }
    console.error("[stores] falha ao atualizar loja:", err);
    res.status(500).json({ error: "Erro ao atualizar loja" });
  }
});

export default router;
