import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, sectorsTable, attendanceLogsTable, conversationsTable, conversationParticipantsTable, tasksTable, scheduledMessagesTable, crmContactsTable, crmInternalNotesTable, accessLogsTable, whatsappSessionsTable, tenantsTable } from "@workspace/db";
import { eq, sql, desc, asc, and, gte, lt, isNull, isNotNull, notInArray, inArray, or, ilike } from "drizzle-orm";
import { requireAdmin, requireAdminOrSupervisor, requireTenant } from "../middlewares/auth";
import { sanitizePermissions } from "../lib/permissions";
import { requireModuleAccess, sanitizeModuleAccess, type ModuleAccessMap, type UserGrantableModule } from "../lib/moduleAccess";
import { getPresence } from "../lib/sseEmitter";
import { isValidStoreName } from "./stores";
import { syncCrmAttendant } from "../lib/crmSync";

const router: IRouter = Router();

// Dashboard summary
// ─── Quem está online + horários de acesso ──────────────────────────────────
router.get("/admin/team-status", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { onlineIds, lastSeen } = getPresence();
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, sectorId: usersTable.sectorId, isActive: usersTable.isActive })
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)));
  // Último login de cada usuário em uma consulta só (dentro da loja).
  const lastLogins = await db
    .select({ userId: accessLogsTable.userId, lastLoginAt: sql<string>`max(${accessLogsTable.loggedInAt})` })
    .from(accessLogsTable)
    .where(eq(accessLogsTable.tenantId, tenantId))
    .groupBy(accessLogsTable.userId);
  const lastLoginMap = Object.fromEntries(lastLogins.map((l) => [l.userId, l.lastLoginAt]));
  const online = new Set(onlineIds);
  res.json(users.map((u) => ({
    ...u,
    online: online.has(u.id),
    lastSeenAt: lastSeen[u.id] ?? null,
    lastLoginAt: lastLoginMap[u.id] ?? null,
  })));
});

// Histórico de logins de um usuário (últimos 50).
router.get("/admin/users/:id/access-logs", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  // Só vê logs de usuário da própria loja.
  const [target] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }
  const rows = await db
    .select({ loggedInAt: accessLogsTable.loggedInAt })
    .from(accessLogsTable)
    .where(and(eq(accessLogsTable.tenantId, tenantId), eq(accessLogsTable.userId, id)))
    .orderBy(desc(accessLogsTable.loggedInAt))
    .limit(50);
  res.json(rows);
});

router.get("/admin/summary", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const sectors = await db.select().from(sectorsTable)
    .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.isActive, true)));

  // Meia-noite de HOJE no horário do Brasil, não no fuso do processo Node
  // (em produção o container pode rodar em UTC e desalinhar "hoje" perto da
  // virada do dia).
  const todaySP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const startOfDay = new Date(`${todaySP}T00:00:00-03:00`);

  // A Visão Geral espelha a Central de Atendimento (tabela conversations):
  // "aguardando"  = conversas sem responsável ainda abertas (potenciais + pendentes);
  // "em atendimento" = conversas com responsável e não finalizadas;
  // "finalizados hoje" segue vindo do histórico (attendance_logs).
  // Sempre restrito à loja (tenant).
  const notFinished = and(
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.isArchived, false),
    notInArray(conversationsTable.status, ["resolved", "archived"]),
  )!;

  const summary = await Promise.all(
    sectors.map(async (sector) => {
      const [waiting] = await db
        .select({ count: sql<number>`count(*)` })
        .from(conversationsTable)
        .where(and(eq(conversationsTable.sectorId, sector.id), isNull(conversationsTable.assigneeId), notFinished));

      const [inProgress] = await db
        .select({ count: sql<number>`count(*)` })
        .from(conversationsTable)
        .where(and(eq(conversationsTable.sectorId, sector.id), isNotNull(conversationsTable.assigneeId), notFinished));

      const [completedToday] = await db
        .select({ count: sql<number>`count(*)` })
        .from(attendanceLogsTable)
        .where(and(eq(attendanceLogsTable.tenantId, tenantId), eq(attendanceLogsTable.sectorId, sector.id), gte(attendanceLogsTable.createdAt, startOfDay)));

      // Attendants assigned to this sector (active users da loja)
      const [activeAttendants] = await db
        .select({ count: sql<number>`count(*)` })
        .from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.sectorId, sector.id), eq(usersTable.isActive, true)));

      // Vendedores atualmente atendendo (responsáveis por conversa em andamento)
      const busyAttendants = await db
        .selectDistinct({ attendantId: conversationsTable.assigneeId })
        .from(conversationsTable)
        .where(and(eq(conversationsTable.sectorId, sector.id), isNotNull(conversationsTable.assigneeId), notFinished));

      return {
        sector,
        waiting: Number(waiting?.count ?? 0),
        inProgress: Number(inProgress?.count ?? 0),
        completedToday: Number(completedToday?.count ?? 0),
        totalAttendants: Number(activeAttendants?.count ?? 0),
        busyAttendants: busyAttendants.filter((a) => a.attendantId !== null).length,
      };
    })
  );

  res.json(summary);
});

