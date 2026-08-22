import "express-session";
import "express";

declare module "express-session" {
  interface SessionData {
    userId: number;
    userRole: string;
    // Loja (tenant) do usuário. Superadmin não tem loja (undefined).
    tenantId: number | undefined;
    userSectorId: number | undefined;
    // Loja (stores.id — loja física dentro do tenant, multi-loja). Usado
    // pra escopar supervisor por loja (Fase 6 de Rotinas e Produtividade).
    userStoreId: number | undefined;
    userName: string | undefined;
    // Horário de acesso do vendedor (null/undefined = sem restrição)
    accessHours: { start: string; end: string; days: number[] } | null | undefined;
    // Linhas de WhatsApp (session_key) que o vendedor pode ver/responder.
    // null/undefined = sem restrição. Só relevante para role "vendedor".
    allowedSessionKeys: string[] | null | undefined;
    // "Entrar como": id do superadmin original, guardado enquanto a sessão
    // está atuando como um admin de loja. Presente = mostra a faixa de
    // impersonação no front e libera POST /auth/stop-impersonation.
    impersonatorId: number | undefined;
  }
}

declare module "express" {
  interface Request {
    rawBody?: Buffer;
  }
}
