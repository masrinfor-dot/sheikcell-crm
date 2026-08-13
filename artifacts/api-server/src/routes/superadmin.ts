import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, tenantsTable, usersTable, sectorsTable, conversationsTable, whatsappSessionsTable, saasContractsTable, saasInvoicesTable, impersonationLogTable, OPTIONAL_MODULES, type OptionalModule } from "@workspace/db";
import { eq, and, count, desc, lt } from "drizzle-orm";
import { requireSuperadmin, invalidateTenantCache } from "../middlewares/auth";
import { validateCpfCnpj } from "../lib/cpfCnpj";

function sanitizeModules(v: unknown): OptionalModule[] {
  if (!Array.isArray(v)) return [];
  const valid = new Set<string>(OPTIONAL_MODULES);
  return v.filter((m): m is OptionalModule => typeof m === "string" && valid.has(m));
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
      const [[u], [c], [w]] = await Promise.all([
        db.select({ n: count() }).from(usersTable).where(and(eq(usersTable.tenantId, t.id), eq(usersTable.isActive, true))),
        db.select({ n: count() }).from(conversationsTable).where(eq(conversationsTable.tenantId, t.id)),
        db.select({ n: count() }).from(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, t.id)),
      ]);
      const admins = await db
        .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, isActive: usersTable.isActive })
        .from(usersTable)
        .where(and(eq(usersTable.tenantId, t.id), eq(usersTable.role, "admin")));
      const today = new Date().toISOString().slice(0, 10);
      const [contract] = await db.select().from(saasContractsTable).where(eq(saasContractsTable.tenantId, t.id));
      const [[overdue]] = await Promise.all([
        db.select({ n: count() }).from(saasInvoicesTable)
          .where(and(eq(saasInvoicesTable.tenantId, t.id), eq(saasInvoicesTable.status, "pendente"), lt(saasInvoicesTable.dueDate, today))),
      ]);
      const overdueCount = Number(overdue?.n ?? 0);
      // Situação comercial: cancelado (manual) > inadimplente (derivada) > ativo
      const saasStatus = t.saasStatus === "cancelado" ? "cancelado" : overdueCount > 0 ? "inadimplente" : "ativo";
      return {
        ...t,
        saasStatus,
        overdueCount,
        contract: contract ?? null,
        userCount: Number(u?.n ?? 0),
        conversationCount: Number(c?.n ?? 0),
        whatsappCount: Number(w?.n ?? 0),
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
    // "inadimplente" é derivada das mensalidades — só ativo/cancelado é manual
    if (!["ativo", "cancelado"].includes(saasStatus)) { res.status(400).json({ error: "Situação inválida" }); return; }
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
  res.json({ tenant });
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
  res.status(201).json({ admin: u ? { id: u.id, name: u.name, email: u.email } : null });
});

// "Entrar como": o superadmin assume a sessão de um admin ativo da loja,
// pra ver/usar o painel dela exatamente como ela vê. Guarda o próprio id
// pra dar pra voltar (POST /auth/stop-impersonation) e registra no log.
router.post("/superadmin/tenants/:tenantId/impersonate/:userId", async (req, res): Promise<void> => {
  const tenantId = Number(req.params.tenantId);
  const userId = Number(req.params.userId);
  if (!Number.isFinite(tenantId) || !Number.isFinite(userId)) { res.status(400).json({ error: "Loja ou usuário inválido" }); return; }
  const [target] = await db.select().from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId), eq(usersTable.role, "admin")));
  if (!target || !target.isActive) { res.status(404).json({ error: "Admin não encontrado ou inativo nesta loja" }); return; }

  const superadminId = req.session.userId!;
  await db.insert(impersonationLogTable).values({ tenantId, superadminUserId: superadminId, targetUserId: target.id });

  req.session.impersonatorId = superadminId;
  req.session.userId = target.id;
  req.session.userRole = target.role;
  req.session.tenantId = target.tenantId;
  req.session.userSectorId = target.sectorId ?? undefined;
  req.session.userName = target.name;
  req.session.accessHours = null;
  req.session.allowedSessionKeys = null;
  res.json({ ok: true });
});

export default router;
