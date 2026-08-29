import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, tenantsTable, usersTable, sectorsTable, conversationsTable, whatsappSessionsTable, saasContractsTable, saasInvoicesTable, saasTicketsTable, impersonationLogTable, superadminAuditLogTable, plansTable, OPTIONAL_MODULES, LIMIT_FIELDS, type OptionalModule, type LimitField, type PlanLimits } from "@workspace/db";
import { eq, and, count, desc, lt, inArray, sql } from "drizzle-orm";
import { getLimitsAndUsage } from "../lib/planLimits";

// Chamados que ainda pedem atenção (mesmo grupo usado na aba Suporte do
// painel) — usado aqui só pra contar quantos uma loja tem em aberto.
const OPEN_TICKET_STATUSES = ["aberto", "em_analise", "em_andamento"] as const;
import { requireSuperadmin, invalidateTenantCache } from "../middlewares/auth";
import { validateCpfCnpj } from "../lib/cpfCnpj";
import { parseUserAgent } from "../lib/sessions";
import { logger } from "../lib/logger";

function sanitizeModules(v: unknown): OptionalModule[] {
  if (!Array.isArray(v)) return [];
  const valid = new Set<string>(OPTIONAL_MODULES);
  return v.filter((m): m is OptionalModule => typeof m === "string" && valid.has(m));
}

// Motivos fixos do "Entrar como" (item da Fase 2 do Painel do Sistema) —
// "Outro" exige o texto livre em reasonDetail, virando o motivo final.
const IMPERSONATE_REASONS = ["Suporte", "Configuração", "Treinamento", "Outro"] as const;

// Auditoria global (Fase 2): grava toda ação relevante do superadmin, pra
// depois listar em "Auditoria" no painel. Nunca deixa a ação principal
// falhar por causa disso — auditoria é best-effort, um log perdido não pode
// travar o superadmin de suspender/reativar uma loja de verdade.
async function logAudit(opts: {
  superadminUserId: number;
  tenantId?: number | null;
  action: string;
  description: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(superadminAuditLogTable).values({
      superadminUserId: opts.superadminUserId,
      tenantId: opts.tenantId ?? null,
      action: opts.action,
      description: opts.description,
      reason: opts.reason ?? null,
      metadata: opts.metadata,
    });
  } catch (err) {
    // best-effort — não propaga
    logger.error({ err }, "Falha ao gravar auditoria do superadmin");
  }
}

// Painel do superadmin (dono do sistema): cria/suspende lojas (tenants) e
// gerencia o admin de cada loja. Todas as rotas exigem role "superadmin".
const router: IRouter = Router();

router.use("/superadmin", requireSuperadmin);

// Lista lojas com contadores básicos
router.get("/superadmin/tenants", async (_req, res): Promise<void> => {
  const tenants = await db.select().from(tenantsTable).orderBy(desc(tenantsTable.createdAt));
  const result = await Promise.all(
    tenants.map(async (t) => {
      const [[u], [c], [w], [wc], [ot]] = await Promise.all([
        db.select({ n: count() }).from(usersTable).where(and(eq(usersTable.tenantId, t.id), eq(usersTable.isActive, true))),
        db.select({ n: count() }).from(conversationsTable).where(eq(conversationsTable.tenantId, t.id)),
        db.select({ n: count() }).from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, t.id)),
        db.select({ n: count() }).from(whatsappSessionsTable).where(and(eq(whatsappSessionsTable.tenantId, t.id), eq(whatsappSessionsTable.status, "connected"))),
        db.select({ n: count() }).from(saasTicketsTable).where(and(eq(saasTicketsTable.tenantId, t.id), inArray(saasTicketsTable.status, OPEN_TICKET_STATUSES))),
      ]);
      const admins = await db
        .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, isActive: usersTable.isActive })
        .from(usersTable)
        .where(and(eq(usersTable.tenantId, t.id), eq(usersTable.role, "admin")));
      const today = new Date().toISOString().slice(0, 10);
      const [contract] = await db.select().from(saasContractsTable).where(eq(saasContractsTable.tenantId, t.id));
      const [[overdue], planUsage] = await Promise.all([
        db.select({ n: count() }).from(saasInvoicesTable)
          .where(and(eq(saasInvoicesTable.tenantId, t.id), eq(saasInvoicesTable.status, "pendente"), lt(saasInvoicesTable.dueDate, today))),
        getLimitsAndUsage(t.id),
      ]);
      const overdueCount = Number(overdue?.n ?? 0);
      // Situação comercial: cancelado (manual) > em implantação (manual) >
      // inadimplente (derivada) > ativo
      const saasStatus = t.saasStatus === "cancelado" ? "cancelado"
        : t.saasStatus === "em_implantacao" ? "em_implantacao"
        : overdueCount > 0 ? "inadimplente" : "ativo";
      return {
        ...t,
        saasStatus,
        overdueCount,
        contract: contract ?? null,
        planUsage,
        userCount: Number(u?.n ?? 0),
        conversationCount: Number(c?.n ?? 0),
        whatsappCount: Number(w?.n ?? 0),
        whatsappConnectedCount: Number(wc?.n ?? 0),
        openTicketCount: Number(ot?.n ?? 0),
        admins,
      };
    }),
  );
  res.json({ tenants: result });
});

