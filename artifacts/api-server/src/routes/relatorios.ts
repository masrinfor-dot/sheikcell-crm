import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, attendanceLogsTable, attendanceStartEventsTable, conversationsTable, storesTable } from "@workspace/db";
import { and, eq, gte, lte, isNotNull, inArray, sql } from "drizzle-orm";
import { requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

// Comparativo entre vendedores e entre lojas — diferente de /results (que é
// auto-escopado: cada vendedor só vê os próprios números), aqui é sempre uma
// visão de conjunto. Se a pessoa recebeu acesso ao módulo "relatorios", vê o
// consolidado inteiro do tenant, com setor/loja/período como filtros
// opcionais de recorte — mesmo padrão já usado em /finance/summary.
const router: IRouter = Router();

router.use("/relatorios", requireModuleAccess("relatorios"));

function parseDateRange(req: Request, res: Response): { from: Date; to: Date } | null {
  const parseDate = (v: unknown): Date | null => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = parseDate(req.query.to) ?? new Date();
  const from = parseDate(req.query.from) ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) { res.status(400).json({ error: "Período inválido" }); return null; }
  return { from, to };
}

// Nota antiga sem escala registrada (satisfaction_scale_max null) é assumida
// como escala 1-5 — era o único padrão que existia antes desta coluna
// existir, não dá pra reconstruir qual escala foi usada de fato.
const percentExpr = sql<number>`coalesce(${attendanceLogsTable.satisfactionPercent}, round(((${attendanceLogsTable.satisfactionRating} - 1)::numeric / 4) * 100))`;

