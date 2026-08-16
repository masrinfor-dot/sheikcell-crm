import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, attendanceLogsTable, attendanceStartEventsTable, conversationsTable, storesTable } from "@workspace/db";
import { and, eq, gte, lte, lt, isNotNull, inArray, sql, desc } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();

router.use("/results", requireModuleAccess("resultados"));

// Mesmo escopo fail-closed já usado por /results/summary: admin/supervisor
// filtram livremente; vendedor é travado no próprio setor+usuário no
// servidor, ignorando qualquer filtro pedido. Compartilhado pelos novos
// endpoints abaixo pra não triplicar essa lógica.
async function resolveVendorScope(req: Request, res: Response, tenantId: number): Promise<{
  sectorId: number | null; attendantId: number | null; store: string | null;
  storeId: number | null; storeUserIds: number[] | null;
} | null> {
  const userId = req.session.userId!;
  const [me] = await db
    .select({ id: usersTable.id, role: usersTable.role, sectorId: usersTable.sectorId })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
  if (!me) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const isGlobal = me.role === "admin" || me.role === "supervisor";

  let sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) || null : null;
  let attendantId = req.query.attendantId ? parseInt(String(req.query.attendantId), 10) || null : null;
  let store = typeof req.query.store === "string" && req.query.store.trim() ? req.query.store.trim().slice(0, 120) : null;

  if (!isGlobal) {
    if (!me.sectorId) { res.status(403).json({ error: "Vendedor sem setor" }); return null; }
    sectorId = me.sectorId;
    attendantId = me.id;
    store = null;
  }

  let storeId: number | null = null;
  let storeUserIds: number[] | null = null;
  if (store) {
    const [s] = await db.select({ id: storesTable.id }).from(storesTable)
      .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.name, store))).limit(1);
    storeId = s?.id ?? null;
    const storeUsers = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.storeName, store)));
    storeUserIds = storeUsers.map((u) => u.id);
  }
  return { sectorId, attendantId, store, storeId, storeUserIds };
}

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

