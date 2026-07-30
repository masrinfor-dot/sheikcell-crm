import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, sectorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, isWithinAccessHours } from "../middlewares/auth";

const router: IRouter = Router();

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

  let sector = null;
  if (user.sectorId) {
    const [s] = await db
      .select()
      .from(sectorsTable)
      .where(eq(sectorsTable.id, user.sectorId));
    sector = s ?? null;
  }

  req.session.userId = user.id;
  req.session.accessHours = user.role === "vendedor" ? (user.accessHours ?? null) : null;
  req.session.userRole = user.role;
  req.session.userSectorId = user.sectorId ?? undefined;
  req.session.userName = user.name;

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sectorId: user.sectorId,
      sector,
      permissions: user.permissions ?? null,
      mustChangePassword: user.mustChangePassword,
      adminAccess: user.adminAccess ?? null,
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
      permissions: user.permissions ?? null,
      mustChangePassword: user.mustChangePassword,
      adminAccess: user.adminAccess ?? null,
    },
  });
});

export default router;
