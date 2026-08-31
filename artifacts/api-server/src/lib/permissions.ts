import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Permissões de AÇÃO de vendedor E supervisor (não são módulo/aba — ver
// lib/moduleAccess.ts pra isso). null/ausente = liberado (padrão). Admin
// sempre tem tudo liberado.
export const PERMISSION_KEYS = [
  "ver_potenciais",   // ver e assumir Potenciais (leads novos)
  "transferir",       // transferir conversa para outro setor
  "finalizar",        // finalizar atendimentos
  "criar_atendimento",// criar novo atendimento manualmente
  "usar_ia",          // sugestão de resposta / correção com IA
  "enviar_midia",     // enviar fotos, áudios e arquivos
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export function permAllowed(perms: Record<string, boolean> | null | undefined, key: PermissionKey): boolean {
  // Ausência da chave = liberado (compatível com usuários antigos sem registro).
  return perms?.[key] !== false;
}

/** Busca as permissões atuais do usuário no banco (sempre frescas — mudanças
 *  do admin valem sem precisar de novo login). Admin → null (tudo). */
export async function getVendedorPermissions(req: Request): Promise<Record<string, boolean> | null> {
  if (req.session.userRole === "admin") return null;
  const [row] = await db
    .select({ permissions: usersTable.permissions })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!))
    .limit(1);
  return row?.permissions ?? null;
}

export async function checkPerm(req: Request, key: PermissionKey): Promise<boolean> {
  if (req.session.userRole === "admin") return true;
  return permAllowed(await getVendedorPermissions(req), key);
}

/** Busca as linhas de WhatsApp permitidas atuais do vendedor no banco
 *  (sempre frescas — mudança do admin vale sem exigir novo login). Antes
 *  isso vinha só de req.session.allowedSessionKeys, fixado no login: o admin
 *  restringia/liberava uma linha e o vendedor já logado continuava vendo o
 *  conjunto antigo até deslogar e logar de novo. Só vendedor é restrito;
 *  outros papéis sempre veem todas as linhas (null = sem restrição). */
export async function getCurrentAllowedSessionKeys(req: Request): Promise<string[] | null> {
  if (req.session.userRole !== "vendedor") return null;
  const [row] = await db
    .select({ allowedSessionKeys: usersTable.allowedSessionKeys })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!))
    .limit(1);
  return row?.allowedSessionKeys ?? null;
}

/** Middleware: bloqueia vendedores sem a permissão. */
export function requirePerm(key: PermissionKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (await checkPerm(req, key)) { next(); return; }
    res.status(403).json({ error: "Você não tem permissão para esta ação. Fale com o administrador." });
  };
}

/** Sanitiza o objeto de permissões vindo do cliente (só chaves conhecidas, só boolean). */
export function sanitizePermissions(input: unknown): Record<string, boolean> | null {
  if (input == null || typeof input !== "object") return null;
  const out: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}