// Cria loja (e opcionalmente já o admin dela)
router.post("/superadmin/tenants", async (req, res): Promise<void> => {
  const {
    name, adminName, adminEmail, adminPassword,
    contactName, contactPhone, contactEmail, cpfCnpj, enabledModules,
  } = req.body as {
    name?: string; adminName?: string; adminEmail?: string; adminPassword?: string;
    contactName?: string; contactPhone?: string; contactEmail?: string;
    cpfCnpj?: string; enabledModules?: unknown;
  };
  if (!name?.trim()) { res.status(400).json({ error: "Informe o nome da loja" }); return; }

  let cleanCpfCnpj: string | null = null;
  if (cpfCnpj?.trim()) {
    const check = validateCpfCnpj(cpfCnpj);
    if (!check.valid) { res.status(400).json({ error: "CPF ou CNPJ inválido" }); return; }
    cleanCpfCnpj = check.digits;
  }
  const modules = sanitizeModules(enabledModules);

  // Valida TUDO antes de gravar qualquer coisa (nada de loja órfã se o
  // admin for inválido) e cria loja+setor+admin numa transação única.
  const wantsAdmin = Boolean(adminEmail && adminPassword);
  let email = "";
  let passwordHash = "";
  if (wantsAdmin) {
    if (adminPassword!.length < 6) { res.status(400).json({ error: "Senha do admin precisa ter pelo menos 6 caracteres" }); return; }
    email = adminEmail!.trim().toLowerCase();
    const [dup] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
    if (dup) { res.status(400).json({ error: "Já existe um usuário com este e-mail" }); return; }
    passwordHash = await bcrypt.hash(adminPassword!, 10);
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenantsTable).values({
        name: name.trim(),
        contactName: contactName?.trim() || null,
        contactPhone: contactPhone?.trim() || null,
        contactEmail: contactEmail?.trim() || null,
        cpfCnpj: cleanCpfCnpj,
        enabledModules: modules,
      }).returning();
      if (!tenant) throw new Error("Falha ao criar loja");
      let admin = null;
      if (wantsAdmin) {
        // Cria um setor inicial para a loja (admin pode renomear depois)
        const [sector] = await tx.insert(sectorsTable).values({ tenantId: tenant.id, name: "Atendimento" }).returning();
        const [u] = await tx.insert(usersTable).values({
          tenantId: tenant.id,
          name: adminName?.trim() || "Admin",
          email,
          passwordHash,
          role: "admin",
          sectorId: sector?.id ?? null,
          mustChangePassword: true,
          isActive: true,
        }).returning();
        if (!u) throw new Error("Falha ao criar admin");
        admin = { id: u.id, name: u.name, email: u.email };
      }
      return { tenant, admin };
    });
    await logAudit({
      superadminUserId: req.session.userId!, tenantId: result.tenant.id,
      action: "criar_loja", description: `Criou a loja "${result.tenant.name}"`,
    });
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Falha ao criar loja");
    res.status(500).json({ error: "Falha ao criar loja" });
  }
});

