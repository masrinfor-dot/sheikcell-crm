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