// ─── "Precisa de atenção agora" — resumo pra Visão Geral ────────────────────
// Agrega, num único round-trip, o que hoje só aparece entrando em cada aba:
// clientes esperando resposta há muito tempo, tarefas atrasadas e o tempo
// médio de atendimento do dia. Limitado a 5 itens por lista — é um resumo
// pra abrir a aba certa, não uma listagem completa.
router.get("/admin/dashboard-attention", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;

  const todaySP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const startOfDay = new Date(`${todaySP}T00:00:00-03:00`);

  // Mesmo limiar padrão do alarme "sem resposta" da Central de Atendimento
  // (ChatCenter.tsx, alertMinutes) — aqui fixo, só pra sinalizar na Visão Geral.
  const WAIT_THRESHOLD_MIN = 5;
  const waitThreshold = new Date(Date.now() - WAIT_THRESHOLD_MIN * 60_000);

  const waitingRows = await db
    .select({
      id: conversationsTable.id,
      name: conversationsTable.name,
      sectorName: sectorsTable.name,
      lastMessageAt: conversationsTable.lastMessageAt,
    })
    .from(conversationsTable)
    .leftJoin(sectorsTable, eq(conversationsTable.sectorId, sectorsTable.id))
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      eq(conversationsTable.isArchived, false),
      notInArray(conversationsTable.status, ["resolved", "archived"]),
      eq(conversationsTable.lastMessageDirection, "inbound"),
      isNotNull(conversationsTable.lastMessageAt),
      lt(conversationsTable.lastMessageAt, waitThreshold),
    ))
    .orderBy(asc(conversationsTable.lastMessageAt))
    .limit(5);

  const overdueRows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      dueDate: tasksTable.dueDate,
      assigneeName: usersTable.name,
    })
    .from(tasksTable)
    .leftJoin(usersTable, eq(tasksTable.assigneeId, usersTable.id))
    .where(and(
      eq(tasksTable.tenantId, tenantId),
      eq(tasksTable.isArchived, false),
      sql`${tasksTable.status} <> 'done'`,
      isNotNull(tasksTable.dueDate),
      lt(tasksTable.dueDate, new Date()),
    ))
    .orderBy(asc(tasksTable.dueDate))
    .limit(5);

  const [avgRow] = await db
    .select({ avgSeconds: sql<number | null>`avg(${attendanceLogsTable.serviceTimeSeconds})::int` })
    .from(attendanceLogsTable)
    .where(and(
      eq(attendanceLogsTable.tenantId, tenantId),
      gte(attendanceLogsTable.createdAt, startOfDay),
      isNotNull(attendanceLogsTable.serviceTimeSeconds),
    ));

  // Qualidade do funil bot → humano: quantos leads ainda estão só com o bot
  // (Potencial, espelha conversationCategory() do ChatCenter.tsx) contra
  // quantos já viraram atendimento humano de fato (Ativo). "Pendente" (na
  // fila, sem responsável ainda) fica de fora — não é nem lead cru nem
  // atendimento humano confirmado.
  const notFinished = and(
    eq(conversationsTable.tenantId, tenantId),
    eq(conversationsTable.isArchived, false),
    notInArray(conversationsTable.status, ["resolved", "archived"]),
  )!;
  const [potentialRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(conversationsTable)
    .where(and(notFinished, isNull(conversationsTable.assigneeId), sql`${conversationsTable.status} <> 'pending'`));
  const [activeRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(conversationsTable)
    .where(and(notFinished, isNotNull(conversationsTable.assigneeId)));

  const now = Date.now();
  res.json({
    waitingTooLong: waitingRows.map((c) => ({
      id: c.id,
      name: c.name,
      sectorName: c.sectorName,
      waitingMinutes: c.lastMessageAt ? Math.floor((now - c.lastMessageAt.getTime()) / 60_000) : null,
    })),
    overdueTasks: overdueRows.map((t) => ({
      id: t.id,
      title: t.title,
      assigneeName: t.assigneeName,
      daysOverdue: t.dueDate ? Math.floor((now - t.dueDate.getTime()) / 86_400_000) : null,
    })),
    avgServiceSeconds: avgRow?.avgSeconds ?? null,
    funnel: {
      potential: Number(potentialRow?.count ?? 0),
      active: Number(activeRow?.count ?? 0),
    },
  });
});

