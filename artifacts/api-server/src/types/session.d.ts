import "express-session";
import "express";

declare module "express-session" {
  interface SessionData {
    userId: number;
    userRole: string;
    userSectorId: number | undefined;
    userName: string | undefined;
    // Horário de acesso do vendedor (null/undefined = sem restrição)
    accessHours: { start: string; end: string; days: number[] } | null | undefined;
  }
}

declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
