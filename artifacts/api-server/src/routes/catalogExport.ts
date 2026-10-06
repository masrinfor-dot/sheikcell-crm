// Exportação da Vitrine para o ERP (sheik-company-erp) — pedido 04/10/2026:
// a Vitrine inteira passa a viver no ERP, com toda a base já existente.
// GET /api/catalog/export (admin, módulo vitrine) devolve UM JSON (versão 1)
// com tudo que o ERP importa em POST /storefront/import/crm: configurações,
// categorias, produtos (variantes, fotos, avaliações, avise-me), cupons,
// tabela de valores base e leads públicos da avaliação de usados.
//
// Fotos NÃO vão embutidas (o arquivo ficaria gigante): vai a URL pública de
// cada uma (/catalog-public/photos/:id/file) e o ERP baixa. Ids do CRM vão
// junto pra importação ser idempotente lá (crmId).
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  catalogCategoriesTable,
  catalogCouponsTable,
  catalogProductPhotosTable,
  catalogProductReviewsTable,
  catalogProductVariantsTable,
  catalogProductsTable,
  catalogStockNotificationsTable,
  tenantsTable,
  tradeInBaseValuesTable,
  tradeInEvaluationsTable,
} from "@workspace/db";
import { requireAdmin, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { getMargins, getQuestionsConfig } from "../lib/tradeInConfig";
import { getEvalLimitConfig } from "../lib/tradeInEvalLimit";
import { PAYMENT_METHODS_KEY as TRADE_IN_PAYMENT_METHODS_KEY, DEFAULT_PAYMENT_METHODS, sanitizePaymentMethods } from "../lib/tradeInPaymentMethods";
import { sanitizePricingSettings } from "../lib/catalogPricing";

const router: IRouter = Router();

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function setting(tenantId: number, key: string): Promise<string | null> {
  const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, key))).limit(1);
  return row?.value ?? null;
}