// Renomeia / suspende / reativa loja
router.patch("/superadmin/tenants/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { name, isActive, saasStatus, contactName, contactPhone, contactEmail, enabledModules } = req.body as {
    name?: string; isActive?: boolean; saasStatus?: string;
    contactName?: string | null; contactPhone?: string | null; contactEmail?: string | null;
    enabledModules?: unknown;
  };
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Loja inválida" }); return; }
  const updates: Partial<{
    name: string; isActive: boolean; saasStatus: string;
    contactName: string | null; contactPhone: string | null; contactEmail: string | null;
    enabledModules: OptionalModule[];
  }> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof isActive === "boolean") updates.isActive = isActive;
  if (typeof saasStatus === "string") {
    // "inadimplente" é derivada das mensalidades — só ativo/em implantação/
    // cancelado são manuais (o superadmin escolhe direto na tela).
    if (!["ativo", "cancelado", "em_implantacao"].includes(saasStatus)) { res.status(400).json({ error: "Situação inválida" }); return; }
    updates.saasStatus = saasStatus;
    // Cancelar o contrato também suspende o acesso da loja (fail closed)
    if (saasStatus === "cancelado") updates.isActive = false;
  }
  if (contactName !== undefined) updates.contactName = contactName?.trim() || null;
  if (contactPhone !== undefined) updates.contactPhone = contactPhone?.trim() || null;
  if (contactEmail !== undefined) updates.contactEmail = contactEmail?.trim() || null;
  if (enabledModules !== undefined) updates.enabledModules = sanitizeModules(enabledModules);
  if (!Object.keys(updates).length) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  // Tudo numa transação única: cancelar/reativar o lojista também
  // encerra/reativa o contrato dele e, ao cancelar, cancela as mensalidades
  // pendentes — nunca pode sobrar loja cancelada com contrato ativo ou
  // cobrança em aberto (nem parcialmente, se algo falhar no meio).
  const tenant = await db.transaction(async (tx) => {
    const [t] = await tx.update(tenantsTable).set(updates).where(eq(tenantsTable.id, id)).returning();
    if (!t) return null;
    if (updates.saasStatus) {
      const cancelling = updates.saasStatus === "cancelado";
      await tx
        .update(saasContractsTable)
        .set({ isActive: !cancelling, updatedAt: new Date() })
        .where(eq(saasContractsTable.tenantId, id));
      if (cancelling) {
        await tx
          .update(saasInvoicesTable)
          .set({ status: "cancelada" })
          .where(and(eq(saasInvoicesTable.tenantId, id), eq(saasInvoicesTable.status, "pendente")));
      }
    }
    return t;
  });
  if (!tenant) { res.status(404).json({ error: "Loja não encontrada" }); return; }
  invalidateTenantCache();

  // Auditoria: descreve cada tipo de mudança pedida nesta chamada (o mesmo
  // PATCH acumula rename/suspender/cancelar contrato/módulos, então um
  // registro só pode ter mais de uma frase).
  const parts: string[] = [];
  if (updates.name) parts.push(`renomeou pra "${updates.name}"`);
  if (updates.saasStatus === "cancelado") parts.push("cancelou o contrato");
  else if (updates.saasStatus === "em_implantacao") parts.push("marcou como em implantação");
  else if (updates.saasStatus === "ativo") parts.push("marcou como ativa");
  if (typeof updates.isActive === "boolean" && updates.saasStatus === undefined) {
    parts.push(updates.isActive ? "reativou o acesso" : "suspendeu o acesso");
  }
  if (updates.enabledModules) parts.push("alterou os módulos habilitados");
  if (updates.contactName !== undefined || updates.contactPhone !== undefined || updates.contactEmail !== undefined) {
    parts.push("atualizou os dados de contato");
  }
  if (parts.length) {
    await logAudit({
      superadminUserId: req.session.userId!, tenantId: id,
      action: "atualizar_loja",
      description: `Na loja "${tenant.name}": ${parts.join("; ")}`,
      metadata: updates,
    });
  }
  res.json({ tenant });
});

// ─── Planos & Limites (Fase 3 do Painel do Sistema) ────────────────────────

