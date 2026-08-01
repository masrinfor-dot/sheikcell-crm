import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, tenantsTable, usersTable, sectorsTable, conversationsTable, whatsappSessionsTable } from "@workspace/db";
import { eq, and, count, desc } from "drizzle-orm";
import { requireSuperadmin, invalidateTenantCache } from "../middlewares/auth";

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
      return { ...t, userCount: Number(u?.n ?? 0), conversationCount: Number(c?.n ?? 0), whatsappCount: Number(w?.n ?? 0), admins };
    }),
  );
  res.json({ tenants: result });
});

// Cria loja (e opcionalmente já o admin dela)
router.post("/superadmin/tenants", async (req, res): Promise<void> => {
  const { name, adminName, adminEmail, adminPassword } = req.body as {
    name?: string; adminName?: string; adminEmail?: string; adminPassword?: string;
  };
  if (!name?.trim()) { res.status(400).json({ error: "Informe o nome da loja" }); return; }

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
      const [tenant] = await tx.insert(tenantsTable).values({ name: name.trim() }).returning();
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
  const { name, isActive } = req.body as { name?: string; isActive?: boolean };
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Loja inválida" }); return; }
  const updates: Partial<{ name: string; isActive: boolean }> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof isActive === "boolean") updates.isActive = isActive;
  if (!Object.keys(updates).length) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [tenant] = await db.update(tenantsTable).set(updates).where(eq(tenantsTable.id, id)).returning();
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

export default router;
