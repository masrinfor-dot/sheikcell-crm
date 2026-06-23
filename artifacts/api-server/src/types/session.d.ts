import "express-session";
import "express";

declare module "express-session" {
  interface SessionData {
    userId: number;
    userRole: string;
    userSectorId: number | undefined;
    userName: string | undefined;
  }
}

declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
