// TV Box passada para o ERP (17/10/2026). Depois que o admin clica em
// "Desligar no CRM" (TV Box › Passar para o ERP):
// - a cobrança automática do CRM para nesta loja: não gera mais mensalidade
//   do mês, não manda lembrete nem cobrança pelo WhatsApp;
// - o painel vira só consulta (qualquer alteração responde 410 com o aviso).
// O arquivo exportado leva `crmBillingDisabled` = esse flag; é ele que libera
// a cobrança automática no ERP — assim os dois nunca cobram ao mesmo tempo.
import { and, eq } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";
import { appSetting, saveAppSetting } from "./tradeInMoved";

export const TV_BOX_MOVED_KEY = "tvbox_moved_to_erp";
export const TV_BOX_ERP_URL_KEY = "tvbox_erp_url";

export async function tvBoxMovedToErp(tenantId: number): Promise<boolean> {
  return (await appSetting(tenantId, TV_BOX_MOVED_KEY)) === "true";
}

export async function setTvBoxMovedToErp(tenantId: number, moved: boolean): Promise<void> {
  await saveAppSetting(tenantId, TV_BOX_MOVED_KEY, moved ? "true" : "false");
}

export async function tvBoxErpUrl(tenantId: number): Promise<string> {
  return (await appSetting(tenantId, TV_BOX_ERP_URL_KEY)) ?? "";
}

export async function saveTvBoxErpUrl(tenantId: number, url: string): Promise<void> {
  await saveAppSetting(tenantId, TV_BOX_ERP_URL_KEY, url);
}

/** Lojas que já passaram a TV Box para o ERP (o agendador pula todas elas). */
export async function tenantsWithTvBoxMoved(): Promise<Set<number>> {
  const rows = await db.select({ tenantId: appSettingsTable.tenantId }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.key, TV_BOX_MOVED_KEY), eq(appSettingsTable.value, "true")));
  return new Set(rows.map((r) => r.tenantId));
}
