import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, attendanceLogsTable, attendanceStartEventsTable, conversationsTable, storesTable } from "@workspace/db";
import { and, eq, gte, lte, isNotNull, inArray, sql, desc } from "drizzle-orm";
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

// ── Lista detalhada de atendimentos (individual e coletivo) ─────────────────
// GET /relatorios/atendimentos?from=&to=&sectorId=&attendantId=&store=&resolutionReason=&hadSale=&origin=&outcome=&limit=&offset=
// Um registro por atendimento finalizado (attendance_logs) — a visão "crua"
// por trás dos comparativos acima. Sem attendantId = coletivo (todo mundo);
// com attendantId = individual (só aquele vendedor) — mesma tela, o filtro
// é o que muda a visão, sem precisar de duas rotas/páginas diferentes.
// "motivos" na resposta: todo motivo de finalização já usado no tenant
// (todo o histórico, não só o período filtrado — senão a lista de opções do
// filtro "pisca" toda vez que o período muda), pra popular o <select> sem
// precisar digitar o texto exato.
router.get("/relatorios/atendimentos", async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const { from, to } = range;

  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) || null : null;
  const attendantId = req.query.attendantId ? parseInt(String(req.query.attendantId), 10) || null : null;
  const store = typeof req.query.store === "string" && req.query.store.trim() ? req.query.store.trim().slice(0, 120) : null;
  const resolutionReason = typeof req.query.resolutionReason === "string" && req.query.resolutionReason.trim()
    ? req.query.resolutionReason.trim().slice(0, 200) : null;
  const hadSale = req.query.hadSale === "true" ? true : req.query.hadSale === "false" ? false : null;
  const origin = req.query.origin === "manual" ? "manual" : req.query.origin === "fila" ? "fila" : null;
  const outcome = typeof req.query.outcome === "string" && req.query.outcome.trim() ? req.query.outcome.trim().slice(0, 40) : null;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

  let storeUserIds: number[] | null = null;
  if (store) {
    const storeUsers = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.storeName, store)));
    storeUserIds = storeUsers.map((u) => u.id);
  }

  const conds = [eq(attendanceLogsTable.tenantId, tenantId), gte(attendanceLogsTable.createdAt, from), lte(attendanceLogsTable.createdAt, to)];
  if (sectorId) conds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) conds.push(eq(attendanceLogsTable.attendantId, attendantId));
  if (storeUserIds) conds.push(storeUserIds.length ? inArray(attendanceLogsTable.attendantId, storeUserIds) : sql`false`);
  if (resolutionReason) conds.push(eq(attendanceLogsTable.resolutionReason, resolutionReason));
  if (hadSale != null) conds.push(eq(attendanceLogsTable.hadSale, hadSale));
  if (origin) conds.push(eq(attendanceLogsTable.origin, origin));
  if (outcome) conds.push(eq(attendanceLogsTable.outcome, outcome));
  const where = and(...conds)!;

  const [totalRow] = await db.select({ n: sql<number>`count(*)::int` }).from(attendanceLogsTable).where(where);

  const rows = await db.select({
    id: attendanceLogsTable.id,
    createdAt: attendanceLogsTable.createdAt,
    clientName: attendanceLogsTable.clientName,
    clientContact: attendanceLogsTable.clientContact,
    sectorName: attendanceLogsTable.sectorName,
    attendantId: attendanceLogsTable.attendantId,
    attendantName: attendanceLogsTable.attendantName,
    outcome: attendanceLogsTable.outcome,
    resolutionReason: attendanceLogsTable.resolutionReason,
    origin: attendanceLogsTable.origin,
    hadSale: attendanceLogsTable.hadSale,
    saleAmount: attendanceLogsTable.saleAmount,
    conversationId: attendanceLogsTable.conversationId,
  }).from(attendanceLogsTable).where(where)
    .orderBy(desc(attendanceLogsTable.createdAt))
    .limit(limit).offset(offset);

  const motivoRows = await db.selectDistinct({ resolutionReason: attendanceLogsTable.resolutionReason })
    .from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.tenantId, tenantId), isNotNull(attendanceLogsTable.resolutionReason)));
  const motivos = motivoRows.map((m) => m.resolutionReason!).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));

  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    motivos,
    rows: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      saleAmount: r.saleAmount != null ? Number(r.saleAmount) : null,
    })),
  });
});

export default router;
