import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import { db, usersTable, sectorsTable, accessLogsTable, tenantsTable, impersonationLogTable, passwordResetTokensTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth, isWithinAccessHours } from "../middlewares/auth";
import { sendEmail } from "@workspace/integrations-email";
import { enforceSessionLimit, parseUserAgent } from "../lib/sessions";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutos
const RESET_TOKEN_MIN_INTERVAL_MS = 60 * 1000; // evita reenviar em cada clique duplo

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
  req.session.userStoreId = user.storeId ?? undefined;
  req.session.userName = user.name;
  req.session.allowedSessionKeys = user.role === "vendedor" ? (user.allowedSessionKeys ?? null) : null;
  // Login "de verdade" encerra qualquer impersonação que sobrou na sessão.
  req.session.impersonatorId = undefined;
  // Controle de sessões (item 15): metadados só pra exibir/auditar depois.
  req.session.loginAt = new Date().toISOString();
  req.session.loginIp = req.ip;
  req.session.loginUserAgent = req.headers["user-agent"] ?? "";
  await enforceSessionLimit(user.id, req.sessionID).catch((err) => {
    console.error("[auth] falha ao aplicar limite de sessões:", err);
  });

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
      moduleAccess: user.moduleAccess ?? null,
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

// ── Confirmação de senha (Rotinas e Produtividade) ─────────────────────────
// Reautenticação "pura": só confirma a senha ATUAL do próprio usuário —
// nunca muda nada (diferente de change-password acima) e nunca recria a
// sessão (diferente de login). Usado antes de responder um checklist
// obrigatório (ver routes/rotinas.ts). A senha em si nunca é armazenada —
// só um carimbo "confirmado até" em memória, consumido pelo endpoint de
// resposta do checklist.
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_LOCKOUT_MS = 5 * 60_000; // 5 minutos
const verifyAttempts = new Map<string, { count: number; lockedUntil: number }>();
const PASSWORD_VERIFIED_TTL_MS = 5 * 60_000; // janela pra completar o checklist depois de confirmar a senha
const passwordVerifiedCache = new Map<string, number>(); // chave "tenantId:userId" -> expira em (epoch ms)

export function markPasswordVerified(tenantId: number, userId: number): void {
  passwordVerifiedCache.set(`${tenantId}:${userId}`, Date.now() + PASSWORD_VERIFIED_TTL_MS);
}
export function isPasswordRecentlyVerified(tenantId: number, userId: number): boolean {
  const exp = passwordVerifiedCache.get(`${tenantId}:${userId}`);
  return !!exp && exp > Date.now();
}
// Consumida depois de responder um checklist — obriga confirmar a senha de
// novo pro próximo checklist, em vez de uma confirmação valer pra vários.
export function clearPasswordVerified(tenantId: number, userId: number): void {
  passwordVerifiedCache.delete(`${tenantId}:${userId}`);
}

