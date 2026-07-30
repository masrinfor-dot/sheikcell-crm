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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Vendedor fora do horário de acesso: bloqueia até a próxima janela
  if (req.session.userRole === "vendedor" && !isWithinAccessHours(req.session.accessHours)) {
    res.status(403).json({ error: "Fora do horário de acesso. Fale com o administrador." });
    return;
  }
  next();
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
  next();
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

export function requireAdminOrSupervisor(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.session.userRole !== "admin" && req.session.userRole !== "supervisor") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/** Returns true if the role has global visibility (not sector-scoped) */
export function isGlobalRole(role: string | undefined): boolean {
  return role === "admin" || role === "supervisor";
}
