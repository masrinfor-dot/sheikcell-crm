import { Router, type IRouter } from "express";
import { db, usersTable, attendanceLogsTable } from "@workspace/db";
import { and, eq, gte, lte, isNotNull, sql } from "drizzle-orm";
import { requireAuth, requireTenant } from "../middlewares/auth";

const router: IRouter = Router();

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

  // Vendedor: sempre restrito ao próprio setor E aos próprios números —
  // qualquer filtro pedido é ignorado (fail closed, servidor manda).
  if (!isGlobal) {
    if (!me.sectorId) { res.status(403).json({ error: "Vendedor sem setor" }); return; }
    sectorId = me.sectorId;
    attendantId = me.id;
  }

  const logConds = [
    eq(attendanceLogsTable.tenantId, tenantId),
    gte(attendanceLogsTable.createdAt, from),
    lte(attendanceLogsTable.createdAt, to),
  ];
  if (sectorId) logConds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) logConds.push(eq(attendanceLogsTable.attendantId, attendantId));
  const logWhere = and(...logConds)!;

  // ── Totais do período (attendance_logs) ──
  const [totals] = await db.select({
    atendimentos: sql<number>`count(*)::int`,
    avgServiceSeconds: sql<number>`coalesce(round(avg(${attendanceLogsTable.serviceTimeSeconds}) filter (where ${attendanceLogsTable.serviceTimeSeconds} is not null)), 0)::int`,
    avgWaitSeconds: sql<number>`coalesce(round(avg(${attendanceLogsTable.waitTimeSeconds}) filter (where ${attendanceLogsTable.waitTimeSeconds} is not null)), 0)::int`,
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
  const sectorSql = sectorId ? sql` and c.sector_id = ${sectorId}` : sql``;
  const convAttSql = attendantId ? sql` and c.assignee_id = ${attendantId}` : sql``;
  const newLeadsRow = await db.execute(sql`
    select count(*)::int as novos
    from conversations c
    where c.tenant_id = ${tenantId} and c.created_at >= ${from} and c.created_at <= ${to}${sectorSql}${convAttSql}
  `);
  const newLeads = Number((newLeadsRow.rows[0] as { novos: number } | undefined)?.novos ?? 0);

  const logSectorSql = sectorId ? sql` and l.sector_id = ${sectorId}` : sql``;
  const logAttSql = attendantId ? sql` and l.attendant_id = ${attendantId}` : sql``;
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
  const crmAttSql = attendantId ? sql` and ct.attendant_id = ${attendantId}` : sql``;
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
    totals: {
      atendimentos: Number(totals?.atendimentos ?? 0),
      avgServiceSeconds: Number(totals?.avgServiceSeconds ?? 0),
      avgWaitSeconds: Number(totals?.avgWaitSeconds ?? 0),
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

export default router;