router.post("/auth/verify-password", requireAuth, async (req, res): Promise<void> => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "Informe a senha" }); return; }

  const tenantId = req.session.tenantId;
  const userId = req.session.userId!;
  if (tenantId == null) { res.status(403).json({ error: "Sessão sem loja associada" }); return; }
  const rateKey = `${tenantId}:${userId}`;

  const attempt = verifyAttempts.get(rateKey);
  if (attempt && attempt.lockedUntil > Date.now()) {
    const retryAfterSec = Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
    res.status(429).json({ error: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(retryAfterSec / 60)} min.`, retryAfterSec });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!valid) {
    const next = attempt ?? { count: 0, lockedUntil: 0 };
    next.count += 1;
    if (next.count >= VERIFY_MAX_ATTEMPTS) {
      next.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS;
      next.count = 0;
    }
    verifyAttempts.set(rateKey, next);
    res.status(401).json({ error: "Senha incorreta" });
    return;
  }

  verifyAttempts.delete(rateKey);
  markPasswordVerified(tenantId, userId);
  res.json({ ok: true, verifiedForSeconds: PASSWORD_VERIFIED_TTL_MS / 1000 });
});

router.post("/auth/logout", requireAuth, (req, res): void => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ─── Controle de sessões (item 15) ─────────────────────────────────────────
// Lista as sessões ativas do PRÓPRIO usuário (não de outros) — device,
// navegador, IP e horário de login, pra ele mesmo revisar e encerrar.
router.get("/auth/sessions", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.execute(sql`
    select sid, sess, expire from session
    where sess->>'userId' = ${String(req.session.userId)} and expire > now()
    order by (sess->>'loginAt') desc nulls last
  `);
  const sessions = (rows.rows as { sid: string; sess: Record<string, unknown>; expire: string }[]).map((r) => {
    const { device, browser } = parseUserAgent(r.sess["loginUserAgent"] as string | undefined);
    return {
      sid: r.sid,
      isCurrent: r.sid === req.sessionID,
      device,
      browser,
      ip: (r.sess["loginIp"] as string | undefined) ?? null,
      loginAt: (r.sess["loginAt"] as string | undefined) ?? null,
      expiresAt: r.expire,
    };
  });
  res.json({ sessions });
});

// Encerra UMA sessão específica do próprio usuário (nunca a atual — pra
// isso é POST /auth/logout — e nunca de outro usuário).
router.delete("/auth/sessions/:sid", requireAuth, async (req, res): Promise<void> => {
  const sid = Array.isArray(req.params.sid) ? req.params.sid[0] : req.params.sid;
  if (sid === req.sessionID) {
    res.status(400).json({ error: "Use \"Sair\" para encerrar a sessão atual" });
    return;
  }
  await db.execute(sql`
    delete from session where sid = ${sid} and sess->>'userId' = ${String(req.session.userId)}
  `);
  res.json({ ok: true });
});

// "Encerrar todas as outras sessões" — mantém só a atual.
router.post("/auth/sessions/end-others", requireAuth, async (req, res): Promise<void> => {
  await db.execute(sql`
    delete from session where sess->>'userId' = ${String(req.session.userId)} and sid != ${req.sessionID}
  `);
  res.json({ ok: true });
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
      moduleAccess: user.moduleAccess ?? null,
      enabledModules: await enabledModulesFor(req.session.tenantId),
      impersonatedBy: await impersonatedByFor(req),
    },
  });
});

// Auto-edição de nome/e-mail (qualquer role, inclusive superadmin) — SEMPRE
// no próprio usuário da sessão (req.session.userId), nunca um id vindo do
// corpo da requisição. Existe justamente pra edição de perfil não depender
// das rotas /admin/users, que bloqueiam qualquer alvo com role "superadmin"
// (ver admin.ts) — o superadmin edita a própria conta por aqui.
router.patch("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const { name, email } = req.body as { name?: string; email?: string };
  const updateData: Record<string, unknown> = {};

  if (name !== undefined) {
    const cleanName = name.trim();
    if (!cleanName) { res.status(400).json({ error: "Nome não pode ficar vazio" }); return; }
    updateData.name = cleanName;
  }
  if (email !== undefined) {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) { res.status(400).json({ error: "E-mail inválido" }); return; }
    // E-mail é único na tabela inteira (login não filtra por loja), então a
    // checagem de colisão também precisa ser global, não só dentro da loja.
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable)
      .where(eq(usersTable.email, cleanEmail)).limit(1);
    if (existing && existing.id !== req.session.userId) {
      res.status(409).json({ error: "Este e-mail já está em uso por outra conta" });
      return;
    }
    updateData.email = cleanEmail;
  }
  if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }

  const [user] = await db.update(usersTable).set(updateData)
    .where(eq(usersTable.id, req.session.userId!)).returning();
  if (!user) { res.status(404).json({ error: "Usuário não encontrado" }); return; }

  if (user.name) req.session.userName = user.name;

  let sector = null;
  if (user.sectorId) {
    const [s] = await db.select().from(sectorsTable).where(eq(sectorsTable.id, user.sectorId));
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
      moduleAccess: user.moduleAccess ?? null,
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
  req.session.userStoreId = undefined;
  req.session.userName = superadmin.name;
  req.session.accessHours = null;
  req.session.impersonatorId = undefined;
  res.json({ ok: true });
});

// "Esqueci minha senha": gera um token de uso único (30 min) e manda por
// e-mail. Resposta é SEMPRE genérica (mesmo se o e-mail não existir na
// base) pra não permitir enumerar quais e-mails estão cadastrados.
router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const { email } = req.body as { email?: string };
  const genericResponse = { ok: true, message: "Se o e-mail existir, enviamos um link de redefinição." };
  if (!email?.trim()) { res.json(genericResponse); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.trim().toLowerCase()));
  if (!user || !user.isActive) { res.json(genericResponse); return; }

  // Evita spam em clique duplo: se já existe token válido bem recente, não gera outro nem reenvia.
  const [recent] = await db.select({ id: passwordResetTokensTable.id })
    .from(passwordResetTokensTable)
    .where(sql`${passwordResetTokensTable.userId} = ${user.id} AND ${passwordResetTokensTable.usedAt} IS NULL AND ${passwordResetTokensTable.createdAt} > now() - interval '60 seconds'`);
  if (recent) { res.json(genericResponse); return; }

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await db.insert(passwordResetTokensTable).values({ userId: user.id, tokenHash: hashResetToken(rawToken), expiresAt });

  const origin = req.get("origin") ?? process.env.APP_URL ?? `${req.protocol}://${req.get("host")}`;
  const resetLink = `${origin}/reset-password/${rawToken}`;
  try {
    await sendEmail({
      to: user.email,
      subject: "Redefinição de senha — Sheikcell",
      html: `<p>Olá, ${user.name}.</p><p>Recebemos uma solicitação para redefinir sua senha. Clique no link abaixo (válido por 30 minutos, uso único):</p><p><a href="${resetLink}">${resetLink}</a></p><p>Se você não pediu isso, pode ignorar este e-mail.</p>`,
    });
  } catch (err) {
    req.log.error({ err }, "Falha ao enviar e-mail de redefinição de senha");
  }
  res.json(genericResponse);
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const { token, newPassword, confirmNewPassword } = req.body as { token?: string; newPassword?: string; confirmNewPassword?: string };
  if (!token || !newPassword || !confirmNewPassword) { res.status(400).json({ error: "Preencha todos os campos" }); return; }
  if (newPassword.length < 6) { res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres" }); return; }
  if (newPassword !== confirmNewPassword) { res.status(400).json({ error: "As senhas não coincidem" }); return; }

  const [row] = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.tokenHash, hashResetToken(token)));
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: "Link inválido ou expirado. Solicite um novo." });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ passwordHash, mustChangePassword: false }).where(eq(usersTable.id, row.userId));
    await tx.update(passwordResetTokensTable).set({ usedAt: new Date() }).where(eq(passwordResetTokensTable.id, row.id));
  });
  res.json({ ok: true });
});

export default router;