// ── Comparativo por vendedor ─────────────────────────────────────────────────
// GET /relatorios/vendedores?from=ISO&to=ISO&sectorId=&store=
router.get("/relatorios/vendedores", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const { from, to } = range;
  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) || null : null;
  const store = typeof req.query.store === "string" && req.query.store.trim() ? req.query.store.trim().slice(0, 120) : null;

  let storeUserIds: number[] | null = null;
  if (store) {
    const storeUsers = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.storeName, store)));
    storeUserIds = storeUsers.map((u) => u.id);
  }

  const logConds = [eq(attendanceLogsTable.tenantId, tenantId), gte(attendanceLogsTable.createdAt, from), lte(attendanceLogsTable.createdAt, to)];
  if (sectorId) logConds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (storeUserIds) logConds.push(storeUserIds.length ? inArray(attendanceLogsTable.attendantId, storeUserIds) : sql`false`);

  const logAgg = await db.select({
    attendantId: attendanceLogsTable.attendantId,
    atendimentos: sql<number>`count(*)::int`,
    finalizados: sql<number>`count(*) filter (where ${attendanceLogsTable.outcome} = 'completed')::int`,
    vendas: sql<number>`count(*) filter (where ${attendanceLogsTable.hadSale})::int`,
    totalVendido: sql<string>`coalesce(sum(${attendanceLogsTable.saleAmount}) filter (where ${attendanceLogsTable.hadSale}), 0)::text`,
    avgSatisfactionPercent: sql<string>`coalesce(round(avg(${percentExpr}) filter (where ${attendanceLogsTable.satisfactionRating} is not null)), 0)::text`,
  }).from(attendanceLogsTable)
    .where(and(...logConds, isNotNull(attendanceLogsTable.attendantId))!)
    .groupBy(attendanceLogsTable.attendantId);

  const startConds = [eq(attendanceStartEventsTable.tenantId, tenantId), gte(attendanceStartEventsTable.startedAt, from), lte(attendanceStartEventsTable.startedAt, to)];
  if (sectorId) startConds.push(eq(attendanceStartEventsTable.sectorId, sectorId));
  if (storeUserIds) startConds.push(storeUserIds.length ? inArray(attendanceStartEventsTable.attendantId, storeUserIds) : sql`false`);
  const startAgg = await db.select({
    attendantId: attendanceStartEventsTable.attendantId,
    iniciados: sql<number>`count(*)::int`,
  }).from(attendanceStartEventsTable).where(and(...startConds)).groupBy(attendanceStartEventsTable.attendantId);

  // Não resolvidos: ao vivo, não é limitado ao período do filtro (é "agora").
  const unresolvedConds = [
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.isArchived, false),
    inArray(conversationsTable.status, ["open", "pending"]),
    isNotNull(conversationsTable.assigneeId),
  ];
  if (sectorId) unresolvedConds.push(eq(conversationsTable.sectorId, sectorId));
  if (storeUserIds) unresolvedConds.push(storeUserIds.length ? inArray(conversationsTable.assigneeId, storeUserIds) : sql`false`);
  const unresolvedAgg = await db.select({
    attendantId: conversationsTable.assigneeId,
    naoResolvidos: sql<number>`count(*)::int`,
  }).from(conversationsTable).where(and(...unresolvedConds)).groupBy(conversationsTable.assigneeId);

  const ids = new Set<number>();
  for (const r of logAgg) if (r.attendantId != null) ids.add(r.attendantId);
  for (const r of startAgg) if (r.attendantId != null) ids.add(r.attendantId);
  for (const r of unresolvedAgg) if (r.attendantId != null) ids.add(r.attendantId);

  const users = ids.size
    ? await db.select({ id: usersTable.id, name: usersTable.name, isActive: usersTable.isActive })
        .from(usersTable).where(inArray(usersTable.id, [...ids]))
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const logMap = new Map(logAgg.map((r) => [r.attendantId, r]));
  const startMap = new Map(startAgg.map((r) => [r.attendantId, r.iniciados]));
  const unresolvedMap = new Map(unresolvedAgg.map((r) => [r.attendantId, r.naoResolvidos]));

  const rows = [...ids].map((attendantId) => {
    const u = userMap.get(attendantId);
    const l = logMap.get(attendantId);
    const atendimentos = l?.atendimentos ?? 0;
    const vendas = l?.vendas ?? 0;
    return {
      attendantId,
      name: u?.name ?? "Excluído",
      ativo: u?.isActive ?? false,
      atendimentos,
      iniciados: startMap.get(attendantId) ?? 0,
      finalizados: l?.finalizados ?? 0,
      naoResolvidos: unresolvedMap.get(attendantId) ?? 0,
      vendas,
      totalVendido: Number(l?.totalVendido ?? 0),
      conversao: atendimentos > 0 ? Math.round((vendas / atendimentos) * 100) : 0,
      avgSatisfactionPercent: Number(l?.avgSatisfactionPercent ?? 0),
    };
  }).sort((a, b) => b.atendimentos - a.atendimentos);

  res.json({ from: from.toISOString(), to: to.toISOString(), rows });
});

