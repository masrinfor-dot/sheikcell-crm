import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, tenantErpIntegrationsTable } from "@workspace/db";
import { tenantIdOf } from "../middlewares/auth";
import { isAllowedAfterMove } from "./erpHrMapping";

// RH mudou para o ERP Prumo (07/10/2026 — parte 5): o ERP é o dono de todo o
// RH. Aqui fica só o ponto (WhatsApp e o "Meu ponto" para bater); as telas de
// RH viram consulta e qualquer alteração responde 409 com o link do ERP.

const cache = new Map<number, { at: number; moved: boolean; webUrl: string | null }>();
const TTL_MS = 30_000;

export async function hrMovedInfo(tenantId: number): Promise<{ moved: boolean; webUrl: string | null }> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const [row] = await db.select({ moved: tenantErpIntegrationsTable.hrMovedToErp, webUrl: tenantErpIntegrationsTable.erpWebUrl })
    .from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  const info = { at: Date.now(), moved: !!row?.moved, webUrl: row?.webUrl ?? null };
  cache.set(tenantId, info);
  return info;
}

export function forgetHrMoved(tenantId: number) {
  cache.delete(tenantId);
}

export async function blockWhenHrMoved(req: Request, res: Response, next: NextFunction): Promise<void> {
  const p = req.path;
  if (!/^\/rh(-dp)?\//.test(p) || isAllowedAfterMove(req.method, p)) return next();
  const tenantId = tenantIdOf(req);
  if (tenantId == null) return next(); // rotas públicas tratam por conta própria
  try {
    const info = await hrMovedInfo(tenantId);
    if (!info.moved) return next();
    res.status(409).json({ error: "O RH agora fica no ERP Prumo — faça a alteração por lá.", movedTo: info.webUrl ? `${info.webUrl}/rh` : null });
  } catch {
    next();
  }
}