function sanitizeCustomLimits(v: unknown): Partial<PlanLimits> {
  const out: Partial<PlanLimits> = {};
  if (v == null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const field of LIMIT_FIELDS) {
    const raw = (v as Record<string, unknown>)[field];
    if (raw === null) { out[field] = null; continue; } // null = ilimitado, explícito
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) out[field] = Math.floor(raw);
  }
  return out;
}

// Catálogo de planos (Start/Pro/Premium/Personalizado...) — cada um com um
// teto por recurso. "Personalizado" não é um plano de verdade aqui: é a
// loja marcando usesCustomLimits=true no próprio contrato (ver rota
// /superadmin/tenants/:id/plan abaixo).
router.get("/superadmin/plans", async (_req, res): Promise<void> => {
  const plans = await db.select().from(plansTable).orderBy(plansTable.name);
  res.json({ plans });
});

router.post("/superadmin/plans", async (req, res): Promise<void> => {
  const { name, ...rest } = req.body as { name?: string } & Partial<PlanLimits>;
  if (!name?.trim()) { res.status(400).json({ error: "Informe o nome do plano" }); return; }
  const limits = sanitizeCustomLimits(rest);
  try {
    const [plan] = await db.insert(plansTable).values({ name: name.trim(), ...limits }).returning();
    await logAudit({
      superadminUserId: req.session.userId!,
      action: "criar_plano",
      description: `Criou o plano "${plan.name}"`,
    });
    res.status(201).json({ plan });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") { res.status(409).json({ error: "Já existe um plano com esse nome" }); return; }
    req.log.error({ err }, "Falha ao criar plano");
    res.status(500).json({ error: "Falha ao criar plano" });
  }
});

router.patch("/superadmin/plans/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Plano inválido" }); return; }
  const { name, isActive, ...rest } = req.body as { name?: string; isActive?: boolean } & Partial<PlanLimits>;
  const updates: Partial<typeof plansTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof isActive === "boolean") updates.isActive = isActive;
  Object.assign(updates, sanitizeCustomLimits(rest));
  const [plan] = await db.update(plansTable).set(updates).where(eq(plansTable.id, id)).returning();
  if (!plan) { res.status(404).json({ error: "Plano não encontrado" }); return; }
  await logAudit({
    superadminUserId: req.session.userId!,
    action: "atualizar_plano",
    description: `Atualizou o plano "${plan.name}"`,
    metadata: updates,
  });
  res.json({ plan });
});

// Vincula/personaliza o plano de UMA loja — não mexe no catálogo de planos
// nem afeta nenhuma outra loja. usesCustomLimits=true junto com customLimits
// é a "negociação diferente do padrão" (item pedido explicitamente pelo
// cliente): cada chave customizada sobrepõe o valor do plano só pra essa
// loja; o que não foi customizado continua caindo no valor do plano.
router.patch("/superadmin/tenants/:id/plan", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  if (!Number.isFinite(tenantId)) { res.status(400).json({ error: "Loja inválida" }); return; }
  const { planId, usesCustomLimits, customLimits } = req.body as {
    planId?: number | null; usesCustomLimits?: boolean; customLimits?: unknown;
  };
  const [tenant] = await db.select({ name: tenantsTable.name }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) { res.status(404).json({ error: "Loja não encontrada" }); return; }
  if (planId != null) {
    const [plan] = await db.select({ id: plansTable.id }).from(plansTable).where(eq(plansTable.id, planId));
    if (!plan) { res.status(400).json({ error: "Plano inválido" }); return; }
  }
  const updates: Partial<typeof saasContractsTable.$inferInsert> = { updatedAt: new Date() };
  if (planId !== undefined) updates.planId = planId;
  if (typeof usesCustomLimits === "boolean") updates.usesCustomLimits = usesCustomLimits;
  if (customLimits !== undefined) updates.customLimits = sanitizeCustomLimits(customLimits);

  const [existing] = await db.select({ id: saasContractsTable.id }).from(saasContractsTable).where(eq(saasContractsTable.tenantId, tenantId));
  if (existing) {
    await db.update(saasContractsTable).set(updates).where(eq(saasContractsTable.tenantId, tenantId));
  } else {
    await db.insert(saasContractsTable).values({ tenantId, ...updates });
  }
  await logAudit({
    superadminUserId: req.session.userId!, tenantId,
    action: "alterar_plano",
    description: `Na loja "${tenant.name}": alterou o plano/limites`,
    metadata: { planId, usesCustomLimits, customLimits: updates.customLimits },
  });
  const usage = await getLimitsAndUsage(tenantId);
  res.json({ ok: true, usage });
});