// ── Painel de Resultados ─────────────────────────────────────────────────────
// GET /results/summary?from=ISO&to=ISO&sectorId=&attendantId=
// Métricas agregadas da operação: tempos, atendimentos, leads e ranking.
// Admin/supervisor: veem tudo (com filtros livres). Vendedor: travado no
// próprio setor (fail closed) — pode filtrar por vendedor dentro do setor.
router.get("/results/summary", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const [me] = await db
    .select({ id: usersTable.id, role: usersTable.role, sectorId: usersTable.sectorId })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
  if (!me) { res.status(401).json({ error: "Unauthorized" }); return; }

  const isGlobal = me.role === "admin" || me.role === "supervisor";

  // Período: from/to em ISO; padrão = últimos 30 dias.
  const parseDate = (v: unknown): Date | null => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = parseDate(req.query.to) ?? new Date();
  const from = parseDate(req.query.from) ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) { res.status(400).json({ error: "Período inválido" }); return; }

  let sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) || null : null;
  let attendantId = req.query.attendantId ? parseInt(String(req.query.attendantId), 10) || null : null;
  let store = typeof req.query.store === "string" && req.query.store.trim() ? req.query.store.trim().slice(0, 120) : null;

  // Vendedor: sempre restrito ao próprio setor E aos próprios números —
  // qualquer filtro pedido é ignorado (fail closed, servidor manda).
  if (!isGlobal) {
    if (!me.sectorId) { res.status(403).json({ error: "Vendedor sem setor" }); return; }
    sectorId = me.sectorId;
    attendantId = me.id;
    store = null; // filtro por loja é exclusivo de admin/supervisor
  }

  // Filtro por loja da rede: métricas do conjunto de vendedores daquela loja
  // (users.store_name), sempre dentro do tenant. Loja sem vendedor ⇒ zero.
  let storeUserIds: number[] | null = null;
  if (store) {
    const storeUsers = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.storeName, store)));
    storeUserIds = storeUsers.map((u) => u.id);
  }

  const logConds = [
    eq(attendanceLogsTable.tenantId, tenantId),
    gte(attendanceLogsTable.createdAt, from),
    lte(attendanceLogsTable.createdAt, to),
  ];
  if (sectorId) logConds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) logConds.push(eq(attendanceLogsTable.attendantId, attendantId));
  if (storeUserIds) {
    // loja sem vendedores ⇒ condição impossível (zero resultados, nunca vaza tudo)
    logConds.push(storeUserIds.length ? inArray(attendanceLogsTable.attendantId, storeUserIds) : sql`false`);
  }
  const logWhere = and(...logConds)!;

  // ── Totais do período (attendance_logs) ──
  const [totals] = await db.select({
    atendimentos: sql<number>`count(*)::int`,
    avgServiceSeconds: sql<number>`coalesce(round(avg(${attendanceLogsTable.serviceTimeSeconds}) filter (where ${attendanceLogsTable.serviceTimeSeconds} is not null)), 0)::int`,
    avgWaitSeconds: sql<number>`coalesce(round(avg(${attendanceLogsTable.waitTimeSeconds}) filter (where ${attendanceLogsTable.waitTimeSeconds} is not null)), 0)::int`,
    avgFirstResponseSeconds: sql<number>`coalesce(round(avg(${attendanceLogsTable.firstResponseSeconds}) filter (where ${attendanceLogsTable.firstResponseSeconds} is not null)), 0)::int`,
    vendas: sql<number>`count(*) filter (where ${attendanceLogsTable.hadSale})::int`,
    totalVendido: sql<string>`coalesce(sum(${attendanceLogsTable.saleAmount}) filter (where ${attendanceLogsTable.hadSale}), 0)::text`,
    avgRating: sql<string>`coalesce(round(avg(${attendanceLogsTable.satisfactionRating}) filter (where ${attendanceLogsTable.satisfactionRating} is not null), 1), 0)::text`,
    ratings: sql<number>`count(*) filter (where ${attendanceLogsTable.satisfactionRating} is not null)::int`,
  }).from(attendanceLogsTable).where(logWhere);

  // ── Ranking dos vendedores no período ──
  const rankingAgg = await db.select({
    attendantId: attendanceLogsTable.attendantId,
    atendimentos: sql<number>`count(*)::int`,
    avgServiceSeconds: sql<number>`coalesce(round(avg(${attendanceLogsTable.serviceTimeSeconds}) filter (where ${attendanceLogsTable.serviceTimeSeconds} is not null)), 0)::int`,
    vendas: sql<number>`count(*) filter (where ${attendanceLogsTable.hadSale})::int`,
    totalVendido: sql<string>`coalesce(sum(${attendanceLogsTable.saleAmount}) filter (where ${attendanceLogsTable.hadSale}), 0)::text`,
    avgRating: sql<string>`coalesce(round(avg(${attendanceLogsTable.satisfactionRating}) filter (where ${attendanceLogsTable.satisfactionRating} is not null), 1), 0)::text`,
    ratings: sql<number>`count(*) filter (where ${attendanceLogsTable.satisfactionRating} is not null)::int`,
  }).from(attendanceLogsTable)
    .where(and(logWhere, isNotNull(attendanceLogsTable.attendantId))!)
    .groupBy(attendanceLogsTable.attendantId);

  const rankUserIds = rankingAgg.map((r) => r.attendantId!).filter(Boolean);
  const rankUsers = rankUserIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name, sectorId: usersTable.sectorId, isActive: usersTable.isActive })
        .from(usersTable).where(and(eq(usersTable.tenantId, tenantId), sql`${usersTable.id} in (${sql.join(rankUserIds.map((i) => sql`${i}`), sql`, `)})`))
    : [];
  const rankUserMap = new Map(rankUsers.map((u) => [u.id, u]));

  const ranking = rankingAgg.map((r) => {
    const u = rankUserMap.get(r.attendantId!);
    return {
      attendantId: r.attendantId!,
      name: u?.name ?? "Excluído",
      ativo: u?.isActive ?? false,
      atendimentos: r.atendimentos,
      avgServiceSeconds: r.avgServiceSeconds,
      vendas: r.vendas,
      totalVendido: Number(r.totalVendido),
      conversao: r.atendimentos > 0 ? Math.round((r.vendas / r.atendimentos) * 100) : 0,
      avgRating: Number(r.avgRating),
      ratings: r.ratings,
    };
  }).sort((a, b) => b.atendimentos - a.atendimentos || b.totalVendido - a.totalVendido);

  // ── Satisfação por setor (pesquisa pós-atendimento, nota 1–5) ──
  const satisfacaoPorSetor = (await db.select({
    sectorId: attendanceLogsTable.sectorId,
    sectorName: sql<string>`max(${attendanceLogsTable.sectorName})`,
    avgRating: sql<string>`round(avg(${attendanceLogsTable.satisfactionRating}), 1)::text`,
    ratings: sql<number>`count(*)::int`,
  }).from(attendanceLogsTable)
    .where(and(logWhere, isNotNull(attendanceLogsTable.satisfactionRating))!)
    .groupBy(attendanceLogsTable.sectorId))
    .map((s) => ({ sectorId: s.sectorId, sectorName: s.sectorName, avgRating: Number(s.avgRating), ratings: s.ratings }))
    .sort((a, b) => b.avgRating - a.avgRating);

  // ── Leads: novos (conversas criadas no período) e recorrentes (cliente que
  // voltou: telefone com atendimento no período E atendimento anterior ao período).
  // Filtro por vendedor também nas métricas de leads/CRM: conversas do
  // responsável e clientes da carteira dele (obrigatório para vendedor).
  // Todas as métricas abaixo são restritas à loja (tenant) — fail closed.
  const storeIdsSql = storeUserIds
    ? (storeUserIds.length ? sql`(${sql.join(storeUserIds.map((i) => sql`${i}`), sql`, `)})` : null)
    : undefined; // undefined = sem filtro de loja; null = loja sem vendedores
  const sectorSql = sectorId ? sql` and c.sector_id = ${sectorId}` : sql``;
  const convAttSql = attendantId
    ? sql` and c.assignee_id = ${attendantId}`
    : storeIdsSql === null ? sql` and false`
    : storeIdsSql ? sql` and c.assignee_id in ${storeIdsSql}` : sql``;
  const newLeadsRow = await db.execute(sql`
    select count(*)::int as novos
    from conversations c
    where c.tenant_id = ${tenantId} and c.created_at >= ${from} and c.created_at <= ${to}${sectorSql}${convAttSql}
  `);
  const newLeads = Number((newLeadsRow.rows[0] as { novos: number } | undefined)?.novos ?? 0);

  const logSectorSql = sectorId ? sql` and l.sector_id = ${sectorId}` : sql``;
  const logAttSql = attendantId
    ? sql` and l.attendant_id = ${attendantId}`
    : storeIdsSql === null ? sql` and false`
    : storeIdsSql ? sql` and l.attendant_id in ${storeIdsSql}` : sql``;
  const recurringRow = await db.execute(sql`
    select count(distinct l.client_contact)::int as recorrentes
    from attendance_logs l
    where l.tenant_id = ${tenantId} and l.client_contact is not null and l.client_contact <> ''
      and l.created_at >= ${from} and l.created_at <= ${to}${logSectorSql}${logAttSql}
      and exists (
        select 1 from attendance_logs prev
        where prev.tenant_id = ${tenantId} and prev.client_contact = l.client_contact and prev.created_at < ${from}
      )
  `);
  const recurringLeads = Number((recurringRow.rows[0] as { recorrentes: number } | undefined)?.recorrentes ?? 0);

  // ── Recompra: clientes do CRM com mais de uma compra, sendo ao menos uma no período.
  const crmSectorSql = sectorId ? sql` and ct.sector_id = ${sectorId}` : sql``;
  const crmAttSql = attendantId
    ? sql` and ct.attendant_id = ${attendantId}`
    : storeIdsSql === null ? sql` and false`
    : storeIdsSql ? sql` and ct.attendant_id in ${storeIdsSql}` : sql``;
  const repurchaseRow = await db.execute(sql`
    select count(*)::int as recompra from (
      select p.contact_id
      from crm_purchases p
      join crm_contacts ct on ct.id = p.contact_id
      where ct.tenant_id = ${tenantId}${crmSectorSql}${crmAttSql}
      group by p.contact_id
      having count(*) > 1
         and bool_or(p.purchase_date >= ${from} and p.purchase_date <= ${to})
    ) t
  `);
  const repurchaseClients = Number((repurchaseRow.rows[0] as { recompra: number } | undefined)?.recompra ?? 0);

  // ── Leads por mês (últimos 6 meses, independente do filtro de período) ──
  const monthlyRows = await db.execute(sql`
    select to_char(date_trunc('month', c.created_at), 'YYYY-MM') as mes,
           count(*)::int as novos
    from conversations c
    where c.tenant_id = ${tenantId} and c.created_at >= date_trunc('month', now()) - interval '5 months'${sectorSql}${convAttSql}
    group by 1 order by 1
  `);
  const leadsPorMes = (monthlyRows.rows as { mes: string; novos: number }[]).map((r) => ({
    mes: r.mes, novos: Number(r.novos),
  }));

  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    sectorId,
    attendantId,
    store,
    totals: {
      atendimentos: Number(totals?.atendimentos ?? 0),
      avgServiceSeconds: Number(totals?.avgServiceSeconds ?? 0),
      avgWaitSeconds: Number(totals?.avgWaitSeconds ?? 0),
      avgFirstResponseSeconds: Number(totals?.avgFirstResponseSeconds ?? 0),
      vendas: Number(totals?.vendas ?? 0),
      totalVendido: Number(totals?.totalVendido ?? 0),
      newLeads,
      recurringLeads,
      repurchaseClients,
      avgRating: Number(totals?.avgRating ?? 0),
      ratings: Number(totals?.ratings ?? 0),
    },
    ranking,
    leadsPorMes,
    satisfacaoPorSetor,
  });
});

