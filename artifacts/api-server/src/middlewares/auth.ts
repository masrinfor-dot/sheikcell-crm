import { type Request, type Response, type NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
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
