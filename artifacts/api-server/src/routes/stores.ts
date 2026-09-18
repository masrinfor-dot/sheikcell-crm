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

// Editar loja (renomear / ativar / desativar / geofence do Ponto)
router.patch("/stores/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const update: Partial<{ name: string; isActive: boolean; geofenceLat: number | null; geofenceLng: number | null; geofenceRadiusMeters: number | null; skipQueueEnabled: boolean }> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 120);
  if (typeof req.body?.isActive === "boolean") update.isActive = req.body.isActive;
  // "Pular fila" por palavra-chave (pedido 18/09) — participação desta loja
  // como candidata a receber conversa auto-atribuída por uma regra com
  // skipQueue=true. Ver comentário em stores.ts (schema) e skipQueueAssign.ts.
  if (typeof req.body?.skipQueueEnabled === "boolean") update.skipQueueEnabled = req.body.skipQueueEnabled;
  // Geofence do Ponto (pedido 15/09, análise Tangerino "Local de
  // Interesse") — os 3 campos vêm sempre juntos: ou os 3 preenchidos (liga o
  // geofence) ou os 3 null (desliga). Não dá pra configurar só um deles.
  if ("geofenceLat" in (req.body ?? {}) || "geofenceLng" in (req.body ?? {}) || "geofenceRadiusMeters" in (req.body ?? {})) {
    const lat = req.body.geofenceLat;
    const lng = req.body.geofenceLng;
    const radius = req.body.geofenceRadiusMeters;
    const allNull = lat == null && lng == null && radius == null;
    const allValid = typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90
      && typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180
      && typeof radius === "number" && Number.isFinite(radius) && radius >= 20 && radius <= 5000;
    if (allNull) {
      update.geofenceLat = null; update.geofenceLng = null; update.geofenceRadiusMeters = null;
    } else if (allValid) {
      update.geofenceLat = lat; update.geofenceLng = lng; update.geofenceRadiusMeters = Math.round(radius);
    } else {
      res.status(400).json({ error: "Geofence inválido — informe latitude, longitude e raio (20 a 5000 metros), ou os 3 vazios pra desligar" });
      return;
    }
  }
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
