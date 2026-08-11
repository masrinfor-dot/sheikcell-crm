import { type Request, type Response, type NextFunction } from "express";

export type AccessHours = { start: string; end: string; days: number[] };

/** Verifica se o horário atual (America/Sao_Paulo) está dentro do horário de acesso. */
export function isWithinAccessHours(ah: AccessHours | null | undefined): boolean {
  if (!ah || !ah.start || !ah.end) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[get("weekday")] ?? 0;
  if (Array.isArray(ah.days) && ah.days.length > 0 && !ah.days.includes(day)) return false;
  const now = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  const [sh, sm] = ah.start.split(":").map(Number);
  const [eh, em] = ah.end.split(":").map(Number);
  const start = (sh ?? 0) * 60 + (sm ?? 0);
  const end = (eh ?? 0) * 60 + (em ?? 0);
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return true;
  // Suporta janelas que cruzam a meia-noite (ex.: 22:00 → 06:00)
  return start < end ? now >= start && now <= end : now >= start || now <= end;
}

// ── Multi-loja (tenant) ─────────────────────────────────────────────────────
// Cache curto de lojas suspensas para bloquear uso sem custo de DB por request.
const suspendedCache = { at: 0, ids: new Set<number>() };
export async function isTenantSuspended(tenantId: number): Promise<boolean> {
  const now = Date.now();
  if (now - suspendedCache.at > 30_000) {
    try {
      const { db, tenantsTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isActive, false));
      suspendedCache.ids = new Set(rows.map((r) => r.id));
      suspendedCache.at = now;
    } catch {
      // FAIL CLOSED: se a consulta falhou e o cache nunca foi populado ou está
      // velho demais (> 5 min), trata como suspensa — melhor bloquear uma loja
      // ativa durante uma falha de banco do que deixar uma suspensa operar.
      if (suspendedCache.at === 0 || now - suspendedCache.at > 300_000) return true;
      // Cache recente (< 5 min): usa o retrato anterior.
    }
  }
  return suspendedCache.ids.has(tenantId);
}
export function invalidateTenantCache(): void { suspendedCache.at = 0; }

/**
 * Loja (tenant) da sessão. Fail closed: sessão sem tenant (ex.: superadmin ou
 * sessão antiga de antes do multi-loja) NÃO acessa rotas de dados — retorna
 * null e o chamador deve responder 401/403.
 */
export function tenantIdOf(req: Request): number | null {
  const t = req.session?.tenantId;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

/** Exige uma sessão de usuário de loja; injeta o tenantId ou responde 403. */
export function requireTenant(req: Request, res: Response): number | null {
  const t = tenantIdOf(req);
  if (t == null) {
    res.status(403).json({ error: "Sessão sem loja. Faça login novamente." });
    return null;
  }
  return t;
}

export function requireSuperadmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.session.userRole !== "superadmin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Loja suspensa: bloqueia tudo (fail closed) — exceto superadmin (sem loja)
  const tid = req.session.tenantId;
  if (typeof tid === "number") {
    void isTenantSuspended(tid).then((suspended) => {
      if (suspended) {
        res.status(403).json({ error: "Loja suspensa. Fale com o administrador do sistema." });
        return;
      }
      afterTenantCheck(req, res, next);
    });
    return;
  }
  afterTenantCheck(req, res, next);
}

function afterTenantCheck(req: Request, res: Response, next: NextFunction): void {
  // Vendedor fora do horário de acesso: bloqueia até a próxima janela
  if (req.session.userRole === "vendedor" && !isWithinAccessHours(req.session.accessHours)) {
    res.status(403).json({ error: "Fora do horário de acesso. Fale com o administrador." });
    return;
  }
  next();
}

// Bloqueia a request se a loja da sessão estiver suspensa (fail closed).
// Compartilhado por todos os middlewares autenticados.
function blockIfTenantSuspended(req: Request, res: Response, next: NextFunction): void {
  const tid = req.session.tenantId;
  if (typeof tid !== "number") { next(); return; }
  void isTenantSuspended(tid).then((suspended) => {
    if (suspended) {
      res.status(403).json({ error: "Loja suspensa. Fale com o administrador do sistema." });
      return;
    }
    next();
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.session.userRole !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  blockIfTenantSuspended(req, res, next);
}

/**
 * Admin OU usuário com a função de admin liberada no cadastro (adminAccess).
 * Permite dar a vendedores/supervisores acesso a abas específicas de admin.
 */
export function requireFeature(feature: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const tid = req.session.tenantId;
    if (typeof tid === "number" && (await isTenantSuspended(tid))) {
      res.status(403).json({ error: "Loja suspensa. Fale com o administrador do sistema." });
      return;
    }
    if (req.session.userRole === "admin") { next(); return; }
    try {
      const { db, usersTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [u] = await db.select({ adminAccess: usersTable.adminAccess })
        .from(usersTable).where(eq(usersTable.id, req.session.userId));
      if (Array.isArray(u?.adminAccess) && u.adminAccess.includes(feature)) { next(); return; }
    } catch { /* fail closed */ }
    res.status(403).json({ error: "Forbidden" });
  };
}

// ── Módulos opcionais contratados pela loja (teto por tenant) ──────────────
// Cache curto por tenant (mesmo padrão de isTenantSuspended acima) — evita
// bater no banco a cada request de um módulo opcional.
const enabledModulesCache = new Map<number, { at: number; modules: Set<string> }>();
async function getEnabledModules(tenantId: number): Promise<Set<string>> {
  const cached = enabledModulesCache.get(tenantId);
  const now = Date.now();
  if (cached && now - cached.at < 30_000) return cached.modules;
  const { db, tenantsTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select({ enabledModules: tenantsTable.enabledModules })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  const modules = new Set<string>(row?.enabledModules ?? []);
  enabledModulesCache.set(tenantId, { at: now, modules });
  return modules;
}

/** Exige que a loja da sessão tenha o módulo opcional contratado (fail closed). */
export function requireModule(moduleKey: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tid = tenantIdOf(req);
    if (tid == null) { res.status(403).json({ error: "Forbidden" }); return; }
    try {
      const modules = await getEnabledModules(tid);
      if (!modules.has(moduleKey)) {
        res.status(403).json({ error: "Módulo não contratado para esta loja." });
        return;
      }
      next();
    } catch {
      res.status(403).json({ error: "Forbidden" });
    }
  };
}

export function requireAdminOrSupervisor(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.session.userRole !== "admin" && req.session.userRole !== "supervisor") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  blockIfTenantSuspended(req, res, next);
}

/** Returns true if the role has global visibility WITHIN its tenant (not sector-scoped) */
export function isGlobalRole(role: string | undefined): boolean {
  return role === "admin" || role === "supervisor";
}