// Recent attendance logs
router.get("/admin/logs", requireAdminOrSupervisor, requireModuleAccess("history"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 500);
  const sectorId = req.query.sectorId ? parseInt(String(req.query.sectorId), 10) : null;
  const attendantId = req.query.attendantId ? parseInt(String(req.query.attendantId), 10) : null;
  const days = req.query.days ? parseInt(String(req.query.days), 10) : null;
  const outcome = req.query.outcome ? String(req.query.outcome) : null;
  const reason = req.query.reason ? String(req.query.reason) : null;
  const search = req.query.search ? String(req.query.search).trim() : null;

  const conds = [eq(attendanceLogsTable.tenantId, tenantId)];
  if (sectorId) conds.push(eq(attendanceLogsTable.sectorId, sectorId));
  if (attendantId) conds.push(eq(attendanceLogsTable.attendantId, attendantId));
  if (days && days > 0) conds.push(gte(attendanceLogsTable.createdAt, new Date(Date.now() - days * 86400000)));
  if (outcome) conds.push(eq(attendanceLogsTable.outcome, outcome));
  if (reason) conds.push(eq(attendanceLogsTable.resolutionReason, reason));
  if (search) {
    conds.push(or(
      ilike(attendanceLogsTable.clientName, `%${search}%`),
      ilike(attendanceLogsTable.clientContact, `%${search}%`),
    )!);
  }

  const logs = await db
    .select()
    .from(attendanceLogsTable)
    .where(and(...conds))
    .orderBy(desc(attendanceLogsTable.createdAt))
    .limit(limit);

  res.json(logs);
});

// Users management
router.get("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      sectorId: usersTable.sectorId,
      storeName: usersTable.storeName,
      extension: usersTable.extension,
      adminAccess: usersTable.adminAccess,
      moduleAccess: usersTable.moduleAccess,
      accessHours: usersTable.accessHours,
      allowedSessionKeys: usersTable.allowedSessionKeys,
      isActive: usersTable.isActive,
      permissions: usersTable.permissions,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.tenantId, tenantId))
    .orderBy(usersTable.name);

  // Get sectors for each user (da loja)
  const sectors = await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const sectorMap = Object.fromEntries(sectors.map((s) => [s.id, s]));

  const usersWithSector = users.map((u) => ({
    ...u,
    sector: u.sectorId ? (sectorMap[u.sectorId] ?? null) : null,
  }));

  res.json(usersWithSector);
});

// Funções de admin que podem ser liberadas para não-admins. Só sobrou
// "whatsapp" (gerenciar a conexão da linha) — financeiro/sorteios/robo/
// rh/questionarios migraram pra moduleAccess (lib/moduleAccess.ts), que
// usa o mesmo vocabulário de módulo de tenants.enabled_modules.
const GRANTABLE_FEATURES = ["whatsapp"];