// Cria (ou reseta a senha de) um admin para a loja
router.post("/superadmin/tenants/:id/admin", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.id);
  const { name, email, password } = req.body as { name?: string; email?: string; password?: string };
  if (!Number.isFinite(tenantId)) { res.status(400).json({ error: "Loja inválida" }); return; }
  if (!email || !password) { res.status(400).json({ error: "Informe e-mail e senha" }); return; }
  if (password.length < 6) { res.status(400).json({ error: "Senha precisa ter pelo menos 6 caracteres" }); return; }
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) { res.status(404).json({ error: "Loja não encontrada" }); return; }

  const normalized = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, normalized));
  if (existing) {
    // Só permite resetar se o usuário for admin DESTA loja
    if (existing.tenantId !== tenantId || existing.role !== "admin") {
      res.status(400).json({ error: "E-mail já usado por outro usuário" });
      return;
    }
    await db.update(usersTable).set({ passwordHash, mustChangePassword: true, isActive: true }).where(eq(usersTable.id, existing.id));
    await logAudit({
      superadminUserId: req.session.userId!, tenantId,
      action: "resetar_senha_admin",
      description: `Resetou a senha do admin ${existing.name} (loja "${tenant.name}")`,
    });
    res.json({ admin: { id: existing.id, name: existing.name, email: existing.email }, reset: true });
    return;
  }
  const [sector] = await db
    .select({ id: sectorsTable.id })
    .from(sectorsTable)
    .where(eq(sectorsTable.tenantId, tenantId))
    .limit(1);
  const [u] = await db.insert(usersTable).values({
    tenantId,
    name: name?.trim() || "Admin",
    email: normalized,
    passwordHash,
    role: "admin",
    sectorId: sector?.id ?? null,
    mustChangePassword: true,
    isActive: true,
  }).returning();
  if (u) {
    await logAudit({
      superadminUserId: req.session.userId!, tenantId,
      action: "criar_admin",
      description: `Criou o admin ${u.name} (loja "${tenant.name}")`,
    });
  }
  res.status(201).json({ admin: u ? { id: u.id, name: u.name, email: u.email } : null });
});

// "Entrar como": o superadmin assume a sessão de um admin ativo da loja,
// pra ver/usar o painel dela exatamente como ela vê. Guarda o próprio id
// pra dar pra voltar (POST /auth/stop-impersonation) e registra no log —
// desde a Fase 2 do Painel do Sistema, com motivo obrigatório (item pedido
// explicitamente pelo cliente).
router.post("/superadmin/tenants/:tenantId/impersonate/:userId", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.tenantId);
  const userId = Number(req.params.userId);
  if (!Number.isFinite(tenantId) || !Number.isFinite(userId)) { res.status(400).json({ error: "Loja ou usuário inválido" }); return; }
  const { reason, reasonDetail } = req.body as { reason?: string; reasonDetail?: string };
  if (!reason || !IMPERSONATE_REASONS.includes(reason as typeof IMPERSONATE_REASONS[number])) {
    res.status(400).json({ error: "Informe o motivo de entrar como este admin" }); return;
  }
  const isOutro = reason === "Outro";
  const detail = reasonDetail?.trim() || "";
  if (isOutro && !detail) { res.status(400).json({ error: "Descreva o motivo" }); return; }
  const finalReason = isOutro ? detail : reason;

  const [target] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId), eq(usersTable.role, "admin")));
  if (!target || !target.isActive) { res.status(404).json({ error: "Admin não encontrado ou inativo nesta loja" }); return; }
  const [tenantRow] = await db.select({ name: tenantsTable.name }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));

  const superadminId = req.session.userId!;
  await db.insert(impersonationLogTable).values({ tenantId, superadminUserId: superadminId, targetUserId: target.id, reason: finalReason });
  await logAudit({
    superadminUserId: superadminId, tenantId,
    action: "entrar_como",
    description: `Entrou como ${target.name} (loja "${tenantRow?.name ?? tenantId}")`,
    reason: finalReason,
  });

  req.session.impersonatorId = superadminId;
  req.session.userId = target.id;
  req.session.userRole = target.role;
  req.session.tenantId = target.tenantId;
  req.session.userSectorId = target.sectorId ?? undefined;
  req.session.userStoreId = target.storeId ?? undefined;
  req.session.userName = target.name;
  req.session.accessHours = null;
  req.session.allowedSessionKeys = null;
  res.json({ ok: true });
});