// ── Atividade diária: iniciados x finalizados ───────────────────────────────
// GET /results/activity?from=ISO&to=ISO&sectorId=&attendantId=&store=
// "Iniciados" vem de attendance_start_events (log à parte, só existe a
// partir do deploy desta feature — dia anterior a isso sempre mostra 0
// mesmo que tenha havido atendimento real, o dado já não existia pra
// registrar). "Finalizados" vem de attendance_logs (sempre existiu).
router.get("/results/activity", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const scope = await resolveVendorScope(req, res, tenantId); if (!scope) return;
  const { sectorId, attendantId, storeUserIds } = scope;
  const { from, to } = range;

  const startConds = [
    eq(attendanceStartEventsTable.tenantId, tenantId),
    gte(attendanceStartEventsTable.startedAt, from),
    lte(attendanceStartEventsTable.startedAt, to),
  ];
  if (sectorId) startConds.push(eq(attendanceStartEventsTable.sectorId, sectorId));
  if (attendantId) startConds.push(eq(attendanceStartEventsTable.attendantId, attendantId));
  if (storeUserIds) startConds.push(storeUserIds.length ? inArray(attendanceStartEventsTable.attendantId, storeUserIds) : sql`false`);

  const startedRows = await db.select({
    dia: sql<string>`to_char(date_trunc('day', ${attendanceStartEventsTable.startedAt}), 'YYYY-MM-DD')`,
    n: sql<number>`count(*)::int`,
  }).from(attendanceStartEventsTable).where(and(...startConds))
    .groupBy(sql`date_trunc('day', ${attendanceStartEventsTable.startedAt})`);

  const logConds = [
    eq(attendanceLogsTable.tenantId, tenantId),
    eq(attendanceLogsTable.outcome, "completed"),
    gte(attendanceLogsTable.createdAt, from),
    lte(attendanceLogsTable.createdAt, to),
  ];
  if (sectorId) logConds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) logConds.push(eq(attendanceLogsTable.attendantId, attendantId));
  if (storeUserIds) logConds.push(storeUserIds.length ? inArray(attendanceLogsTable.attendantId, storeUserIds) : sql`false`);

  const finishedRows = await db.select({
    dia: sql<string>`to_char(date_trunc('day', ${attendanceLogsTable.createdAt}), 'YYYY-MM-DD')`,
    n: sql<number>`count(*)::int`,
  }).from(attendanceLogsTable).where(and(...logConds))
    .groupBy(sql`date_trunc('day', ${attendanceLogsTable.createdAt})`);

  const byDay = new Map<string, { iniciados: number; finalizados: number }>();
  for (const r of startedRows) byDay.set(r.dia, { iniciados: r.n, finalizados: byDay.get(r.dia)?.finalizados ?? 0 });
  for (const r of finishedRows) byDay.set(r.dia, { iniciados: byDay.get(r.dia)?.iniciados ?? 0, finalizados: r.n });

  const series = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dia, v]) => ({ dia, ...v }));

  res.json({ from: from.toISOString(), to: to.toISOString(), series });
});