// Valida o horário de acesso: { start:"08:00", end:"18:00", days:[1..6] } ou null
function sanitizeAccessHours(v: unknown): { start: string; end: string; days: number[] } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const start = typeof o.start === "string" && hhmm.test(o.start) ? o.start : null;
  const end = typeof o.end === "string" && hhmm.test(o.end) ? o.end : null;
  if (!start || !end) return null;
  const days = Array.isArray(o.days)
    ? [...new Set(o.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  return { start, end, days };
}

function sanitizeAdminAccess(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => String(x)).filter((x) => GRANTABLE_FEATURES.includes(x));
  return out.length ? [...new Set(out)] : null;
}

// Linhas de WhatsApp (session_key) reais da loja, pra validar o que o
// formulário manda — nunca aceita uma chave inventada/de outra loja.
const DEFAULT_SESSION_KEY = "default";
async function validSessionKeysFor(tenantId: number): Promise<Set<string>> {
  const rows = await db.select({ sessionKey: whatsappSessionsTable.sessionKey })
    .from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  const keys = new Set(rows.map((r) => r.sessionKey));
  if (tenantId === 1) keys.add(DEFAULT_SESSION_KEY); // "default" legada da loja 1
  return keys;
}

// Módulos que a LOJA contratou — nunca aceita conceder pra um usuário um
// módulo que a loja não tem (mesma cautela de validSessionKeysFor acima).
async function tenantEnabledModules(tenantId: number): Promise<Set<string>> {
  const [row] = await db.select({ enabledModules: tenantsTable.enabledModules })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  return new Set(row?.enabledModules ?? []);
}

function intersectModuleAccess(access: ModuleAccessMap | null, tenantModules: Set<string>): ModuleAccessMap | null {
  if (!access) return null;
  const out: ModuleAccessMap = {};
  for (const [key, level] of Object.entries(access)) {
    if (tenantModules.has(key)) out[key as UserGrantableModule] = level;
  }
  return Object.keys(out).length ? out : null;
}

// v === undefined: campo não enviado (não mexe). v === null ou []: sem
// restrição. Array com linhas reais: restringe a essas. Linha desconhecida é
// descartada silenciosamente (nunca guarda uma chave que não existe mais).
function sanitizeAllowedSessionKeys(v: unknown, validKeys: Set<string>): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => String(x)).filter((x) => validKeys.has(x));
  return out.length ? [...new Set(out)] : null;
}