// ─── Auditoria de sessões (item 15) ────────────────────────────────────────
// Todas as sessões ativas do sistema, de qualquer loja — só o superadmin
// enxerga isso. Reaproveita a tabela "session" do connect-pg-simple.
router.get("/superadmin/sessions", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    select sid, sess::jsonb as sess, expire from session
    where expire > now()
    order by (sess::jsonb->>'loginAt') desc nulls last
  `);
  const list = rows.rows as { sid: string; sess: Record<string, unknown>; expire: string }[];
  const userIds = [...new Set(
    list.map((r) => Number(r.sess["userId"])).filter((n) => Number.isFinite(n)),
  )];
  const users = userIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, tenantId: usersTable.tenantId })
        .from(usersTable).where(inArray(usersTable.id, userIds))
    : [];
  const tenantIds = [...new Set(users.map((u) => u.tenantId).filter((t) => t > 0))];
  const tenants = tenantIds.length
    ? await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable).where(inArray(tenantsTable.id, tenantIds))
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const tenantMap = new Map(tenants.map((t) => [t.id, t.name]));

  const sessions = list.map((r) => {
    const uid = Number(r.sess["userId"]);
    const u = userMap.get(uid);
    const { device, browser } = parseUserAgent(r.sess["loginUserAgent"] as string | undefined);
    return {
      sid: r.sid,
      userId: Number.isFinite(uid) ? uid : null,
      userName: u?.name ?? "(desconhecido)",
      role: u?.role ?? null,
      tenantName: u ? (tenantMap.get(u.tenantId) ?? null) : null,
      device,
      browser,
      ip: (r.sess["loginIp"] as string | undefined) ?? null,
      loginAt: (r.sess["loginAt"] as string | undefined) ?? null,
      expiresAt: r.expire,
    };
  });
  res.json({ sessions });
});

// ─── Auditoria global do Painel do Sistema (Fase 2) ────────────────────────
// Todo lance relevante feito pelo superadmin em qualquer loja: entrar como,
// suspender/reativar, cancelar/reativar contrato, mudar módulos, criar
// loja/admin. Mais recentes primeiro; limite alto porque ainda não temos
// volume que justifique paginação de verdade.
router.get("/superadmin/audit-log", async (req, res): Promise<void> => {
  const tenantIdFilter = req.query.tenantId ? Number(req.query.tenantId) : undefined;
  const base = db.select({
    id: superadminAuditLogTable.id,
    action: superadminAuditLogTable.action,
    description: superadminAuditLogTable.description,
    reason: superadminAuditLogTable.reason,
    createdAt: superadminAuditLogTable.createdAt,
    tenantId: superadminAuditLogTable.tenantId,
    tenantName: tenantsTable.name,
    superadminName: usersTable.name,
  })
    .from(superadminAuditLogTable)
    .leftJoin(tenantsTable, eq(superadminAuditLogTable.tenantId, tenantsTable.id))
    .leftJoin(usersTable, eq(superadminAuditLogTable.superadminUserId, usersTable.id));
  const rows = await (tenantIdFilter && Number.isFinite(tenantIdFilter)
    ? base.where(eq(superadminAuditLogTable.tenantId, tenantIdFilter))
    : base
  ).orderBy(desc(superadminAuditLogTable.createdAt)).limit(300);
  res.json({ entries: rows });
});

export default router;
