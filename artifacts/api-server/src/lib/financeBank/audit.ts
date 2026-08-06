import type { Request } from "express";
import { db, financeAuditLogTable } from "@workspace/db";
import { logger } from "../logger.ts";

// Trilha de auditoria do módulo financeiro bancário — quem cadastrou/editou/
// excluiu conta, gravou credencial, confirmou/rejeitou conciliação, ou tentou
// reautenticar (sucesso ou falha). Só inserção, nunca editável pelas rotas
// operacionais. Vive num módulo próprio (não em routes/financeBank.ts) para
// poder ser importado tanto pelas rotas quanto pelo middleware requireReauth
// sem criar dependência circular entre os dois arquivos.
//
// Falha ao gravar o log nunca derruba a ação em si (auditoria não pode ser
// motivo de indisponibilidade), só registra um warn.
export async function logFinanceAudit(
  req: Request, tenantId: number, action: string, entityType: string, entityId: number, metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(financeAuditLogTable).values({
      tenantId, userId: req.session.userId ?? null, action, entityType, entityId,
      metadata: metadata ?? null, ipAddress: req.ip ?? null,
    });
  } catch (err) {
    logger.warn({ err, action, entityType, entityId }, "Falha ao gravar log de auditoria financeira");
  }
}
