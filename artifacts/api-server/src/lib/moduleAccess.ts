import type { Request, Response, NextFunction } from "express";
import { db, usersTable, OPTIONAL_MODULES, type OptionalModule } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireModule } from "../middlewares/auth";

// Módulos que um vendedor/supervisor pode ter restringidos individualmente —
// todos os módulos opcionais da loja, MENOS Atendimento: "chat" tem regra
// própria (ver ChatAccessLevel/checkChatAccess mais abaixo) porque chat.ts
// é o arquivo mais crítico do sistema (webhook do WhatsApp) e o acesso à
// LOJA a ele nunca é gateado por módulo (nem aqui nem em requireModule);
// só o acesso individual do USUÁRIO pode ser restringido, e com
// default-liberado (ausência de config = acesso total), pra nunca quebrar
// conta já existente.
export const USER_GRANTABLE_MODULES = OPTIONAL_MODULES.filter((m): m is UserGrantableModule => m !== "chat");
export type UserGrantableModule = Exclude<OptionalModule, "chat">;
export type ModuleAccessLevel = "view" | "edit";
export type ModuleAccessMap = Partial<Record<UserGrantableModule, ModuleAccessLevel>>;

// Atendimento (chat) — 3 estados em vez de 2: "none" bloqueia de verdade,
// "view"/"edit" iguais aos demais módulos, e AUSÊNCIA da chave (undefined)
// significa LIBERADO (oposto da regra dos demais módulos, de propósito —
// ver comentário no schema em lib/db/src/schema/users.ts). Só é gravável
// por um admin (as rotas que aceitam moduleAccess.chat ficam sempre atrás
// de requireAdmin — nunca requireAdminOrSupervisor).
export type ChatAccessLevel = "none" | "view" | "edit";
export type FullModuleAccessMap = ModuleAccessMap & { chat?: ChatAccessLevel };

/** Sanitiza o mapa de módulos vindo do cliente (só chaves conhecidas, só níveis válidos). */
export function sanitizeModuleAccess(input: unknown): FullModuleAccessMap | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return null;
  const valid = new Set<string>(USER_GRANTABLE_MODULES);
  const out: FullModuleAccessMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (valid.has(key) && (value === "view" || value === "edit")) {
      out[key as UserGrantableModule] = value;
    } else if (key === "chat" && (value === "none" || value === "view" || value === "edit")) {
      out.chat = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Busca o module_access atual do usuário no banco (sempre fresco, mesmo padrão de getVendedorPermissions). */
async function getModuleAccess(req: Request): Promise<FullModuleAccessMap | null> {
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
 * Nível de acesso do usuário da sessão ao Atendimento — admin sempre "edit";
 * demais papéis usam o que um admin configurou em moduleAccess.chat, com
 * default "edit" (liberado) quando nunca foi configurado, pra não quebrar
 * nenhuma conta existente. Só bloqueia (ou restringe a "view") quem um
 * admin restringiu explicitamente.
 */
export async function checkChatAccess(req: Request): Promise<ChatAccessLevel> {
  if (req.session.userRole === "admin") return "edit";
  const level = (await getModuleAccess(req))?.chat;
  return level ?? "edit";
}

/** Mesma lógica de requireModuleAccess, mas pro Atendimento — sem o gate de
 * loja (requireModule), que nunca se aplica a chat.ts (ver comentário acima). */
export function requireChatAccess() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const level = await checkChatAccess(req);
    if (level === "none") {
      res.status(403).json({ error: "Você não tem acesso ao Atendimento. Fale com o administrador." });
      return;
    }
    const isSafeMethod = req.method === "GET" || req.method === "HEAD";
    if (!isSafeMethod && level !== "edit") {
      res.status(403).json({ error: "Você só tem acesso de visualização ao Atendimento. Peça ao administrador para liberar edição." });
      return;
    }
    next();
  };
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
