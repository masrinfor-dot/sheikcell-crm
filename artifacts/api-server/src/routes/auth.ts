import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, sectorsTable, accessLogsTable, tenantsTable, impersonationLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth, isWithinAccessHours } from "../middlewares/auth";

const router: IRouter = Router();

// "Entrar como" só se aplica a quem tem loja (admin de tenant) — superadmin
// não carrega enabledModules (não pertence a loja nenhuma).
async function enabledModulesFor(tenantId: number | undefined): Promise<string[] | null> {
  if (tenantId == null) return null;
  const [t] = await db.select({ enabledModules: tenantsTable.enabledModules }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  return t?.enabledModules ?? [];
}

async function impersonatedByFor(req: Request): Promise<{ name: string } | null> {
  const impersonatorId = req.session.impersonatorId;
  if (impersonatorId == null) return null;
  const [su] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, impersonatorId));
  return su ? { name: su.name } : null;
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email e senha são obrigatórios" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase().trim()));

  if (!user || !user.isActive) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  // Vendedor com horário de acesso: bloqueia login fora da janela
  if (user.role === "vendedor" && !isWithinAccessHours(user.accessHours)) {
    res.status(403).json({ error: "Fora do horário de acesso. Fale com o administrador." });
    return;
  }

  // Multi-loja: loja suspensa/inexistente bloqueia o login (fail closed).
  // Superadmin não pertence a loja nenhuma.
  if (user.role !== "superadmin") {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
    if (!tenant || !tenant.isActive) {
      res.status(403).json({ error: "Loja suspensa. Fale com o administrador do sistema." });
      return;
    }
  }

  let sector = null;
  if (user.sectorId) {
    const [s] = await db
      .select()
      .from(sectorsTable)
      .where(eq(sectorsTable.id, user.sectorId));
    sector = s ?? null;
  }

  // Registra o horário de acesso (histórico de logins). Uma falha aqui não
  // deve impedir o login, mas fica visível no log do servidor.
  try {
    // Multi-loja: o log de acesso pertence à loja do usuário (nunca cai na
    // loja 1 por default de coluna).
    await db.insert(accessLogsTable).values({ userId: user.id, tenantId: user.tenantId });
  } catch (err) {
    console.error("[auth] falha ao registrar acesso:", err);
  }
  // Retenção: apaga registros com mais de 90 dias (1x por login, barato com índice).
  db.delete(accessLogsTable)
    .where(sql`${accessLogsTable.loggedInAt} < now() - interval '90 days'`)
    .catch(() => {});

  req.session.userId = user.id;
  req.session.accessHours = user.role === "vendedor" ? (user.accessHours ?? null) : null;
  req.session.userRole = user.role;
  req.session.tenantId = user.role === "superadmin" ? undefined : user.tenantId;
  req.session.userSectorId = user.sectorId ?? undefined;
  req.session.userName = user.name;
  // Login "de verdade" encerra qualquer impersonação que sobrou na sessão.
  req.session.impersonatorId = undefined;

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sectorId: user.sectorId,
      sector,
      storeName: user.storeName ?? null,
      permissions: user.permissions ?? null,
      mustChangePassword: user.mustChangePassword,
      adminAccess: user.adminAccess ?? null,
      enabledModules: await enabledModulesFor(req.session.tenantId),
      impersonatedBy: null,
    },
  });
});

// Troca de senha pelo próprio usuário (primeiro acesso ou quando quiser)
router.post("/auth/change-password", requireAuth, async (req, res): Promise<void> => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Informe a senha atual e a nova senha" });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: "A nova senha precisa ter pelo menos 6 caracteres" });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: "A nova senha precisa ser diferente da atual" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!user) { res.status(404).json({ error: "Usuário não encontrado" }); return; }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) { res.status(401).json({ error: "Senha atual incorreta" }); return; }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(usersTable)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(usersTable.id, user.id));
  res.json({ ok: true });
});

router.post("/auth/logout", requireAuth, (req, res): void => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let sector = null;
  if (user.sectorId) {
    const [s] = await db
      .select()
      .from(sectorsTable)
      .where(eq(sectorsTable.id, user.sectorId));
    sector = s ?? null;
  }

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sectorId: user.sectorId,
      sector,
      storeName: user.storeName ?? null,
      permissions: user.permissions ?? null,
      mustChangePassword: user.mustChangePassword,
      adminAccess: user.adminAccess ?? null,
      enabledModules: await enabledModulesFor(req.session.tenantId),
      impersonatedBy: await impersonatedByFor(req),
    },
  });
});

// "Entrar como": volta pro superadmin original (a sessão tinha sido
// sobrescrita por POST /superadmin/tenants/:id/impersonate/:userId).
router.post("/auth/stop-impersonation", requireAuth, async (req, res): Promise<void> => {
  const impersonatorId = req.session.impersonatorId;
  if (impersonatorId == null) { res.status(400).json({ error: "Não há impersonação ativa" }); return; }
  const [superadmin] = await db.select().from(usersTable).where(eq(usersTable.id, impersonatorId));
  if (!superadmin) { res.status(404).json({ error: "Usuário original não encontrado" }); return; }

  await db.update(impersonationLogTable)
    .set({ endedAt: new Date() })
    .where(sql`${impersonationLogTable.superadminUserId} = ${impersonatorId} AND ${impersonationLogTable.targetUserId} = ${req.session.userId} AND ${impersonationLogTable.endedAt} IS NULL`);

  req.session.userId = superadmin.id;
  req.session.userRole = superadmin.role;
  req.session.tenantId = undefined;
  req.session.userSectorId = superadmin.sectorId ?? undefined;
  req.session.userName = superadmin.name;
  req.session.accessHours = null;
  req.session.impersonatorId = undefined;
  res.json({ ok: true });
});

export default router;