// ── Atendimentos não resolvidos (ao vivo) ───────────────────────────────────
// GET /results/unresolved?sectorId=&attendantId=&store=&thresholdHours=
// Consulta ao VIVO (sem histórico persistido): conversas abertas/pendentes,
// sem resolução, paradas há mais de thresholdHours. Usa conversations.storeId
// (snapshot) pro filtro de loja — é justamente aqui que a coluna nova importa
// de verdade, já que um atendimento travado costuma estar SEM responsável
// (assigneeId null), então não dá pra filtrar por loja via attendantId.
router.get("/results/unresolved", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const scope = await resolveVendorScope(req, res, tenantId); if (!scope) return;
  const { sectorId, attendantId, storeId } = scope;
  const thresholdHours = Math.min(Math.max(parseInt(String(req.query.thresholdHours ?? "2"), 10) || 2, 1), 168);
  const cutoff = new Date(Date.now() - thresholdHours * 3_600_000);

  const conds = [
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.isArchived, false),
    inArray(conversationsTable.status, ["open", "pending"]),
    lt(sql`coalesce(${conversationsTable.attendanceStartedAt}, ${conversationsTable.createdAt})`, cutoff),
  ];
  if (sectorId) conds.push(eq(conversationsTable.sectorId, sectorId));
  if (attendantId) conds.push(eq(conversationsTable.assigneeId, attendantId));
  if (scope.store) conds.push(storeId != null ? eq(conversationsTable.storeId, storeId) : sql`false`);

  const rows = await db.select({
    id: conversationsTable.id,
    clientName: conversationsTable.name,
    sectorId: conversationsTable.sectorId,
    assigneeId: conversationsTable.assigneeId,
    status: conversationsTable.status,
    attendanceStartedAt: conversationsTable.attendanceStartedAt,
    createdAt: conversationsTable.createdAt,
  }).from(conversationsTable).where(and(...conds)).orderBy(conversationsTable.createdAt).limit(200);

  const attendantIds = [...new Set(rows.map((r) => r.assigneeId).filter((x): x is number => x != null))];
  const attendants = attendantIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, attendantIds))
    : [];
  const attendantMap = new Map(attendants.map((a) => [a.id, a.name]));
  const sectorIds = [...new Set(rows.map((r) => r.sectorId).filter((x): x is number => x != null))];
  const sectorRows = sectorIds.length
    ? await db.execute(sql`select id, name from sectors where id in (${sql.join(sectorIds.map((i) => sql`${i}`), sql`, `)})`)
    : { rows: [] as { id: number; name: string }[] };
  const sectorMap = new Map((sectorRows.rows as { id: number; name: string }[]).map((s) => [s.id, s.name]));

  const now = Date.now();
  const items = rows.map((r) => ({
    conversationId: r.id,
    clientName: r.clientName,
    sectorName: r.sectorId != null ? (sectorMap.get(r.sectorId) ?? "Desconhecido") : null,
    attendantName: r.assigneeId != null ? (attendantMap.get(r.assigneeId) ?? "Excluído") : null,
    status: r.status,
    ageHours: Math.round((now - (r.attendanceStartedAt ?? r.createdAt).getTime()) / 3_600_000),
  }));

  res.json({ thresholdHours, count: items.length, items });
});