router.post("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { name, email, password, role, sectorId, storeName, extension, adminAccess, accessHours, allowedSessionKeys, moduleAccess } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    sectorId?: number;
    storeName?: string;
    extension?: string;
    adminAccess?: unknown;
    accessHours?: unknown;
    allowedSessionKeys?: unknown;
    moduleAccess?: unknown;
  };

  if (!name || !email || !password) {
    res.status(400).json({ error: "Nome, email e senha são obrigatórios" });
    return;
  }

  const resolvedRole = role ?? "vendedor";
  // O papel "superadmin" (dono do sistema, sem loja) NUNCA é criado por aqui.
  const ALLOWED_ROLES = ["vendedor", "supervisor", "admin"];
  if (!ALLOWED_ROLES.includes(resolvedRole)) {
    res.status(400).json({ error: "Função inválida" });
    return;
  }

  // Vendedores must be assigned to a real sector (da própria loja)
  if (resolvedRole === "vendedor" && !sectorId) {
    res.status(400).json({ error: "Vendedor precisa de um setor atribuído" });
    return;
  }
  if (sectorId != null) {
    const [sec] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
      .where(and(eq(sectorsTable.id, sectorId), eq(sectorsTable.tenantId, tenantId))).limit(1);
    if (!sec) { res.status(400).json({ error: "Setor inválido" }); return; }
  }

  const cleanStore = typeof storeName === "string" && storeName.trim() ? storeName.trim().slice(0, 120) : null;
  if (cleanStore && !(await isValidStoreName(cleanStore, tenantId))) {
    res.status(400).json({ error: "Loja não cadastrada. Cadastre-a em Setores → Lojas da Rede." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const cleanExtension = typeof extension === "string" && extension.trim() ? extension.trim().slice(0, 20) : null;

  const [user] = await db
    .insert(usersTable)
    .values({
      tenantId,
      name, email: email.toLowerCase(), passwordHash, role: resolvedRole,
      sectorId: sectorId ?? undefined,
      storeName: cleanStore,
      extension: cleanExtension,
      mustChangePassword: true, // primeiro acesso: obriga trocar a senha
      adminAccess: sanitizeAdminAccess(adminAccess),
      accessHours: resolvedRole === "vendedor" ? sanitizeAccessHours(accessHours) : null,
      allowedSessionKeys: resolvedRole === "vendedor"
        ? sanitizeAllowedSessionKeys(allowedSessionKeys, await validSessionKeysFor(tenantId))
        : null,
      moduleAccess: resolvedRole !== "admin"
        ? intersectModuleAccess(sanitizeModuleAccess(moduleAccess), await tenantEnabledModules(tenantId))
        : null,
    })
    .returning();

  const { passwordHash: _ph, ...safeUser } = user;
  res.status(201).json(safeUser);
});

router.patch("/admin/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }

  // Usuário editado precisa ser da própria loja.
  const [existingUser] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!existingUser) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  const { name, email, password, role, sectorId, isActive, permissions, storeName, extension, adminAccess, accessHours, allowedSessionKeys, moduleAccess } = req.body as {
    adminAccess?: unknown;
    accessHours?: unknown;
    allowedSessionKeys?: unknown;
    moduleAccess?: unknown;
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    sectorId?: number;
    isActive?: boolean;
    permissions?: unknown;
    storeName?: string | null;
    extension?: string | null;
  };

  const updateData: Record<string, unknown> = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email.toLowerCase();
  if (role) {
    // Nunca é permitido promover ninguém a "superadmin" por aqui.
    const ALLOWED_ROLES = ["vendedor", "supervisor", "admin"];
    if (!ALLOWED_ROLES.includes(role)) { res.status(400).json({ error: "Função inválida" }); return; }
    updateData.role = role;
  }
  if (sectorId !== undefined) {
    if (sectorId != null) {
      const [sec] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
        .where(and(eq(sectorsTable.id, sectorId), eq(sectorsTable.tenantId, tenantId))).limit(1);
      if (!sec) { res.status(400).json({ error: "Setor inválido" }); return; }
    }
    updateData.sectorId = sectorId;
  }
  if (adminAccess !== undefined) updateData.adminAccess = sanitizeAdminAccess(adminAccess);
  if (moduleAccess !== undefined) {
    updateData.moduleAccess = intersectModuleAccess(sanitizeModuleAccess(moduleAccess), await tenantEnabledModules(tenantId));
  }
  if (accessHours !== undefined) updateData.accessHours = sanitizeAccessHours(accessHours);
  if (allowedSessionKeys !== undefined) {
    updateData.allowedSessionKeys = sanitizeAllowedSessionKeys(allowedSessionKeys, await validSessionKeysFor(tenantId));
  }
  if (storeName !== undefined) {
    const cleanStore = typeof storeName === "string" && storeName.trim() ? storeName.trim().slice(0, 120) : null;
    if (cleanStore) {
      const [current] = await db.select({ storeName: usersTable.storeName }).from(usersTable)
        .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId))).limit(1);
      if (!(await isValidStoreName(cleanStore, tenantId, current?.storeName))) {
        res.status(400).json({ error: "Loja não cadastrada. Cadastre-a em Setores → Lojas da Rede." });
        return;
      }
    }
    updateData.storeName = cleanStore;
  }
  if (extension !== undefined) {
    updateData.extension = typeof extension === "string" && extension.trim() ? extension.trim().slice(0, 20) : null;
  }
  if (isActive !== undefined) updateData.isActive = isActive;
  if (permissions !== undefined) updateData.permissions = sanitizePermissions(permissions);
  if (password) {
    updateData.passwordHash = await bcrypt.hash(password, 10);
    // Senha resetada pelo admin (recuperação): usuário troca no próximo login
    updateData.mustChangePassword = true;
  }

  const [user] = await db.update(usersTable).set(updateData)
    .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId))).returning();
  if (!user) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  // Usuário desativado perde as sessões ativas na hora (não só no próximo login).
  if (isActive === false) {
    await db.execute(sql`DELETE FROM "session" WHERE (sess::json->>'userId')::int = ${id}`);
  }

  const { passwordHash: _ph, ...safeUser } = user;
  res.json(safeUser);
});

