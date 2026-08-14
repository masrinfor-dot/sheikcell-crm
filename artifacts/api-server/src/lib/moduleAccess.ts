import type { Request, Response, NextFunction } from "express";
import { db, usersTable, OPTIONAL_MODULES, type OptionalModule } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireModule } from "../middlewares/auth";

// Módulos que um vendedor/supervisor pode ter restringidos individualmente —
// todos os módulos opcionais da loja, MENOS Atendimento: chat.ts é o
// arquivo mais crítico do sistema (webhook do WhatsApp) e nunca é gateado
// por módulo, nem no nível da loja (ver requireModule) nem aqui.
export const USER_GRANTABLE_MODULES = OPTIONAL_MODULES.filter((m): m is UserGrantableModule => m !== "chat");
export type UserGrantableModule = Exclude<OptionalModule, "chat">;
export type ModuleAccessLevel = "view" | "edit";
export type ModuleAccessMap = Partial<Record<UserGrantableModule, ModuleAccessLevel>>;

/** Sanitiza o mapa de módulos vindo do cliente (só chaves conhecidas, só "view"/"edit"). */
export function sanitizeModuleAccess(input: unknown): ModuleAccessMap | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return null;
  const valid = new Set<string>(USER_GRANTABLE_MODULES);
  const out: ModuleAccessMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (valid.has(key) && (value === "view" || value === "edit")) {
      out[key as UserGrantableModule] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Busca o module_access atual do usuário no banco (sempre fresco, mesmo padrão de getVendedorPermissions). */
async function getModuleAccess(req: Request): Promise<ModuleAccessMap | null> {
  const [row] = await db
    .select({ moduleAccess: usersTable.moduleAccess })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!))
    .limit(1);
  return row?.moduleAccess ?? null;
}

/** Nível de acesso do usuário da sessão a um módulo — admin sempre "edit". Ausência = sem acesso (fail closed). */
export async function checkModuleAccess(req: Request, moduleKey: UserGrantableModule): Promise<ModuleAccessLevel | null> {
  if (req.session.userRole === "admin") return "edit";
  return (await getModuleAccess(req))?.[moduleKey] ?? null;
}

/**
 * Exige que a loja tenha o módulo contratado (requireModule) E que o
 * usuário da sessão tenha algum nível de acesso a ele (view ou edit).
 * Além disso, bloqueia ESCRITA de verdade pra quem só tem "view": GET/HEAD
 * passam com qualquer nível, qualquer outro método (POST/PATCH/PUT/DELETE)
 * exige "edit". Cobre automaticamente todas as rotas que já usam este
 * middleware, sem precisar mexer rota por rota.
 */
export function requireModuleAccess(moduleKey: UserGrantableModule) {
  const tenantGate = requireModule(moduleKey);
  return (req: Request, res: Response, next: NextFunction): void => {
    void tenantGate(req, res, async () => {
      const level = await checkModuleAccess(req, moduleKey);
      if (level == null) {
        res.status(403).json({ error: "Você não tem acesso a este módulo. Fale com o administrador." });
        return;
      }
      const isSafeMethod = req.method === "GET" || req.method === "HEAD";
      if (!isSafeMethod && level !== "edit") {
        res.status(403).json({ error: "Você só tem acesso de visualização a este módulo. Peça ao administrador para liberar edição." });
        return;
      }
      next();
    });
  };
}