// ── Satisfação por faixa (0-100%, comparável entre lojas com escalas diferentes) ──
// GET /results/satisfaction-breakdown?from=ISO&to=ISO&sectorId=&attendantId=&store=
router.get("/results/satisfaction-breakdown", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const range = parseDateRange(req, res); if (!range) return;
  const scope = await resolveVendorScope(req, res, tenantId); if (!scope) return;
  const { sectorId, attendantId, storeUserIds } = scope;
  const { from, to } = range;

  // Nota antiga sem escala registrada (satisfaction_scale_max null) é
  // assumida como escala 1-5 — era o único padrão que existia antes desta
  // coluna existir, não dá pra reconstruir qual escala foi usada de fato.
  const percentExpr = sql<number>`coalesce(${attendanceLogsTable.satisfactionPercent}, round(((${attendanceLogsTable.satisfactionRating} - 1)::numeric / 4) * 100))`;

  const conds = [
    eq(attendanceLogsTable.tenantId, tenantId),
    gte(attendanceLogsTable.createdAt, from),
    lte(attendanceLogsTable.createdAt, to),
    isNotNull(attendanceLogsTable.satisfactionRating),
  ];
  if (sectorId) conds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) conds.push(eq(attendanceLogsTable.attendantId, attendantId));
  if (storeUserIds) conds.push(storeUserIds.length ? inArray(attendanceLogsTable.attendantId, storeUserIds) : sql`false`);

  const rows = await db.select({ percent: percentExpr }).from(attendanceLogsTable).where(and(...conds));

  const FAIXAS = ["0-20", "21-40", "41-60", "61-80", "81-100"] as const;
  const buckets = new Map<string, number>(FAIXAS.map((f) => [f, 0]));
  let sum = 0;
  for (const r of rows) {
    const p = Math.min(100, Math.max(0, Number(r.percent)));
    sum += p;
    const faixa = p <= 20 ? "0-20" : p <= 40 ? "21-40" : p <= 60 ? "41-60" : p <= 80 ? "61-80" : "81-100";
    buckets.set(faixa, (buckets.get(faixa) ?? 0) + 1);
  }

  res.json({
    avgPercent: rows.length ? Math.round(sum / rows.length) : 0,
    ratings: rows.length,
    buckets: FAIXAS.map((faixa) => ({ faixa, count: buckets.get(faixa) ?? 0 })),
  });
});