// ── Comparativo por loja ─────────────────────────────────────────────────────
// GET /relatorios/lojas?from=ISO&to=ISO&sectorId=
// Agrupado por storeId (snapshot gravado no momento do evento — ver
// attendance_logs.storeId/attendance_start_events.storeId). Registros sem
// loja (de antes desta feature existir, ou atendente nunca vinculado a uma
// loja) caem explicitamente no bucket "Sem loja" em vez de sumir da soma.
router.get("/relatorios/lojas", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const { from, to } = range;
  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) || null : null;

  const logConds = [eq(attendanceLogsTable.tenantId, tenantId), gte(attendanceLogsTable.createdAt, from), lte(attendanceLogsTable.createdAt, to)];
  if (sectorId) logConds.push(eq(attendanceLogsTable.sectorId, sectorId));

  const logAgg = await db.select({
    storeId: attendanceLogsTable.storeId,
    atendimentos: sql<number>`count(*)::int`,
    finalizados: sql<number>`count(*) filter (where ${attendanceLogsTable.outcome} = 'completed')::int`,
    vendas: sql<number>`count(*) filter (where ${attendanceLogsTable.hadSale})::int`,
    totalVendido: sql<string>`coalesce(sum(${attendanceLogsTable.saleAmount}) filter (where ${attendanceLogsTable.hadSale}), 0)::text`,
    avgSatisfactionPercent: sql<string>`coalesce(round(avg(${percentExpr}) filter (where ${attendanceLogsTable.satisfactionRating} is not null)), 0)::text`,
  }).from(attendanceLogsTable).where(and(...logConds)).groupBy(attendanceLogsTable.storeId);

  const startConds = [eq(attendanceStartEventsTable.tenantId, tenantId), gte(attendanceStartEventsTable.startedAt, from), lte(attendanceStartEventsTable.startedAt, to)];
  if (sectorId) startConds.push(eq(attendanceStartEventsTable.sectorId, sectorId));
  const startAgg = await db.select({
    storeId: attendanceStartEventsTable.storeId,
    iniciados: sql<number>`count(*)::int`,
  }).from(attendanceStartEventsTable).where(and(...startConds)).groupBy(attendanceStartEventsTable.storeId);

  const unresolvedConds = [
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.isArchived, false),
    inArray(conversationsTable.status, ["open", "pending"]),
  ];
  if (sectorId) unresolvedConds.push(eq(conversationsTable.sectorId, sectorId));
  const unresolvedAgg = await db.select({
    storeId: conversationsTable.storeId,
    naoResolvidos: sql<number>`count(*)::int`,
  }).from(conversationsTable).where(and(...unresolvedConds)).groupBy(conversationsTable.storeId);

  const ids = new Set<number>();
  for (const r of logAgg) if (r.storeId != null) ids.add(r.storeId);
  for (const r of startAgg) if (r.storeId != null) ids.add(r.storeId);
  for (const r of unresolvedAgg) if (r.storeId != null) ids.add(r.storeId);

  const stores = ids.size
    ? await db.select({ id: storesTable.id, name: storesTable.name }).from(storesTable).where(inArray(storesTable.id, [...ids]))
    : [];
  const storeMap = new Map(stores.map((s) => [s.id, s.name]));
  const logMap = new Map(logAgg.map((r) => [r.storeId, r]));
  const startMap = new Map(startAgg.map((r) => [r.storeId, r.iniciados]));
  const unresolvedMap = new Map(unresolvedAgg.map((r) => [r.storeId, r.naoResolvidos]));

  // "Sem loja": soma de tudo que tem storeId null nas 3 fontes, sempre
  // presente no resultado (mesmo zerado) pra deixar claro que existe.
  const nullLog = logMap.get(null);
  const buildRow = (storeId: number | null) => {
    const l = storeId != null ? logMap.get(storeId) : nullLog;
    const atendimentos = l?.atendimentos ?? 0;
    const vendas = l?.vendas ?? 0;
    return {
      storeId,
      name: storeId != null ? (storeMap.get(storeId) ?? "Excluída") : "Sem loja",
      atendimentos,
      iniciados: (storeId != null ? startMap.get(storeId) : startMap.get(null)) ?? 0,
      finalizados: l?.finalizados ?? 0,
      naoResolvidos: (storeId != null ? unresolvedMap.get(storeId) : unresolvedMap.get(null)) ?? 0,
      vendas,
      totalVendido: Number(l?.totalVendido ?? 0),
      conversao: atendimentos > 0 ? Math.round((vendas / atendimentos) * 100) : 0,
      avgSatisfactionPercent: Number(l?.avgSatisfactionPercent ?? 0),
    };
  };

  const rows = [...ids].map((storeId) => buildRow(storeId)).sort((a, b) => b.atendimentos - a.atendimentos);
  const semLoja = buildRow(null);
  if (semLoja.atendimentos > 0 || semLoja.iniciados > 0 || semLoja.naoResolvidos > 0) rows.push(semLoja);

  res.json({ from: from.toISOString(), to: to.toISOString(), rows });
});

export default router;
