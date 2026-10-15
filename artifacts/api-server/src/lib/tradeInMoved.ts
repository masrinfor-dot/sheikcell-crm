// Avaliação de usados passada pro ERP (07/10/2026): depois que o admin
// desliga aqui (Avaliação de usados › "Desligar no CRM"), o CRM para de
// avaliar/fechar compra e o robô do WhatsApp para de avaliar por conversa.
import { and, eq } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";

export const TRADE_IN_MOVED_KEY = "tradein_moved_to_erp";
export const TRADE_IN_ERP_URL_KEY = "tradein_erp_url";

export async function appSetting(tenantId: number, key: string): Promise<string | null> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, key))).limit(1);
  return row?.value ?? null;
}

export async function saveAppSetting(tenantId: number, key: string, value: string): Promise<void> {
  await db.insert(appSettingsTable).values({ tenantId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [appSettingsTable.tenantId, appSettingsTable.key], set: { value, updatedAt: new Date() } });
}

export async function tradeInMovedToErp(tenantId: number): Promise<boolean> {
  return (await appSetting(tenantId, TRADE_IN_MOVED_KEY)) === "true";
}
