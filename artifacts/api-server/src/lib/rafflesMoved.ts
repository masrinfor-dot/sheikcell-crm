// Sorteios passados pro ERP Prumo (17/10/2026). Depois que o admin desliga
// aqui (Sorteios › "Desligar no CRM"), o CRM não cria, edita, sorteia nem
// reenvia mais nada: a tela vira consulta do histórico com o link do ERP.
// O sorteio automático e o reenvio automático também param para essa loja.
// O WhatsApp continua sendo do CRM: os avisos aos ganhadores dos sorteios do
// ERP saem por aqui (lib/erpRaffleMessages.ts).
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, appSettingsTable, tenantErpIntegrationsTable } from "@workspace/db";
import { tenantIdOf } from "../middlewares/auth";
import { appSetting, saveAppSetting } from "./tradeInMoved";

export const RAFFLES_MOVED_KEY = "raffles_moved_to_erp";
export const RAFFLES_ERP_URL_KEY = "raffles_erp_url";

export async function rafflesMovedToErp(tenantId: number): Promise<boolean> {
  return (await appSetting(tenantId, RAFFLES_MOVED_KEY)) === "true";
}

/** Lojas que já desligaram os sorteios aqui (para os jobs automáticos). */
export async function tenantsWithRafflesMoved(): Promise<Set<number>> {
  const rows = await db.select({ tenantId: appSettingsTable.tenantId }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.key, RAFFLES_MOVED_KEY), eq(appSettingsTable.value, "true")));
  return new Set(rows.map((r) => r.tenantId));
}

/** Endereço do ERP: o salvo no card; senão o que a integração informou. */
export async function rafflesErpUrl(tenantId: number): Promise<string> {
  const saved = await appSetting(tenantId, RAFFLES_ERP_URL_KEY);
  if (saved) return saved;
  const [row] = await db.select({ webUrl: tenantErpIntegrationsTable.erpWebUrl })
    .from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  return row?.webUrl ?? "";
}

export async function saveRafflesMoved(tenantId: number, data: { moved?: boolean; erpUrl?: string }): Promise<void> {
  if (data.moved !== undefined) await saveAppSetting(tenantId, RAFFLES_MOVED_KEY, data.moved ? "true" : "false");
  if (data.erpUrl !== undefined) await saveAppSetting(tenantId, RAFFLES_ERP_URL_KEY, data.erpUrl);
}

/** Link da tela de sorteios no ERP ("" sem endereço). */
export function erpRafflesLink(erpUrl: string): string {
  const base = erpUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/sorteios` : "";
}

/** Só leitura (GET) continua liberada depois de desligar. */
export function isRaffleWrite(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/** Bloqueia criar/editar/excluir/sortear/reenviar depois de desligar no CRM. */
export async function blockWhenRafflesMoved(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = tenantIdOf(req);
  if (!isRaffleWrite(req.method) || tenantId == null) return next();
  try {
    if (await rafflesMovedToErp(tenantId)) {
      const link = erpRafflesLink(await rafflesErpUrl(tenantId));
      res.status(410).json({ error: "Os sorteios agora são feitos no ERP.", movedTo: link || null });
      return;
    }
  } catch {
    /* sem conseguir ler a configuração, segue como sempre */
  }
  next();
}

