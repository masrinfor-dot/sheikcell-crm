import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Permissões individuais de vendedor. null/ausente = liberado (padrão).
// Admin e supervisor sempre têm tudo liberado — as chaves só valem p/ vendedor.
export const PERMISSION_KEYS = [
  "ver_potenciais",   // ver e assumir Potenciais (leads novos)
  "transferir",       // transferir conversa para outro setor
  "finalizar",        // finalizar atendimentos
  "criar_atendimento",// criar novo atendimento manualmente
  "usar_ia",          // sugestão de resposta / correção com IA
  "crm",              // acessar o CRM
  "tarefas",          // acessar o quadro de Tarefas
  "enviar_midia",     // enviar fotos, áudios e arquivos
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export function permAllowed(perms: Record<string, boolean> | null | undefined, key: PermissionKey): boolean {
  // Ausência da chave = liberado (compatível com usuários antigos sem registro).
  return perms?.[key] !== false;
}

/** Busca as permissões atuais do usuário no banco (sempre frescas — mudanças
 *  do admin valem sem precisar de novo login). Admin/supervisor → null (tudo). */
export async function getVendedorPermissions(req: Request): Promise<Record<string, boolean> | null> {
  if (req.session.userRole !== "vendedor") return null;
  const [row] = await db
    .select({ permissions: usersTable.permissions })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!))
    .limit(1);
  return row?.permissions ?? null;
}

export async function checkPerm(req: Request, key: PermissionKey): Promise<boolean> {
  if (req.session.userRole !== "vendedor") return true;
  return permAllowed(await getVendedorPermissions(req), key);
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