// ─── Excluir usuário (transferindo os atendimentos dele) ────────────────────
// ─── Inativar usuário (transferindo os atendimentos em andamento) ──────────
// transferToId: para quem vão os atendimentos em andamento. Sem transferToId,
// eles voltam para a fila do setor. Histórico (resolvidos) continua com ele.
router.post("/admin/users/:id/deactivate", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  if (id === req.session.userId) { res.status(400).json({ error: "Você não pode inativar a si mesmo" }); return; }

  const { transferToId: rawTransfer } = req.body as { transferToId?: number | null };
  const transferToId = rawTransfer != null ? Number(rawTransfer) : null;
  if (transferToId != null && (Number.isNaN(transferToId) || transferToId === id)) {
    res.status(400).json({ error: "Destinatário da transferência inválido" });
    return;
  }

  const [target] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  if (transferToId != null) {
    // Destino precisa ser um usuário ativo da MESMA loja.
    const [dest] = await db.select({ id: usersTable.id, isActive: usersTable.isActive })
      .from(usersTable).where(and(eq(usersTable.id, transferToId), eq(usersTable.tenantId, tenantId))).limit(1);
    if (!dest || !dest.isActive) { res.status(400).json({ error: "Usuário de destino não encontrado ou inativo" }); return; }
  }

  // Só os atendimentos em andamento (da loja) mudam de mãos — o histórico fica com ele.
  const openConvs = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id), notInArray(conversationsTable.status, ["resolved", "archived"])));

  await db.transaction(async (tx) => {
    if (transferToId != null) {
      // Atendimentos entram como PENDENTES para quem recebeu: ele vira
      // participante (vê a conversa) e clica em "Iniciar atendimento".
      await tx.update(conversationsTable)
        .set({ assigneeId: null, status: "pending", attendanceStartedAt: null, updatedAt: new Date() })
        .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id), notInArray(conversationsTable.status, ["resolved", "archived"])));
      if (openConvs.length > 0) {
        await tx.insert(conversationParticipantsTable)
          .values(openConvs.map((c) => ({ tenantId, conversationId: c.id, userId: transferToId })))
          .onConflictDoNothing();
      }
      await tx.update(tasksTable).set({ assigneeId: transferToId }).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.assigneeId, id)));
      await tx.update(crmContactsTable).set({ attendantId: transferToId, updatedAt: new Date() }).where(and(eq(crmContactsTable.tenantId, tenantId), eq(crmContactsTable.attendantId, id)));
    } else {
      await tx.update(conversationsTable)
        .set({ assigneeId: null, status: "open", attendanceStartedAt: null, updatedAt: new Date() })
        .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id), notInArray(conversationsTable.status, ["resolved", "archived"])));
    }
    await tx.update(usersTable).set({ isActive: false }).where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId)));
    // Derruba as sessões ativas na hora.
    await tx.execute(sql`DELETE FROM "session" WHERE (sess::json->>'userId')::int = ${id}`);
  });

  // Espelha no quadro CRM (best-effort, fora da transação).
  for (const conv of openConvs) {
    await syncCrmAttendant({
      tenantId,
      phone: conv.phone,
      sectorId: conv.sectorId,
      assigneeId: null,
      status: transferToId == null ? "open" : "pending",
      isArchived: conv.isArchived,
    });
  }

  res.json({ ok: true, transferredConversations: openConvs.length });
});