// ── Avaliações individuais dos clientes (pesquisa de satisfação) ────────────
// GET /results/reviews?limit=&sectorId=&attendantId=
// Lista cada nota recebida (não só a média) — protocolo = attendance_logs.id,
// o mesmo número reforçado na mensagem da pesquisa enviada ao cliente.
router.get("/results/reviews", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const userId = req.session.userId!;
  const [me] = await db
    .select({ role: usersTable.role, sectorId: usersTable.sectorId })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId)));
  if (!me) { res.status(401).json({ error: "Unauthorized" }); return; }

  const limit = Math.min(Math.max(parseInt(String(req.query["limit"] ?? "100"), 10) || 100, 1), 500);
  const sectorId = req.query["sectorId"] ? parseInt(String(req.query["sectorId"]), 10) || null : null;
  const attendantId = req.query["attendantId"] ? parseInt(String(req.query["attendantId"]), 10) || null : null;

  const conditions = [eq(attendanceLogsTable.tenantId, tenantId), isNotNull(attendanceLogsTable.satisfactionRating)];
  // Supervisor de setor: só vê avaliações do próprio setor (mesma regra do /summary).
  if (me.role === "supervisor" && me.sectorId != null) conditions.push(eq(attendanceLogsTable.sectorId, me.sectorId));
  if (sectorId != null) conditions.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId != null) conditions.push(eq(attendanceLogsTable.attendantId, attendantId));

  const rows = await db.select({
    id: attendanceLogsTable.id,
    clientName: attendanceLogsTable.clientName,
    clientContact: attendanceLogsTable.clientContact,
    sectorName: attendanceLogsTable.sectorName,
    attendantName: attendanceLogsTable.attendantName,
    satisfactionRating: attendanceLogsTable.satisfactionRating,
    resolutionReason: attendanceLogsTable.resolutionReason,
    createdAt: attendanceLogsTable.createdAt,
  })
    .from(attendanceLogsTable)
    .where(and(...conditions))
    .orderBy(desc(attendanceLogsTable.createdAt))
    .limit(limit);

  res.json({ reviews: rows });
});

export default router;
