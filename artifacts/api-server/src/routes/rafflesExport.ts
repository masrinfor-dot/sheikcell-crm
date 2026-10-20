// Sorteios vão para o ERP Prumo (17/10/2026). Aqui:
// - GET /raffles/export (admin): JSON (versão 1, kind "raffles") com TODOS os
//   sorteios da loja e TODOS os resultados (raffle_draws). O ERP importa em
//   Sorteios › Importar do CRM, sem duplicar (usa o id do CRM).
// - GET/PUT /raffles/moved: o admin desliga os sorteios aqui depois de
//   importar; a tela vira consulta com o link do ERP (ver lib/rafflesMoved.ts).
import { Router, type IRouter } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import {
  db, rafflesTable, raffleDrawsTable, sectorsTable, usersTable, tenantsTable, whatsappSessionsTable,
} from "@workspace/db";
import { requireAdmin, requireAuth, requireModule, requireTenant } from "../middlewares/auth";
import { rafflesErpUrl, rafflesMovedToErp, saveRafflesMoved } from "../lib/rafflesMoved";

const router: IRouter = Router();
router.use("/raffles", requireModule("sorteios"));

type RaffleRow = typeof rafflesTable.$inferSelect;
type DrawRow = typeof raffleDrawsTable.$inferSelect;

const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

/**
 * Monta o arquivo que o ERP importa. Setores, vendedores e números de WhatsApp
 * vão pelo NOME (os ids do CRM não existem no ERP) — viram o "regulamento".
 */
export function buildRafflesExport(input: {
  tenant: { id: number; name: string | null };
  raffles: RaffleRow[];
  draws: DrawRow[];
  sectorNames: Map<number, string>;
  userNames: Map<number, string>;
  sessionLabels: Map<string, string>;
  now?: Date;
}) {
  const name = <K>(m: Map<K, string>, k: K) => m.get(k) ?? String(k);
  return {
    version: 1,
    kind: "raffles",
    source: "sheikcell-crm",
    exportedAt: (input.now ?? new Date()).toISOString(),
    tenant: input.tenant,
    raffles: input.raffles.map((r) => ({
      id: r.id,
      name: r.name,
      prize: r.prize,
      storeName: r.storeName,
      messageTemplate: r.messageTemplate,
      winnersCount: r.winnersCount,
      recurrence: r.recurrence,
      dayOfWeek: r.dayOfWeek,
      dayOfMonth: r.dayOfMonth,
      periodDays: r.periodDays,
      clientTypes: strs(r.clientTypes),
      sectorNames: ids(r.sectorIds).map((id) => name(input.sectorNames, id)),
      vendedorNames: ids(r.vendedorIds).map((id) => name(input.userNames, id)),
      sessionLabels: strs(r.sessionKeys).map((k) => name(input.sessionLabels, k)),
      onlyResolved: r.onlyResolved,
      surveyRespondedOnly: r.surveyRespondedOnly,
      excludePreviousWinners: r.excludePreviousWinners,
      active: r.active,
      lastRunKey: r.lastRunKey,
      createdByName: r.createdById != null ? (input.userNames.get(r.createdById) ?? null) : null,
      createdAt: r.createdAt,
    })),
    draws: input.draws.map((d) => ({
      id: d.id,
      raffleId: d.raffleId,
      periodKey: d.periodKey,
      eligibleCount: d.eligibleCount,
      // Só o que importa no ERP: quem ganhou e se foi avisado.
      winners: ((d.winners as { phone?: string; name?: string; sent?: boolean; error?: string }[] | null) ?? [])
        .map((w) => ({ phone: w.phone ?? null, name: w.name ?? null, sent: w.sent === true, ...(w.error ? { error: w.error } : {}) })),
      createdAt: d.createdAt,
    })),
  };
}

router.get("/raffles/moved", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json({ moved: await rafflesMovedToErp(tenantId), erpUrl: await rafflesErpUrl(tenantId) });
});

router.put("/raffles/moved", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { moved, erpUrl } = (req.body ?? {}) as { moved?: unknown; erpUrl?: unknown };
  const url = typeof erpUrl === "string" ? erpUrl.trim().slice(0, 300) : undefined;
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) { res.status(400).json({ error: "Endereço do ERP inválido (comece com https://)" }); return; }
  await saveRafflesMoved(tenantId, {
    ...(typeof moved === "boolean" ? { moved } : {}),
    ...(url !== undefined ? { erpUrl: url } : {}),
  });
  res.json({ moved: await rafflesMovedToErp(tenantId), erpUrl: await rafflesErpUrl(tenantId) });
});

router.get("/raffles/export", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId)).limit(1);
  const raffles = await db.select().from(rafflesTable)
    .where(eq(rafflesTable.tenantId, tenantId)).orderBy(asc(rafflesTable.id));
  const raffleIds = raffles.map((r) => r.id);
  const [draws, sectors, users, sessions] = await Promise.all([
    raffleIds.length
      ? db.select().from(raffleDrawsTable).where(inArray(raffleDrawsTable.raffleId, raffleIds)).orderBy(asc(raffleDrawsTable.id))
      : Promise.resolve([] as DrawRow[]),
    db.select({ id: sectorsTable.id, name: sectorsTable.name }).from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId)),
    db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.tenantId, tenantId)),
    db.select({ sessionKey: whatsappSessionsTable.sessionKey, displayName: whatsappSessionsTable.displayName, phoneNumber: whatsappSessionsTable.phoneNumber })
      .from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId)),
  ]);
  const payload = buildRafflesExport({
    tenant: tenant ?? { id: tenantId, name: null },
    raffles,
    draws,
    sectorNames: new Map(sectors.map((s) => [s.id, s.name])),
    userNames: new Map(users.map((u) => [u.id, u.name])),
    sessionLabels: new Map(sessions.map((s) => [s.sessionKey, s.displayName || s.phoneNumber || s.sessionKey])),
  });
  const day = new Date().toISOString().slice(0, 10);
  // Trocas com o ERP: o arquivo baixado para o ERP entra no histórico (só a contagem).
  void import("../lib/erpExchanges").then((m) => m.recordErpExchange({
    tenantId, method: "FILE", path: "/raffles/export", httpStatus: 200, ok: true, durationMs: 0,
    itemCount: payload.raffles.length,
  })).catch(() => {});
  res.setHeader("Content-Disposition", `attachment; filename="sorteios-crm-${day}.json"`);
  res.json(payload);
});

export default router;
