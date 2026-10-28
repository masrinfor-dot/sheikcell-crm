import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, erpStoreLinksTable, storesTable, tenantErpIntegrationsTable, whatsappSessionsTable } from "@workspace/db";
import { requireAdmin, requireTenant } from "../middlewares/auth";
import { erpCredentials } from "../lib/erpSalesSync";
import { erpFetch } from "../lib/erpOsMessages";
import { withErpTenant } from "../lib/erpExchanges";
import {
  gamificationOverview, httpStatusOf, isUuid, retryFailedGamification, runTenantGamification,
} from "../lib/erpGamification";
import { pushTvSnapshot } from "../lib/erpTvWaiting";

// Pontuação do atendimento → gamificação do ERP e "Clientes esperando
// resposta" na TV das lojas do ERP (27/10/2026). Só admin da loja.
const router: IRouter = Router();

async function tvStatus(tenantId: number) {
  const [row] = await db.select({
    enabled: tenantErpIntegrationsTable.tvWaitingEnabled,
    lastPushAt: tenantErpIntegrationsTable.tvWaitingLastPushAt,
    lastError: tenantErpIntegrationsTable.tvWaitingLastError,
  }).from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  const links = await db.select({ kind: erpStoreLinksTable.kind }).from(erpStoreLinksTable).where(eq(erpStoreLinksTable.tenantId, tenantId));
  return { enabled: row?.enabled ?? false, lastPushAt: row?.lastPushAt ?? null, lastError: row?.lastError ?? null, links: links.length };
}

async function fullStatus(tenantId: number) {
  return { ...(await gamificationOverview(tenantId)), tv: await tvStatus(tenantId) };
}

router.get("/settings/erp/gamification", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await fullStatus(tenantId));
});

router.patch("/settings/erp/gamification", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { enabled, tvEnabled } = (req.body ?? {}) as { enabled?: unknown; tvEnabled?: unknown };
  if ((enabled !== undefined && typeof enabled !== "boolean") || (tvEnabled !== undefined && typeof tvEnabled !== "boolean")
    || (enabled === undefined && tvEnabled === undefined)) {
    res.status(400).json({ error: "Informe enabled e/ou tvEnabled (true/false)" });
    return;
  }
  const [row] = await db.select({ enabled: tenantErpIntegrationsTable.gamificationEnabled })
    .from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  if (!row) { res.status(400).json({ error: "Ligue o ERP primeiro (endereço e chave)" }); return; }
  await db.update(tenantErpIntegrationsTable).set({
    ...(enabled !== undefined ? {
      gamificationEnabled: enabled,
      // Religar começa de novo a partir de agora (o período desligado não conta).
      ...(enabled && !row.enabled ? { gamificationSince: null, gamificationLastError: null } : {}),
    } : {}),
    ...(tvEnabled !== undefined ? { tvWaitingEnabled: tvEnabled, ...(tvEnabled ? {} : { tvWaitingLastError: null }) } : {}),
    updatedAt: new Date(),
  }).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
  res.json(await fullStatus(tenantId));
});

router.post("/settings/erp/gamification/run", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const gamification = await runTenantGamification(tenantId);
  const tv = await pushTvSnapshot(tenantId);
  res.json({ gamification, tv, status: await fullStatus(tenantId) });
});

router.post("/settings/erp/gamification/retry", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const n = await retryFailedGamification(tenantId);
  res.json({ requeued: n, status: await fullStatus(tenantId) });
});

// ─── Lojas do CRM / linhas → lojas do ERP ───────────────────────────────────

type ErpStore = { id: string; code: string | null; name: string };

async function erpStoresFor(tenantId: number): Promise<{ stores: ErpStore[] | null; error: string | null }> {
  const cred = await erpCredentials(tenantId);
  if (!cred) return { stores: null, error: "Ligue o ERP primeiro (endereço e chave)." };
  try {
    const r = await withErpTenant(tenantId, () => erpFetch(cred.baseUrl, cred.apiKey, "/integrations/stores", undefined, 10_000)) as unknown;
    const list = Array.isArray(r) ? r : [];
    return {
      stores: list
        .filter((s): s is { id: string; code?: string | null; name: string } => !!s && isUuid((s as { id?: unknown }).id) && typeof (s as { name?: unknown }).name === "string")
        .map((s) => ({ id: s.id, code: s.code ?? null, name: s.name })),
      error: null,
    };
  } catch (err) {
    const status = httpStatusOf(err);
    return {
      stores: null,
      error: status === 403
        ? "A chave do ERP não tem o acesso \"Lojas\" — gere a chave nova no ERP marcando também esse acesso."
        : `Não deu para buscar as lojas do ERP agora: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`,
    };
  }
}