async function settingJson<T>(tenantId: number, key: string, fallback: T): Promise<T> {
  const raw = await setting(tenantId, key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}/api`;
}

router.get("/catalog/export", requireModuleAccess("vitrine"), requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (!tenant) { res.status(404).json({ error: "Loja não encontrada" }); return; }

  const base = publicBaseUrl(req);
  const photoUrl = (id: number) => `${base}/catalog-public/photos/${id}/file`;

  const [
    pricingRaw, trustBadges, paymentMethods, bannerImage, logoDataUrl,
    margins, questions, tradeInPaymentRaw, evalLimit,
    categories, products, variants, photos, reviews, notifications, coupons, baseValues, leads,
  ] = await Promise.all([
    settingJson<unknown>(tenantId, "catalog_pricing_settings", {}),
    settingJson<unknown[]>(tenantId, "catalog_trust_badges", []),
    settingJson<unknown[]>(tenantId, "catalog_payment_methods", []),
    setting(tenantId, "catalog_banner_image"),
    setting(tenantId, "branding_logo"),
    getMargins(tenantId),
    getQuestionsConfig(tenantId),
    setting(tenantId, TRADE_IN_PAYMENT_METHODS_KEY),
    getEvalLimitConfig(tenantId),
    db.select().from(catalogCategoriesTable).where(eq(catalogCategoriesTable.tenantId, tenantId)).orderBy(asc(catalogCategoriesTable.sortOrder), asc(catalogCategoriesTable.id)),
    db.select().from(catalogProductsTable).where(eq(catalogProductsTable.tenantId, tenantId)).orderBy(asc(catalogProductsTable.sortOrder), asc(catalogProductsTable.id)),
    db.select().from(catalogProductVariantsTable).where(eq(catalogProductVariantsTable.tenantId, tenantId)).orderBy(asc(catalogProductVariantsTable.sortOrder), asc(catalogProductVariantsTable.id)),
    db.select().from(catalogProductPhotosTable).where(eq(catalogProductPhotosTable.tenantId, tenantId)).orderBy(asc(catalogProductPhotosTable.sortOrder), asc(catalogProductPhotosTable.id)),
    db.select().from(catalogProductReviewsTable).where(eq(catalogProductReviewsTable.tenantId, tenantId)),
    db.select().from(catalogStockNotificationsTable).where(eq(catalogStockNotificationsTable.tenantId, tenantId)),
    db.select().from(catalogCouponsTable).where(eq(catalogCouponsTable.tenantId, tenantId)),
    db.select().from(tradeInBaseValuesTable).where(eq(tradeInBaseValuesTable.tenantId, tenantId)),
    db.select().from(tradeInEvaluationsTable).where(and(eq(tradeInEvaluationsTable.tenantId, tenantId), eq(tradeInEvaluationsTable.source, "public_lead"))),
  ]);

  let tradeInPaymentMethods: string[] = DEFAULT_PAYMENT_METHODS;
  if (tradeInPaymentRaw) {
    try { tradeInPaymentMethods = sanitizePaymentMethods(JSON.parse(tradeInPaymentRaw)).methods ?? DEFAULT_PAYMENT_METHODS; } catch { /* padrão */ }
  }

  const byProduct = <T extends { productId: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) m.set(r.productId, [...(m.get(r.productId) ?? []), r]);
    return m;
  };
  const variantsBy = byProduct(variants);
  const photosBy = byProduct(photos);
  const reviewsBy = byProduct(reviews);
  const notifsBy = byProduct(notifications);

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: "sheikcell-crm",
    tenant: { id: tenant.id, name: tenant.name },
    settings: {
      slug: tenant.catalogSlug,
      whatsapp: tenant.catalogWhatsapp ?? tenant.contactPhone ?? null,
      whatsappWholesale: tenant.catalogWhatsappWholesale,
      wholesaleCode: tenant.catalogWholesaleCode,
      publicTradeInEnabled: tenant.publicTradeInEnabled,
      publicTradeInAiLimit: tenant.publicTradeInAiLimit,
      publicTradeInMarginPct: tenant.publicTradeInMarginPct,
      pricing: sanitizePricingSettings(pricingRaw),
      trustBadges,
      paymentMethods,
      bannerImage: bannerImage || null,
      logoDataUrl: logoDataUrl || null,
      tradeInMargins: margins,
      tradeInQuestions: questions,
      tradeInPaymentMethods,
      tradeInEvalLimit: evalLimit,
    },
    categories: categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder })),
    products: products.map((p) => ({
      id: p.id,
      model: p.model,
      condition: p.condition,
      colors: p.colors,
      description: p.description,
      status: p.status,
      categoryId: p.categoryId,
      featured: p.featured,
      purchaseCount: p.purchaseCount,
      aiSpecs: p.aiSpecs ?? null,
      aiCharacteristics: p.aiCharacteristics ?? null,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      variants: (variantsBy.get(p.id) ?? []).map((v) => ({
        id: v.id,
        storage: v.storage,
        ram: v.ram,
        network: v.network,
        color: v.color,
        costPrice: num(v.costPrice),
        costIncludesInvoice: v.costIncludesInvoice,
        marginPercentOverride: num(v.marginPercentOverride),
        salePrice: num(v.salePrice),
        wholesalePrice: num(v.wholesalePrice),
        wholesaleMarginPercentOverride: num(v.wholesaleMarginPercentOverride),
        compareAtPrice: num(v.compareAtPrice),
        stockQty: v.stockQty,
        sortOrder: v.sortOrder,
      })),
      photos: (photosBy.get(p.id) ?? []).map((ph) => ({
        id: ph.id,
        url: photoUrl(ph.id),
        sourceUrl: ph.sourceUrl,
        isBoxPhoto: ph.isBoxPhoto,
        color: ph.color,
        sortOrder: ph.sortOrder,
      })),
      reviews: (reviewsBy.get(p.id) ?? []).map((r) => ({
        id: r.id,
        rating: r.rating,
        name: r.customerName,
        phone: r.customerPhone,
        city: r.customerCity,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
      stockNotifications: (notifsBy.get(p.id) ?? []).map((n) => ({
        id: n.id,
        variantId: n.variantId,
        customerName: n.customerName,
        contact: n.customerContact,
        notified: n.notified,
        createdAt: n.createdAt,
      })),
    })),
    coupons: coupons.map((c) => ({
      id: c.id,
      code: c.code,
      discountType: c.discountType,
      discountValue: num(c.discountValue),
      vendorName: c.vendorName,
      usageLimit: c.usageLimit,
      usedCount: c.usedCount,
      expiresAt: c.expiresAt,
      active: c.active,
    })),
    tradeInBaseValues: baseValues.map((b) => ({ id: b.id, brand: b.brand, model: b.model, storage: b.storage, baseValue: num(b.baseValue) })),
    tradeInLeads: leads.map((l) => ({
      id: l.id,
      source: "public",
      name: l.customerName ?? l.sellerCustomerName,
      phone: l.sellerPhone,
      brand: l.brand,
      model: l.model ?? l.device,
      memory: l.memory,
      color: l.color,
      answers: l.answers,
      estimatedPrice: l.suggestedPrice,
      wantedProduct: l.wantedProduct,
      status: l.closedAt ? "fechado" : "novo",
      createdAt: l.createdAt,
    })),
  };

  const filename = `vitrine-${(tenant.catalogSlug || "loja").replace(/[^a-z0-9-]/gi, "")}-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.json(payload);
});

export default router;