// transferToId: para quem vão as conversas/tarefas/clientes do usuário excluído.
// Sem transferToId, as conversas em andamento voltam para a fila (sem responsável)
// e as demais referências ficam "sem responsável".
router.delete("/admin/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  if (id === req.session.userId) { res.status(400).json({ error: "Você não pode excluir a si mesmo" }); return; }

  const { transferToId: rawTransfer } = req.body as { transferToId?: number | null };
  const transferToId = rawTransfer != null ? Number(rawTransfer) : null;
  if (transferToId != null && (Number.isNaN(transferToId) || transferToId === id)) {
    res.status(400).json({ error: "Destinatário da transferência inválido" });
    return;
  }

  const [target] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!target) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  if (transferToId != null) {
    // Destino precisa ser um usuário ativo da MESMA loja.
    const [dest] = await db.select({ id: usersTable.id, isActive: usersTable.isActive })
      .from(usersTable).where(and(eq(usersTable.id, transferToId), eq(usersTable.tenantId, tenantId))).limit(1);
    if (!dest || !dest.isActive) { res.status(400).json({ error: "Usuário de destino não encontrado ou inativo" }); return; }
  }

  // Conversas do usuário (da loja) para sincronizar CRM/registro após a transação.
  const ownedConvs = await db.select().from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id)));

  await db.transaction(async (tx) => {
    if (transferToId != null) {
      // Em andamento: entram como PENDENTES para quem recebeu (participante).
      const openIds = ownedConvs
        .filter((c) => c.status !== "resolved" && c.status !== "archived")
        .map((c) => c.id);
      await tx.update(conversationsTable)
        .set({ assigneeId: null, status: "pending", attendanceStartedAt: null, updatedAt: new Date() })
        .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id), notInArray(conversationsTable.status, ["resolved", "archived"])));
      if (openIds.length > 0) {
        await tx.insert(conversationParticipantsTable)
          .values(openIds.map((cid) => ({ tenantId, conversationId: cid, userId: transferToId })))
          .onConflictDoNothing();
      }
      // Histórico (resolvidas) fica com o novo responsável.
      await tx.update(conversationsTable)
        .set({ assigneeId: transferToId, updatedAt: new Date() })
        .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id)));
    } else {
      // Sem destino: atendimentos em andamento voltam para a fila do setor.
      await tx.update(conversationsTable)
        .set({ assigneeId: null, status: "open", attendanceStartedAt: null, updatedAt: new Date() })
        .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id), notInArray(conversationsTable.status, ["resolved", "archived"])));
      await tx.update(conversationsTable)
        .set({ assigneeId: null, updatedAt: new Date() })
        .where(and(eq(conversationsTable.tenantId, tenantId), eq(conversationsTable.assigneeId, id)));
    }
    // Tarefas, agendamentos, clientes do CRM e anotações (todos da loja).
    await tx.update(tasksTable).set({ assigneeId: transferToId }).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.assigneeId, id)));
    await tx.update(tasksTable).set({ createdById: transferToId }).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.createdById, id)));
    await tx.update(scheduledMessagesTable).set({ createdById: transferToId }).where(and(eq(scheduledMessagesTable.tenantId, tenantId), eq(scheduledMessagesTable.createdById, id)));
    await tx.update(crmContactsTable).set({ attendantId: transferToId, updatedAt: new Date() }).where(and(eq(crmContactsTable.tenantId, tenantId), eq(crmContactsTable.attendantId, id)));
    await tx.update(crmInternalNotesTable).set({ authorId: transferToId })
      .where(and(
        eq(crmInternalNotesTable.authorId, id),
        inArray(crmInternalNotesTable.contactId,
          db.select({ id: crmContactsTable.id }).from(crmContactsTable).where(eq(crmContactsTable.tenantId, tenantId))),
      ));
    // Chat interno e participações são removidos em cascata pelo banco.
    await tx.delete(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.tenantId, tenantId)));
    // Derruba as sessões ativas do usuário excluído: sem isso, o cookie dele
    // continuaria autorizando requisições até expirar.
    await tx.execute(sql`DELETE FROM "session" WHERE (sess::json->>'userId')::int = ${id}`);
  });

  // Espelha a transferência no quadro CRM (best-effort, fora da transação).
  for (const conv of ownedConvs) {
    await syncCrmAttendant({
      tenantId,
      phone: conv.phone,
      sectorId: conv.sectorId,
      assigneeId: conv.status === "resolved" || conv.status === "archived" ? transferToId : null,
      status: conv.status === "resolved" || conv.status === "archived" ? conv.status : (transferToId == null ? "open" : "pending"),
      isArchived: conv.isArchived,
    });
  }

  res.json({ ok: true, transferredConversations: ownedConvs.length });
});

export default router;
