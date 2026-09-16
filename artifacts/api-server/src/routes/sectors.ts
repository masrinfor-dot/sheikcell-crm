import { Router, type IRouter } from "express";
import {
  db, sectorsTable, tenantsTable, usersTable, routingRulesTable, conversationsTable,
  quickRepliesTable, whatsappSessionsTable, OPTIONAL_MODULES, type OptionalModule,
} from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { assertWithinLimit } from "../lib/planLimits";

const router: IRouter = Router();

// Módulos que a LOJA contratou — nunca deixa um setor "liberar" um módulo
// que a própria loja não tem (mesma cautela de intersectModuleAccess em
// admin.ts, mas pra um array simples em vez de um mapa view/edit).
async function tenantEnabledModules(tenantId: number): Promise<Set<string>> {
  const [row] = await db.select({ enabledModules: tenantsTable.enabledModules })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  return new Set(row?.enabledModules ?? []);
}

// null (ou tipo inválido) = sem restrição — igual a nunca ter configurado
// nada. Array (mesmo [] de propósito — setor sem NENHUM módulo opcional
// liberado) = lista explícita, filtrada só pro que a loja já contratou.
function sanitizeSectorModules(input: unknown, tenantModules: Set<string>): OptionalModule[] | null {
  if (input === null || !Array.isArray(input)) return null;
  const valid = new Set<string>(OPTIONAL_MODULES);
  return [...new Set(input)].filter((m): m is OptionalModule => typeof m === "string" && valid.has(m) && tenantModules.has(m));
}

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
  const { name, description, icon, color, enabledModules } = req.body as {
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    enabledModules?: unknown;
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
    .values({
      tenantId, name, description, icon: icon ?? "smartphone", color: color ?? "#1a2e6e",
      enabledModules: enabledModules !== undefined ? sanitizeSectorModules(enabledModules, await tenantEnabledModules(tenantId)) : null,
    })
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
  const { name, description, icon, color, isActive, enabledModules, vendorsSeeResolved } = req.body as {
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    isActive?: boolean;
    enabledModules?: unknown;
    vendorsSeeResolved?: boolean;
  };
  const [sector] = await db
    .update(sectorsTable)
    .set({
      name, description, icon, color, isActive, vendorsSeeResolved,
      enabledModules: enabledModules !== undefined ? sanitizeSectorModules(enabledModules, await tenantEnabledModules(tenantId)) : undefined,
    })
    .where(and(eq(sectorsTable.id, id), eq(sectorsTable.tenantId, tenantId)))
    .returning();
  if (!sector) {
    res.status(404).json({ error: "Setor não encontrado" });
    return;
  }
  res.json(sector);
});

// Excluir setor de vez (pedido 16/09) — até então só dava pra "desativar"
// (isActive=false) pelo modal de edição, o setor continuava aparecendo na
// lista (marcado Inativo) pra sempre. Diferente de desativar, isto REMOVE a
// linha — por isso bloqueia se ainda houver gente vinculada (usuário
// perderia o setor sem ninguém perceber) ou regra de direcionamento
// automático usando este setor (routing_rules.sectorId é NOT NULL, não dá
// pra só "desvincular"). Onde a referência é opcional (conversas antigas,
// respostas rápidas, número de WhatsApp com setor padrão) o vínculo é só
// desfeito (vira null) — não trava a exclusão nem apaga histórico.
router.delete("/sectors/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [sector] = await db.select().from(sectorsTable)
    .where(and(eq(sectorsTable.id, id), eq(sectorsTable.tenantId, tenantId))).limit(1);
  if (!sector) { res.status(404).json({ error: "Setor não encontrado" }); return; }

  const [{ value: usersLinked }] = await db.select({ value: count() }).from(usersTable)
    .where(and(eq(usersTable.sectorId, id), eq(usersTable.tenantId, tenantId)));
  if (usersLinked > 0) {
    res.status(400).json({
      error: `Existe${usersLinked > 1 ? "m" : ""} ${usersLinked} usuário${usersLinked > 1 ? "s" : ""} vinculado${usersLinked > 1 ? "s" : ""} a este setor. Mude o setor dele${usersLinked > 1 ? "s" : ""} (Administração → Usuários) antes de excluir.`,
    });
    return;
  }

  await db.transaction(async (tx) => {
    // Referências opcionais: desvincula (não apaga histórico nenhum).
    await tx.update(conversationsTable).set({ sectorId: null })
      .where(and(eq(conversationsTable.sectorId, id), eq(conversationsTable.tenantId, tenantId)));
    await tx.update(quickRepliesTable).set({ sectorId: null })
      .where(and(eq(quickRepliesTable.sectorId, id), eq(quickRepliesTable.tenantId, tenantId)));
    await tx.update(whatsappSessionsTable).set({ defaultSectorId: null })
      .where(and(eq(whatsappSessionsTable.defaultSectorId, id), eq(whatsappSessionsTable.tenantId, tenantId)));
    // routing_rules.sectorId é obrigatório (NOT NULL) — regra sem setor não
    // faz sentido, por isso a regra em si é excluída junto.
    await tx.delete(routingRulesTable)
      .where(and(eq(routingRulesTable.sectorId, id), eq(routingRulesTable.tenantId, tenantId)));
    await tx.delete(sectorsTable)
      .where(and(eq(sectorsTable.id, id), eq(sectorsTable.tenantId, tenantId)));
  });

  res.json({ ok: true });
});

export default router;
