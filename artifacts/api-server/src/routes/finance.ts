import { Router, type IRouter } from "express";
import { and, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db, attendanceLogsTable, conversationsTable, usersTable } from "@workspace/db";
import { requireFeature } from "../middlewares/auth";

const router: IRouter = Router();

// Painel financeiro: vendas e prospecção por vendedor, em um período.
// GET /finance/summary?days=30&sectorId=3
router.get("/finance/summary", requireFeature("financeiro"), async (req, res): Promise<void> => {
  let days = parseInt(String(req.query.days ?? "30"), 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) days = 30;
  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) : null;
  const since = new Date(Date.now() - days * 86_400_000);

  // ── atendimentos finalizados no período (fonte: attendance_logs) ──
  const logConds = [gte(attendanceLogsTable.createdAt, since), isNotNull(attendanceLogsTable.attendantId)];
  if (sectorId) logConds.push(eq(attendanceLogsTable.sectorId, sectorId));

  const logAgg = await db.select({
    attendantId: attendanceLogsTable.attendantId,
    finalizados: sql<number>`count(*)::int`,
    vendas: sql<number>`count(*) filter (where ${attendanceLogsTable.hadSale})::int`,
    totalVendido: sql<string>`coalesce(sum(${attendanceLogsTable.saleAmount}) filter (where ${attendanceLogsTable.hadSale}), 0)::text`,
    orcamentos: sql<number>`count(*) filter (where ${attendanceLogsTable.resolutionReason} = 'Orçamento enviado')::int`,
    vaiPensar: sql<number>`count(*) filter (where ${attendanceLogsTable.resolutionReason} = 'Cliente vai pensar')::int`,
    semInteresse: sql<number>`count(*) filter (where ${attendanceLogsTable.resolutionReason} in ('Sem interesse', 'Sem resposta do cliente'))::int`,
  }).from(attendanceLogsTable).where(and(...logConds)).groupBy(attendanceLogsTable.attendantId);

  // ── prospecção: conversas em andamento COM responsável (agora) ──
  const prospConds = [
    isNotNull(conversationsTable.assigneeId),
    notInArray(conversationsTable.status, ["resolved", "archived"]),
  ];
  if (sectorId) prospConds.push(eq(conversationsTable.sectorId, sectorId));
  const prospAgg = await db.select({
    assigneeId: conversationsTable.assigneeId,
    emProspeccao: sql<number>`count(*)::int`,
  }).from(conversationsTable).where(and(...prospConds)).groupBy(conversationsTable.assigneeId);

  const userIds = [...new Set([
    ...logAgg.map((r) => r.attendantId!),
    ...prospAgg.map((r) => r.assigneeId!),
  ])];
  const userRows = userIds.length
    ? await db.select({
        id: usersTable.id, name: usersTable.name, role: usersTable.role,
        storeName: usersTable.storeName, sectorId: usersTable.sectorId, isActive: usersTable.isActive,
      }).from(usersTable).where(inArray(usersTable.id, userIds))
    : [];
  const userMap = new Map(userRows.map((u) => [u.id, u]));
  const prospMap = new Map(prospAgg.map((r) => [r.assigneeId!, r.emProspeccao]));

  const rows = [];
  const seen = new Set<number>();
  for (const r of logAgg) {
    const u = userMap.get(r.attendantId!);
    seen.add(r.attendantId!);
    rows.push({
      vendedorId: r.attendantId!,
      nome: u?.name ?? "Excluído",
      loja: u?.storeName ?? null,
      ativo: u?.isActive ?? false,
      finalizados: r.finalizados,
      vendas: r.vendas,
      totalVendido: Number(r.totalVendido),
      ticketMedio: r.vendas > 0 ? Number(r.totalVendido) / r.vendas : 0,
      conversao: r.finalizados > 0 ? Math.round((r.vendas / r.finalizados) * 100) : 0,
      orcamentos: r.orcamentos,
      vaiPensar: r.vaiPensar,
      semInteresse: r.semInteresse,
      emProspeccao: prospMap.get(r.attendantId!) ?? 0,
    });
  }
  // vendedores só com prospecção (sem finalizados no período)
  for (const p of prospAgg) {
    if (seen.has(p.assigneeId!)) continue;
    const u = userMap.get(p.assigneeId!);
    rows.push({
      vendedorId: p.assigneeId!,
      nome: u?.name ?? "Excluído",
      loja: u?.storeName ?? null,
      ativo: u?.isActive ?? false,
      finalizados: 0, vendas: 0, totalVendido: 0, ticketMedio: 0, conversao: 0,
      orcamentos: 0, vaiPensar: 0, semInteresse: 0,
      emProspeccao: p.emProspeccao,
    });
  }
  rows.sort((a, b) => b.totalVendido - a.totalVendido || b.vendas - a.vendas || b.emProspeccao - a.emProspeccao);

  const totals = rows.reduce((t, r) => ({
    finalizados: t.finalizados + r.finalizados,
    vendas: t.vendas + r.vendas,
    totalVendido: t.totalVendido + r.totalVendido,
    orcamentos: t.orcamentos + r.orcamentos,
    emProspeccao: t.emProspeccao + r.emProspeccao,
  }), { finalizados: 0, vendas: 0, totalVendido: 0, orcamentos: 0, emProspeccao: 0 });

  res.json({
    days,
    sectorId,
    totals: {
      ...totals,
      ticketMedio: totals.vendas > 0 ? totals.totalVendido / totals.vendas : 0,
      conversao: totals.finalizados > 0 ? Math.round((totals.vendas / totals.finalizados) * 100) : 0,
    },
    vendedores: rows,
  });
});

export default router;
