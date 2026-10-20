// Vitrine pública no ERP (17/10/2026): a página /loja/<slug> do ERP Prumo
// faz o mesmo que /vitrine/<slug> e /avaliar/<slug> daqui. Enquanto o Samuel
// testa, as duas convivem; quando ele ligar "Redirecionar a vitrine pública
// para o ERP" (Vitrine › Link público), os links antigos do CRM levam o
// cliente para o ERP (302 pelo nginx e, de reserva, pela própria página).
// Desligado (padrão), nada muda.
import { eq } from "drizzle-orm";
import { db, tenantErpIntegrationsTable, tenantsTable } from "@workspace/db";
import { appSetting, saveAppSetting, TRADE_IN_ERP_URL_KEY } from "./tradeInMoved";

export const VITRINE_REDIRECT_KEY = "vitrine_redirect_to_erp";
export type VitrinePublicKind = "vitrine" | "avaliar";

/** Endereço da loja no ERP; null se o endereço do ERP for inválido. */
export function buildErpLojaUrl(erpWebUrl: string | null | undefined, slug: string, kind: VitrinePublicKind = "vitrine"): string | null {
  const base = (erpWebUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(base)) return null;
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(s)) return null;
  return `${base}/loja/${s}${kind === "avaliar" ? "/avaliar" : ""}`;
}

/** Endereço das telas do ERP: o do "Testar" da integração ou o da avaliação de usados. */
export async function erpWebUrlFor(tenantId: number): Promise<string | null> {
  const [row] = await db.select({ erpWebUrl: tenantErpIntegrationsTable.erpWebUrl }).from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  const url = row?.erpWebUrl ?? (await appSetting(tenantId, TRADE_IN_ERP_URL_KEY));
  return url && /^https?:\/\//i.test(url) ? url.replace(/\/+$/, "") : null;
}

export async function vitrineRedirectStatus(tenantId: number) {
  const [enabled, erpWebUrl] = await Promise.all([
    appSetting(tenantId, VITRINE_REDIRECT_KEY).then((v) => v === "true"),
    erpWebUrlFor(tenantId),
  ]);
  return { enabled, erpWebUrl };
}

export async function setVitrineRedirect(tenantId: number, enabled: boolean): Promise<void> {
  await saveAppSetting(tenantId, VITRINE_REDIRECT_KEY, enabled ? "true" : "false");
}

/** Para onde a página pública deve ir (só com a opção ligada e o ERP conhecido). */
export async function vitrineRedirectFor(tenantId: number, slug: string, kind: VitrinePublicKind = "vitrine"): Promise<string | null> {
  const { enabled, erpWebUrl } = await vitrineRedirectStatus(tenantId);
  return enabled ? buildErpLojaUrl(erpWebUrl, slug, kind) : null;
}

/** Mesma coisa a partir do slug público (rota do nginx, sem login). */
export async function vitrineRedirectBySlug(slug: string, kind: VitrinePublicKind): Promise<string | null> {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(s)) return null;
  const [tenant] = await db.select({ id: tenantsTable.id, isActive: tenantsTable.isActive }).from(tenantsTable)
    .where(eq(tenantsTable.catalogSlug, s)).limit(1);
  if (!tenant || !tenant.isActive) return null;
  return vitrineRedirectFor(tenant.id, s, kind);
}