async function crmSide(tenantId: number) {
  const [stores, lines, links] = await Promise.all([
    db.select({ id: storesTable.id, name: storesTable.name }).from(storesTable)
      .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true))).orderBy(storesTable.name),
    db.select({ sessionKey: whatsappSessionsTable.sessionKey, displayName: whatsappSessionsTable.displayName, phoneNumber: whatsappSessionsTable.phoneNumber, lineType: whatsappSessionsTable.lineType })
      .from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId)).orderBy(whatsappSessionsTable.id),
    db.select().from(erpStoreLinksTable).where(eq(erpStoreLinksTable.tenantId, tenantId)),
  ]);
  return {
    crmStores: stores,
    lines: [
      ...lines.filter((l) => l.lineType !== "interna").map((l) => ({
        ref: l.sessionKey,
        label: l.displayName || (l.phoneNumber ? l.phoneNumber.replace(/@.*$/, "") : l.sessionKey === "default" ? "Principal" : l.sessionKey),
      })),
      { ref: "instagram", label: "Instagram" },
    ],
    links: links.map((l) => ({ kind: l.kind, crmRef: l.crmRef, erpStoreId: l.erpStoreId, erpStoreName: l.erpStoreName })),
  };
}

router.get("/settings/erp/store-links", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [crm, erp] = await Promise.all([crmSide(tenantId), erpStoresFor(tenantId)]);
  res.json({ ...crm, erpStores: erp.stores, erpStoresError: erp.error });
});

router.put("/settings/erp/store-links", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = (req.body ?? {}) as { links?: unknown };
  if (!Array.isArray(body.links) || body.links.length > 300) {
    res.status(400).json({ error: "Informe links: [{ kind, crmRef, erpStoreId }] (até 300)" });
    return;
  }
  const crm = await crmSide(tenantId);
  const storeRefs = new Set(crm.crmStores.map((s) => String(s.id)));
  const lineRefs = new Set(crm.lines.map((l) => l.ref));
  const erp = await erpStoresFor(tenantId);
  const erpById = erp.stores ? new Map(erp.stores.map((s) => [s.id, s])) : null;
  const clean: { kind: "store" | "line"; crmRef: string; erpStoreId: string | null }[] = [];
  for (const raw of body.links as unknown[]) {
    const l = (raw ?? {}) as { kind?: unknown; crmRef?: unknown; erpStoreId?: unknown };
    const kind = l.kind === "store" || l.kind === "line" ? l.kind : null;
    const crmRef = typeof l.crmRef === "string" || typeof l.crmRef === "number" ? String(l.crmRef) : "";
    if (!kind || !(kind === "store" ? storeRefs : lineRefs).has(crmRef)) {
      res.status(400).json({ error: "Loja ou linha do CRM inválida" });
      return;
    }
    if (l.erpStoreId !== null && l.erpStoreId !== "" && !isUuid(l.erpStoreId)) {
      res.status(400).json({ error: "Loja do ERP inválida" });
      return;
    }
    const erpStoreId = l.erpStoreId ? String(l.erpStoreId).toLowerCase() : null;
    // Com a lista do ERP em mãos, só aceita loja que existe lá (deste cliente).
    if (erpStoreId && erpById && !erpById.has(erpStoreId)) {
      res.status(400).json({ error: "Essa loja não existe no ERP (ou está desativada)" });
      return;
    }
    clean.push({ kind, crmRef, erpStoreId });
  }
  for (const l of clean) {
    if (!l.erpStoreId) {
      await db.delete(erpStoreLinksTable).where(and(eq(erpStoreLinksTable.tenantId, tenantId), eq(erpStoreLinksTable.kind, l.kind), eq(erpStoreLinksTable.crmRef, l.crmRef)));
      continue;
    }
    const name = erpById?.get(l.erpStoreId)?.name ?? null;
    await db.insert(erpStoreLinksTable)
      .values({ tenantId, kind: l.kind, crmRef: l.crmRef, erpStoreId: l.erpStoreId, erpStoreName: name })
      .onConflictDoUpdate({
        target: [erpStoreLinksTable.tenantId, erpStoreLinksTable.kind, erpStoreLinksTable.crmRef],
        set: { erpStoreId: l.erpStoreId, ...(name ? { erpStoreName: name } : {}), updatedAt: new Date() },
      });
  }
  res.json({ ...(await crmSide(tenantId)), erpStores: erp.stores, erpStoresError: erp.error });
});

export default router;
