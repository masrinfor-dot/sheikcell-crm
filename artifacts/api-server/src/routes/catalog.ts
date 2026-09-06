import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import {
  db,
  catalogProductsTable,
  catalogProductVariantsTable,
  catalogProductPhotosTable,
  catalogCategoriesTable,
  catalogStockNotificationsTable,
  catalogProductReviewsTable,
  appSettingsTable,
  tenantsTable,
  type CatalogCategory,
} from "@workspace/db";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { requirePerm } from "../lib/permissions";
import { logger } from "../lib/logger";
import {
  sanitizePricingSettings,
  precoVendaDoProduto,
  precoAtacadoDoProduto,
  precoAVistaDoProduto,
  parcelamento12xDoProduto,
  parcelamento12xAtacadoDoProduto,
  type PricingSettings,
} from "../lib/catalogPricing";
import { CATALOG_CONDITIONS, CATALOG_CONDITION_CRITERIA, type CatalogCondition } from "@workspace/db";

const router: IRouter = Router();
router.use("/catalog", requireModuleAccess("vitrine"));

// Fotos dos aparelhos ficam separadas das mídias do WhatsApp e dos documentos.
// Mesmo motivo do MEDIA_DIR/DOCS_DIR (ver diagnóstico em
// artifacts/api-server/src/lib/whatsappInbound.ts e routes/documents.ts): em
// produção (EasyPanel/Docker) defina CATALOG_MEDIA_DIR com o caminho absoluto
// do volume persistente montado no serviço "api" (ex.: /app/storage/catalog).
// Sem essa env var o caminho vem de process.cwd(), que difere entre dev e
// produção — e some a cada redeploy.
export const CATALOG_MEDIA_DIR = process.env["CATALOG_MEDIA_DIR"]
  ? path.resolve(process.env["CATALOG_MEDIA_DIR"])
  : path.resolve(process.cwd(), "catalog-media");

const PHOTO_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_PHOTO_SIZE = 8 * 1024 * 1024; // 8MB

function photoContentMatchesMime(buf: Buffer, mime: string): boolean {
  const startsWith = (sig: number[]) => sig.every((b, i) => buf[i] === b);
  switch (mime) {
    case "image/jpeg": return startsWith([0xff, 0xd8, 0xff]);
    case "image/png": return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/webp": return startsWith([0x52, 0x49, 0x46, 0x46]) && buf.length > 11 && buf.toString("ascii", 8, 12) === "WEBP";
    default: return false;
  }
}

// Detecta o mime a partir dos magic bytes (pra fotos baixadas de URL, onde o
// Content-Type do servidor de origem nem sempre é confiável).
function sniffImageMime(buf: Buffer): string | null {
  for (const mime of Object.keys(PHOTO_MIME)) {
    if (photoContentMatchesMime(buf, mime)) return mime;
  }
  return null;
}

const PRICING_KEY = "catalog_pricing_settings";

async function getPricingSettings(tenantId: number): Promise<PricingSettings> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, PRICING_KEY))).limit(1);
  if (!row) return sanitizePricingSettings(null);
  try {
    return sanitizePricingSettings(JSON.parse(row.value));
  } catch {
    return sanitizePricingSettings(null);
  }
}

// Sanitiza texto livre de campos do produto (modelo, armazenamento, descrição).
const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.normalize("NFC").trim().slice(0, max) : "";

function cleanColors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is string => typeof c === "string").map((c) => c.trim().slice(0, 40)).filter(Boolean).slice(0, 12);
}

function cleanCondition(v: unknown): CatalogCondition {
  return CATALOG_CONDITIONS.includes(v as CatalogCondition) ? (v as CatalogCondition) : "bom";
}

// Lista de características (specs) do produto — gerada por IA ou editada à
// mão pelo lojista (ver rota /catalog/characteristics/generate abaixo).
function cleanCharacteristics(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const list = v.filter((c): c is string => typeof c === "string").map((c) => c.normalize("NFC").trim().slice(0, 150)).filter(Boolean).slice(0, 12);
  return list.length > 0 ? list : null;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Acrescenta o preço à vista e o valor da parcela em 12x a uma variante, a
// partir do custo/margem gravados — em vez de guardar mais 2 preços fixos no
// banco, calcula na hora de exibir (mesma fórmula usada em todo o resto do
// preço, sempre em sincronia se a margem/tabela de cartão mudar depois).
function withInstallmentPricing<
  T extends { costPrice: string | number | null; costIncludesInvoice: boolean; marginPercentOverride: string | number | null },
>(v: T, settings: PricingSettings): { priceCash: number | null; installment12Value: number | null } {
  const produto = {
    costPrice: toNumberOrNull(v.costPrice),
    costIncludesInvoice: v.costIncludesInvoice,
    marginPercentOverride: toNumberOrNull(v.marginPercentOverride),
  };
  const installment = parcelamento12xDoProduto(produto, settings);
  return {
    priceCash: precoAVistaDoProduto(produto, settings),
    installment12Value: installment?.parcela ?? null,
  };
}

// Mesma ideia acima, só que pro preço de atacado: o preço de atacado
// (wholesalePrice) já É o valor à vista (sem taxa de cartão, ver
// precoAtacadoDoProduto) — calcula também na hora (wholesalePriceCash),
// igual o priceCash do varejo, em vez de confiar só no valor gravado no
// banco em resolveVariantWholesalePrice (que fica desatualizado se a
// margem de atacado padrão mudar depois — o preço de venda já não tinha
// esse problema, o de atacado tinha). Só cai no valor gravado quando não dá
// pra calcular (produto sem custo cadastrado = preço de atacado digitado
// manualmente pelo lojista, sem fórmula).
function withWholesaleInstallmentPricing<
  T extends { costPrice: string | number | null; costIncludesInvoice: boolean; wholesaleMarginPercentOverride: string | number | null },
>(v: T, settings: PricingSettings): { wholesaleInstallment12Value: number | null; wholesalePriceCash: number | null } {
  const produto = {
    costPrice: toNumberOrNull(v.costPrice),
    costIncludesInvoice: v.costIncludesInvoice,
    wholesaleMarginPercentOverride: toNumberOrNull(v.wholesaleMarginPercentOverride),
  };
  const installment = parcelamento12xAtacadoDoProduto(produto, settings);
  return {
    wholesaleInstallment12Value: installment?.parcela ?? null,
    wholesalePriceCash: precoAtacadoDoProduto(produto, settings),
  };
}

type CatalogPhotoRow = { id: number; storedName: string; sortOrder: number; isBoxPhoto: boolean; sourceUrl: string | null; color: string | null };

async function photosByProductIds(tenantId: number, productIds: number[]) {
  if (productIds.length === 0) return new Map<number, CatalogPhotoRow[]>();
  const rows = await db.select().from(catalogProductPhotosTable)
    .where(and(eq(catalogProductPhotosTable.tenantId, tenantId), inArray(catalogProductPhotosTable.productId, productIds)))
    .orderBy(catalogProductPhotosTable.sortOrder);
  const map = new Map<number, CatalogPhotoRow[]>();
  for (const p of rows) {
    const list = map.get(p.productId) ?? [];
    list.push({ id: p.id, storedName: p.storedName, sortOrder: p.sortOrder, isBoxPhoto: p.isBoxPhoto, sourceUrl: p.sourceUrl, color: p.color });
    map.set(p.productId, list);
  }
  return map;
}

// Ordena/filtra as fotos de um produto pra exibição na vitrine PÚBLICA: pra
// aparelho "novo", a foto da caixa (lacrada) vem primeiro, seguida das fotos
// do aparelho em si — pra qualquer outra condição (seminovo/outlet etc.) as
// fotos marcadas como "da caixa" nem aparecem, só interessa o aparelho de
// fato. Preserva a ordem relativa (sortOrder) dentro de cada grupo. No
// admin (Vitrine Aparelhos) o lojista continua vendo/editando TODAS as
// fotos, com essa marcação — só a vitrine pública aplica essa regra. Cada
// foto sai com a cor que ela representa (ou null = geral) pra o front
// filtrar pelo seletor de cor, sem precisar de outra chamada.
function publicPhotoIds(list: { id: number; sortOrder: number; isBoxPhoto: boolean; color: string | null }[], condition: string): { id: number; color: string | null }[] {
  const ordered = condition === "novo"
    ? [...list.filter((p) => p.isBoxPhoto), ...list.filter((p) => !p.isBoxPhoto)]
    : list.filter((p) => !p.isBoxPhoto);
  return ordered.map((p) => ({ id: p.id, color: p.color }));
}

async function variantsByProductIds(tenantId: number, productIds: number[]) {
  if (productIds.length === 0) return new Map<number, (typeof catalogProductVariantsTable.$inferSelect)[]>();
  const rows = await db.select().from(catalogProductVariantsTable)
    .where(and(eq(catalogProductVariantsTable.tenantId, tenantId), inArray(catalogProductVariantsTable.productId, productIds)))
    .orderBy(catalogProductVariantsTable.sortOrder, catalogProductVariantsTable.id);
  const map = new Map<number, (typeof catalogProductVariantsTable.$inferSelect)[]>();
  for (const v of rows) {
    const list = map.get(v.productId) ?? [];
    list.push(v);
    map.set(v.productId, list);
  }
  return map;
}

// Normaliza um item de variante vindo do cliente (form de cadastro/edição ou
// confirmação de importação) — calcula salePrice se não vier informado.
type VariantInput = {
  id?: number;
  storage: string | null;
  color: string | null;
  costPrice: number | null;
  costIncludesInvoice: boolean;
  marginPercentOverride: number | null;
  salePrice: number | null;
  wholesalePrice: number | null;
  wholesaleMarginPercentOverride: number | null;
  // Preço "de" (comparação), digitado à mão — ver comentário no schema
  // (catalogProductVariantsTable.compareAtPrice) e na rota pública abaixo.
  compareAtPrice: number | null;
  stockQty: number;
};

function cleanVariantInput(raw: unknown): VariantInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: Number.isInteger(o.id) ? (o.id as number) : undefined,
    storage: clean(o.storage, 40) || null,
    color: clean(o.color, 40) || null,
    costPrice: toNumberOrNull(o.costPrice),
    costIncludesInvoice: o.costIncludesInvoice === true,
    marginPercentOverride: toNumberOrNull(o.marginPercentOverride),
    salePrice: "salePrice" in o ? toNumberOrNull(o.salePrice) : null,
    wholesalePrice: "wholesalePrice" in o ? toNumberOrNull(o.wholesalePrice) : null,
    wholesaleMarginPercentOverride: toNumberOrNull(o.wholesaleMarginPercentOverride),
    compareAtPrice: toNumberOrNull(o.compareAtPrice),
    stockQty: Number.isInteger(o.stockQty) ? Math.max(0, o.stockQty as number) : 1,
  };
}

async function resolveVariantSalePrice(v: VariantInput, settings: PricingSettings): Promise<string | null> {
  if (v.salePrice != null) return String(v.salePrice);
  if (v.costPrice == null) return null;
  const computed = precoVendaDoProduto(
    { costPrice: v.costPrice, costIncludesInvoice: v.costIncludesInvoice, marginPercentOverride: v.marginPercentOverride },
    settings,
  );
  return computed != null ? String(computed) : null;
}

// Preço de atacado: se o lojista digitou um valor exato, usa ele; senão
// calcula automaticamente a partir do custo (ver precoAtacadoDoProduto) —
// mesmo comportamento de "em branco = calcula do custo" do preço de venda.
async function resolveVariantWholesalePrice(v: VariantInput, settings: PricingSettings): Promise<string | null> {
  if (v.wholesalePrice != null) return String(v.wholesalePrice);
  if (v.costPrice == null) return null;
  const computed = precoAtacadoDoProduto(
    { costPrice: v.costPrice, costIncludesInvoice: v.costIncludesInvoice, wholesaleMarginPercentOverride: v.wholesaleMarginPercentOverride },
    settings,
  );
  return computed != null ? String(computed) : null;
}

/** Substitui as variantes de um produto (upsert por id + remove as que sumiram). Sempre garante ao menos 1 variante. */
async function replaceVariants(tenantId: number, productId: number, rawVariants: unknown, settings: PricingSettings) {
  const list = Array.isArray(rawVariants) && rawVariants.length > 0 ? rawVariants : [{}];
  const inputs = list.slice(0, 20).map(cleanVariantInput);

  const existing = await db.select({ id: catalogProductVariantsTable.id }).from(catalogProductVariantsTable)
    .where(and(eq(catalogProductVariantsTable.productId, productId), eq(catalogProductVariantsTable.tenantId, tenantId)));
  const existingIds = new Set(existing.map((r) => r.id));
  const keepIds = new Set<number>();

  for (const [i, v] of inputs.entries()) {
    const salePrice = await resolveVariantSalePrice(v, settings);
    const wholesalePrice = await resolveVariantWholesalePrice(v, settings);
    const values = {
      storage: v.storage,
      color: v.color,
      costPrice: v.costPrice != null ? String(v.costPrice) : null,
      costIncludesInvoice: v.costIncludesInvoice,
      marginPercentOverride: v.marginPercentOverride != null ? String(v.marginPercentOverride) : null,
      salePrice,
      wholesalePrice,
      wholesaleMarginPercentOverride: v.wholesaleMarginPercentOverride != null ? String(v.wholesaleMarginPercentOverride) : null,
      compareAtPrice: v.compareAtPrice != null ? String(v.compareAtPrice) : null,
      stockQty: v.stockQty,
      sortOrder: i,
      updatedAt: new Date(),
    };
    if (v.id != null && existingIds.has(v.id)) {
      await db.update(catalogProductVariantsTable).set(values)
        .where(and(eq(catalogProductVariantsTable.id, v.id), eq(catalogProductVariantsTable.tenantId, tenantId)));
      keepIds.add(v.id);
    } else {
      const [created] = await db.insert(catalogProductVariantsTable)
        .values({ tenantId, productId, ...values }).returning({ id: catalogProductVariantsTable.id });
      keepIds.add(created.id);
    }
  }
  const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    await db.delete(catalogProductVariantsTable)
      .where(and(inArray(catalogProductVariantsTable.id, toDelete), eq(catalogProductVariantsTable.tenantId, tenantId)));
  }
}

// ─── Categorias/abas personalizáveis ────────────────────────────────────────

async function cleanCategoryId(tenantId: number, v: unknown): Promise<number | null> {
  if (v === null || v === undefined || v === "") return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [row] = await db.select({ id: catalogCategoriesTable.id }).from(catalogCategoriesTable)
    .where(and(eq(catalogCategoriesTable.id, id), eq(catalogCategoriesTable.tenantId, tenantId))).limit(1);
  return row ? id : null;
}

router.get("/catalog/categories", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(catalogCategoriesTable)
    .where(eq(catalogCategoriesTable.tenantId, tenantId))
    .orderBy(catalogCategoriesTable.sortOrder, catalogCategoriesTable.id);
  res.json({ categories: rows });
});

router.post("/catalog/categories", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Record<string, unknown>;
  const name = clean(body.name, 60);
  if (!name) { res.status(400).json({ error: "Informe o nome da categoria" }); return; }
  const parentId = await cleanCategoryId(tenantId, body.parentId);
  const [category] = await db.insert(catalogCategoriesTable).values({ tenantId, name, parentId }).returning();
  res.status(201).json(category);
});

router.patch("/catalog/categories/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Categoria inválida" }); return; }
  const [existing] = await db.select().from(catalogCategoriesTable)
    .where(and(eq(catalogCategoriesTable.id, id), eq(catalogCategoriesTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Categoria não encontrada" }); return; }

  const body = req.body as Record<string, unknown>;
  const parentId = "parentId" in body ? await cleanCategoryId(tenantId, body.parentId) : existing.parentId;
  if (parentId === id) { res.status(400).json({ error: "Uma categoria não pode ser subcategoria dela mesma" }); return; }
  const [updated] = await db.update(catalogCategoriesTable).set({
    name: "name" in body ? (clean(body.name, 60) || existing.name) : existing.name,
    parentId,
    sortOrder: "sortOrder" in body && Number.isInteger(body.sortOrder) ? (body.sortOrder as number) : existing.sortOrder,
  }).where(and(eq(catalogCategoriesTable.id, id), eq(catalogCategoriesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.delete("/catalog/categories/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Categoria inválida" }); return; }
  await db.delete(catalogCategoriesTable).where(and(eq(catalogCategoriesTable.id, id), eq(catalogCategoriesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ─── Listar / criar / editar / excluir produtos ─────────────────────────────

router.get("/catalog/products", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(catalogProductsTable)
    .where(eq(catalogProductsTable.tenantId, tenantId))
    .orderBy(desc(catalogProductsTable.createdAt));
  const ids = rows.map((r) => r.id);
  const [photos, variants] = await Promise.all([photosByProductIds(tenantId, ids), variantsByProductIds(tenantId, ids)]);
  const settings = await getPricingSettings(tenantId);
  res.json({
    settings,
    products: rows.map((r) => ({
      ...r,
      photos: photos.get(r.id) ?? [],
      // priceCash/installment12Value calculados na hora (ver withInstallmentPricing)
      // pra mostrar "à vista" e "12x" no card/edição sem duplicar preço no banco.
      // Atacado (admin sempre vê, sem código de acesso) ganha o mesmo tratamento.
      variants: (variants.get(r.id) ?? []).map((v) => ({
        ...v, ...withInstallmentPricing(v, settings), ...withWholesaleInstallmentPricing(v, settings),
      })),
    })),
  });
});

router.post("/catalog/products", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Record<string, unknown>;
  const model = clean(body.model, 120);
  if (!model) { res.status(400).json({ error: "Informe o modelo do aparelho" }); return; }

  const [product] = await db.insert(catalogProductsTable).values({
    tenantId,
    model,
    condition: cleanCondition(body.condition),
    colors: cleanColors(body.colors),
    description: clean(body.description, 2000) || null,
    status: body.status === "inactive" || body.status === "sold" ? body.status : "active",
    categoryId: await cleanCategoryId(tenantId, body.categoryId),
    aiCharacteristics: cleanCharacteristics(body.aiCharacteristics),
    createdBy: req.session.userId ?? null,
  }).returning();

  const settings = await getPricingSettings(tenantId);
  await replaceVariants(tenantId, product.id, body.variants, settings);
  const variants = await variantsByProductIds(tenantId, [product.id]);
  res.status(201).json({
    ...product, photos: [],
    variants: (variants.get(product.id) ?? []).map((v) => ({
      ...v, ...withInstallmentPricing(v, settings), ...withWholesaleInstallmentPricing(v, settings),
    })),
  });
});

router.patch("/catalog/products/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Produto inválido" }); return; }
  const [existing] = await db.select().from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, id), eq(catalogProductsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  const body = req.body as Record<string, unknown>;
  const [updated] = await db.update(catalogProductsTable).set({
    model: "model" in body ? (clean(body.model, 120) || existing.model) : existing.model,
    condition: "condition" in body ? cleanCondition(body.condition) : existing.condition,
    colors: "colors" in body ? cleanColors(body.colors) : existing.colors,
    description: "description" in body ? (clean(body.description, 2000) || null) : existing.description,
    status: body.status === "active" || body.status === "inactive" || body.status === "sold" ? body.status : existing.status,
    categoryId: "categoryId" in body ? await cleanCategoryId(tenantId, body.categoryId) : existing.categoryId,
    sortOrder: "sortOrder" in body && Number.isInteger(body.sortOrder) ? (body.sortOrder as number) : existing.sortOrder,
    aiCharacteristics: "aiCharacteristics" in body ? cleanCharacteristics(body.aiCharacteristics) : existing.aiCharacteristics,
    updatedAt: new Date(),
  }).where(and(eq(catalogProductsTable.id, id), eq(catalogProductsTable.tenantId, tenantId))).returning();

  const settings = await getPricingSettings(tenantId);
  if ("variants" in body) {
    await replaceVariants(tenantId, id, body.variants, settings);
  }

  const [photos, variants] = await Promise.all([photosByProductIds(tenantId, [id]), variantsByProductIds(tenantId, [id])]);
  res.json({
    ...updated, photos: photos.get(id) ?? [],
    variants: (variants.get(id) ?? []).map((v) => ({
      ...v, ...withInstallmentPricing(v, settings), ...withWholesaleInstallmentPricing(v, settings),
    })),
  });
});

router.delete("/catalog/products/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Produto inválido" }); return; }
  const [existing] = await db.select().from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, id), eq(catalogProductsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  const photoRows = await db.select().from(catalogProductPhotosTable)
    .where(and(eq(catalogProductPhotosTable.productId, id), eq(catalogProductPhotosTable.tenantId, tenantId)));
  await db.delete(catalogProductsTable).where(and(eq(catalogProductsTable.id, id), eq(catalogProductsTable.tenantId, tenantId)));
  for (const p of photoRows) {
    const filepath = path.join(CATALOG_MEDIA_DIR, path.basename(p.storedName));
    if (existsSync(filepath)) await unlink(filepath).catch(() => {});
  }
  res.json({ ok: true });
});

// Exclusão em massa — seleção manual de vários cards de uma vez (o front
// filtra por categoria/status/busca antes de selecionar, aqui só recebe a
// lista final de ids). Mesmo nível de permissão do DELETE individual acima.
router.post("/catalog/products/bulk-delete", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawIds = (req.body as { ids?: unknown }).ids;
  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500)
    : [];
  if (ids.length === 0) { res.status(400).json({ error: "Nenhum produto selecionado" }); return; }

  const owned = await db.select({ id: catalogProductsTable.id }).from(catalogProductsTable)
    .where(and(inArray(catalogProductsTable.id, ids), eq(catalogProductsTable.tenantId, tenantId)));
  const ownedIds = owned.map((r) => r.id);
  if (ownedIds.length === 0) { res.status(404).json({ error: "Nenhum produto encontrado" }); return; }

  const photoRows = await db.select().from(catalogProductPhotosTable)
    .where(and(inArray(catalogProductPhotosTable.productId, ownedIds), eq(catalogProductPhotosTable.tenantId, tenantId)));
  await db.delete(catalogProductsTable).where(and(inArray(catalogProductsTable.id, ownedIds), eq(catalogProductsTable.tenantId, tenantId)));
  for (const p of photoRows) {
    const filepath = path.join(CATALOG_MEDIA_DIR, path.basename(p.storedName));
    if (existsSync(filepath)) await unlink(filepath).catch(() => {});
  }
  res.json({ ok: true, deleted: ownedIds.length });
});

// ─── Fotos ───────────────────────────────────────────────────────────────────

router.post("/catalog/products/:id/photos", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const productId = Number(req.params.id);
  const [existing] = await db.select({ id: catalogProductsTable.id }).from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, productId), eq(catalogProductsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  const { mimeType, data, color } = req.body as { mimeType?: string; data?: string; color?: unknown };
  const mime = typeof mimeType === "string" ? mimeType.split(";")[0].trim() : "";
  const ext = PHOTO_MIME[mime];
  if (!ext) { res.status(400).json({ error: "Formato não permitido. Use JPEG, PNG ou WEBP." }); return; }
  if (typeof data !== "string" || !data) { res.status(400).json({ error: "Imagem vazia" }); return; }

  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) { res.status(400).json({ error: "Imagem vazia" }); return; }
  if (!photoContentMatchesMime(buf, mime)) { res.status(400).json({ error: "O conteúdo do arquivo não corresponde ao tipo informado" }); return; }
  if (buf.length > MAX_PHOTO_SIZE) { res.status(400).json({ error: "Imagem muito grande (máximo 8MB)" }); return; }

  await mkdir(CATALOG_MEDIA_DIR, { recursive: true });
  const storedName = `${randomUUID()}.${ext}`;
  await writeFile(path.join(CATALOG_MEDIA_DIR, storedName), buf);

  const [count] = await db.select({ id: catalogProductPhotosTable.id }).from(catalogProductPhotosTable)
    .where(eq(catalogProductPhotosTable.productId, productId));
  const [photo] = await db.insert(catalogProductPhotosTable).values({
    tenantId, productId, storedName, sortOrder: count ? 1 : 0, color: clean(color, 40) || null,
  }).returning();
  res.status(201).json(photo);
});

// Busca de imagens padronizadas na internet. Suporta quatro provedores,
// nessa ordem de preferência (tenta cada um configurado até achar foto):
//   1. Serper.dev (SERPER_API_KEY) — conta grátis, sem cartão/faturamento.
//   2. SearchAPI.io (SEARCHAPI_API_KEY) — conta grátis (100 buscas/mês),
//      login com Google, sem cartão. Cota mensal esgota rápido.
//   3. SerpApi (SERPAPI_API_KEY, serpapi.com — cuidado, é diferente do
//      SearchAPI.io acima apesar do nome parecido) — conta grátis (250
//      buscas/mês), sem cartão, chave liberada na hora (sem revisão manual).
//   4. Google Custom Search (GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX) — API
//      fechada para novos clientes desde 2024, mantido só por compat; a
//      conta usada aqui está presa numa retenção de revisão do Google.
// Sem nenhum dos quatro configurados, devolve 501 com uma mensagem clara em
// vez de quebrar a tela — a loja pode seguir cadastrando fotos por upload manual.
type ImageSearchResult = { title: string; imageUrl: string; thumbnailUrl: string; sourceUrl: string };

function photoSearchConfigured(): boolean {
  return !!process.env["SERPER_API_KEY"] || !!process.env["SEARCHAPI_API_KEY"]
    || !!process.env["SERPAPI_API_KEY"]
    || !!(process.env["GOOGLE_CSE_API_KEY"] && process.env["GOOGLE_CSE_CX"]);
}

async function searchImagesSerper(query: string, num: number): Promise<ImageSearchResult[]> {
  const apiKey = process.env["SERPER_API_KEY"];
  if (!apiKey) return [];
  const r = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num, safe: "active" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    logger.warn({ status: r.status, body: body.slice(0, 300), query }, "Catalog photo search: Serper respondeu erro");
    return [];
  }
  const json = (await r.json()) as {
    images?: { title?: string; imageUrl?: string; thumbnailUrl?: string; link?: string }[];
  };
  return (json.images ?? []).slice(0, num).map((it) => ({
    title: clean(it.title, 150),
    imageUrl: typeof it.imageUrl === "string" ? it.imageUrl : "",
    thumbnailUrl: typeof it.thumbnailUrl === "string" ? it.thumbnailUrl : (typeof it.imageUrl === "string" ? it.imageUrl : ""),
    sourceUrl: typeof it.link === "string" ? it.link : "",
  })).filter((r) => r.imageUrl);
}

async function searchImagesSearchApiIo(query: string, num: number): Promise<ImageSearchResult[]> {
  const apiKey = process.env["SEARCHAPI_API_KEY"];
  if (!apiKey) return [];
  const url = new URL("https://www.searchapi.io/api/v1/search");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("safe", "active");
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    logger.warn({ status: r.status, body: body.slice(0, 300), query }, "Catalog photo search: SearchAPI.io respondeu erro");
    return [];
  }
  const json = (await r.json()) as {
    images?: { title?: string; original?: { link?: string }; thumbnail?: string; source?: { link?: string } }[];
  };
  return (json.images ?? []).slice(0, num).map((it) => ({
    title: clean(it.title, 150),
    imageUrl: typeof it.original?.link === "string" ? it.original.link : "",
    thumbnailUrl: typeof it.thumbnail === "string" ? it.thumbnail : (typeof it.original?.link === "string" ? it.original.link : ""),
    sourceUrl: typeof it.source?.link === "string" ? it.source.link : "",
  })).filter((r) => r.imageUrl);
}

async function searchImagesSerpApi(query: string, num: number): Promise<ImageSearchResult[]> {
  const apiKey = process.env["SERPAPI_API_KEY"];
  if (!apiKey) return [];
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("safe", "active");
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    logger.warn({ status: r.status, body: body.slice(0, 300), query }, "Catalog photo search: SerpApi respondeu erro");
    return [];
  }
  const json = (await r.json()) as {
    images_results?: { title?: string; original?: string; thumbnail?: string; link?: string }[];
  };
  return (json.images_results ?? []).slice(0, num).map((it) => ({
    title: clean(it.title, 150),
    imageUrl: typeof it.original === "string" ? it.original : "",
    thumbnailUrl: typeof it.thumbnail === "string" ? it.thumbnail : (typeof it.original === "string" ? it.original : ""),
    sourceUrl: typeof it.link === "string" ? it.link : "",
  })).filter((r) => r.imageUrl);
}

async function searchImagesGoogleCse(query: string, num: number): Promise<ImageSearchResult[]> {
  const apiKey = process.env["GOOGLE_CSE_API_KEY"];
  const cx = process.env["GOOGLE_CSE_CX"];
  if (!apiKey || !cx) return [];
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", String(num));
  url.searchParams.set("safe", "active");
  url.searchParams.set("imgSize", "large");
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    logger.warn({ status: r.status, body: body.slice(0, 300), query }, "Catalog photo search: Google CSE respondeu erro");
    return [];
  }
  const json = (await r.json()) as { items?: { title?: string; link?: string; image?: { thumbnailLink?: string; contextLink?: string } }[] };
  return (json.items ?? []).slice(0, num).map((it) => ({
    title: clean(it.title, 150),
    imageUrl: typeof it.link === "string" ? it.link : "",
    thumbnailUrl: typeof it.image?.thumbnailLink === "string" ? it.image.thumbnailLink : (typeof it.link === "string" ? it.link : ""),
    sourceUrl: typeof it.image?.contextLink === "string" ? it.image.contextLink : "",
  })).filter((r) => r.imageUrl);
}

// Tenta cada provedor configurado, na ordem de preferência, e só passa pro
// próximo se o anterior não trouxe nenhum resultado — seja porque não está
// configurado, seja porque a chamada falhou (ex.: cota mensal esgotada, como
// já aconteceu com o plano grátis do SearchAPI.io: 429 "used all of the
// searches for the month"). Antes, um provedor configurado mas fora do ar
// travava a busca inteira sem nem tentar o próximo da lista — mesmo com outro
// provedor configurado e talvez funcionando.
async function searchImages(query: string, num: number): Promise<ImageSearchResult[]> {
  if (process.env["SERPER_API_KEY"]) {
    const results = await searchImagesSerper(query, num);
    if (results.length > 0) return results;
  }
  if (process.env["SEARCHAPI_API_KEY"]) {
    const results = await searchImagesSearchApiIo(query, num);
    if (results.length > 0) return results;
  }
  if (process.env["SERPAPI_API_KEY"]) {
    const results = await searchImagesSerpApi(query, num);
    if (results.length > 0) return results;
  }
  return searchImagesGoogleCse(query, num);
}

router.get("/catalog/photo-search", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  void tenantId;
  if (!photoSearchConfigured()) {
    res.status(501).json({ error: "Busca de imagens não configurada neste servidor. Configure SERPER_API_KEY (serper.dev, grátis), SEARCHAPI_API_KEY (searchapi.io, grátis), SERPAPI_API_KEY (serpapi.com, grátis) ou GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX." });
    return;
  }
  const q = clean((req.query as Record<string, unknown>).q, 150);
  if (!q) { res.status(400).json({ error: "Informe o que buscar" }); return; }

  try {
    const results = await searchImages(q, 8);
    res.json({ results });
  } catch (err) {
    req.log.error({ err }, "Catalog photo search failed");
    res.status(503).json({ error: "A busca de imagens está indisponível no momento. Tente novamente em instantes." });
  }
});

// Baixa uma imagem de uma URL (resultado da busca acima) e anexa ao produto
// como se fosse um upload — mesma validação de conteúdo/tamanho.
router.post("/catalog/products/:id/photos/from-url", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const productId = Number(req.params.id);
  const [existing] = await db.select({ id: catalogProductsTable.id }).from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, productId), eq(catalogProductsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  const raw = (req.body as { url?: unknown }).url;
  const sourceUrl = typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
  const color = clean((req.body as { color?: unknown }).color, 40) || null;
  let parsed: URL;
  try { parsed = new URL(sourceUrl); } catch { res.status(400).json({ error: "URL inválida" }); return; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") { res.status(400).json({ error: "URL inválida" }); return; }

  try {
    const r = await fetch(parsed, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "SheikCellVitrineBot/1.0" } });
    if (!r.ok) { res.status(502).json({ error: "Não consegui baixar essa imagem." }); return; }
    const contentLength = Number(r.headers.get("content-length") ?? "0");
    if (contentLength > MAX_PHOTO_SIZE) { res.status(400).json({ error: "Imagem muito grande (máximo 8MB)" }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) { res.status(400).json({ error: "Imagem vazia" }); return; }
    if (buf.length > MAX_PHOTO_SIZE) { res.status(400).json({ error: "Imagem muito grande (máximo 8MB)" }); return; }
    const mime = sniffImageMime(buf);
    const ext = mime ? PHOTO_MIME[mime] : null;
    if (!ext) { res.status(400).json({ error: "O arquivo baixado não é uma imagem JPEG, PNG ou WEBP válida." }); return; }

    await mkdir(CATALOG_MEDIA_DIR, { recursive: true });
    const storedName = `${randomUUID()}.${ext}`;
    await writeFile(path.join(CATALOG_MEDIA_DIR, storedName), buf);

    const [count] = await db.select({ id: catalogProductPhotosTable.id }).from(catalogProductPhotosTable)
      .where(eq(catalogProductPhotosTable.productId, productId));
    const [photo] = await db.insert(catalogProductPhotosTable).values({
      tenantId, productId, storedName, sourceUrl: parsed.toString(), sortOrder: count ? 1 : 0, color,
    }).returning();
    res.status(201).json(photo);
  } catch (err) {
    req.log.error({ err }, "Catalog photo from-url failed");
    res.status(503).json({ error: "Não consegui baixar essa imagem agora. Tente novamente." });
  }
});

// Marca/desmarca uma foto como "da caixa" (embalagem lacrada) e/ou marca qual
// cor cadastrada do produto ela representa (color=null volta a ser foto
// "geral", mostrada em qualquer cor) — usada pra decidir a ordem/filtro de
// fotos na vitrine pública (ver publicPhotoIds). Aceita os dois campos juntos
// ou separados; pelo menos um precisa vir preenchido.
router.patch("/catalog/products/:id/photos/:photoId", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const productId = Number(req.params.id);
  const photoId = Number(req.params.photoId);
  const { isBoxPhoto, color } = req.body as { isBoxPhoto?: unknown; color?: unknown };
  const patch: Partial<typeof catalogProductPhotosTable.$inferInsert> = {};
  if (typeof isBoxPhoto === "boolean") patch.isBoxPhoto = isBoxPhoto;
  if ("color" in (req.body as object)) patch.color = clean(color, 40) || null;
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Informe isBoxPhoto e/ou color" }); return; }
  const [photo] = await db.update(catalogProductPhotosTable).set(patch)
    .where(and(eq(catalogProductPhotosTable.id, photoId), eq(catalogProductPhotosTable.productId, productId), eq(catalogProductPhotosTable.tenantId, tenantId)))
    .returning();
  if (!photo) { res.status(404).json({ error: "Foto não encontrada" }); return; }
  res.json(photo);
});

router.delete("/catalog/products/:id/photos/:photoId", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const productId = Number(req.params.id);
  const photoId = Number(req.params.photoId);
  const [photo] = await db.select().from(catalogProductPhotosTable)
    .where(and(eq(catalogProductPhotosTable.id, photoId), eq(catalogProductPhotosTable.productId, productId), eq(catalogProductPhotosTable.tenantId, tenantId))).limit(1);
  if (!photo) { res.status(404).json({ error: "Foto não encontrada" }); return; }
  await db.delete(catalogProductPhotosTable).where(eq(catalogProductPhotosTable.id, photoId));
  const filepath = path.join(CATALOG_MEDIA_DIR, path.basename(photo.storedName));
  if (existsSync(filepath)) await unlink(filepath).catch(() => {});
  res.json({ ok: true });
});

// ─── Configurações de precificação (margem, nota fiscal, taxas de cartão) ───

router.get("/catalog/pricing-settings", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getPricingSettings(tenantId));
});

router.put("/catalog/pricing-settings", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const settings = sanitizePricingSettings(req.body);
  await db.insert(appSettingsTable)
    .values({ tenantId, key: PRICING_KEY, value: JSON.stringify(settings) })
    .onConflictDoUpdate({ target: [appSettingsTable.tenantId, appSettingsTable.key], set: { value: JSON.stringify(settings), updatedAt: new Date() } });
  res.json(settings);
});

// Simulação de preço sem salvar — usada pela calculadora ao lado de cada
// variante no formulário do produto.
router.post("/catalog/pricing-settings/simulate", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const settings = await getPricingSettings(tenantId);
  const { costPrice, costIncludesInvoice, marginPercentOverride, wholesaleMarginPercentOverride } = req.body as {
    costPrice?: unknown; costIncludesInvoice?: unknown; marginPercentOverride?: unknown; wholesaleMarginPercentOverride?: unknown;
  };
  const custo = toNumberOrNull(costPrice);
  if (custo == null || custo <= 0) { res.status(400).json({ error: "Informe o custo do aparelho" }); return; }
  const salePrice = precoVendaDoProduto(
    { costPrice: custo, costIncludesInvoice: costIncludesInvoice === true, marginPercentOverride: toNumberOrNull(marginPercentOverride) },
    settings,
  );
  const wholesalePrice = precoAtacadoDoProduto(
    { costPrice: custo, costIncludesInvoice: costIncludesInvoice === true, wholesaleMarginPercentOverride: toNumberOrNull(wholesaleMarginPercentOverride) },
    settings,
  );
  const produtoVarejo = { costPrice: custo, costIncludesInvoice: costIncludesInvoice === true, marginPercentOverride: toNumberOrNull(marginPercentOverride) };
  const priceCash = precoAVistaDoProduto(produtoVarejo, settings);
  const installment12 = parcelamento12xDoProduto(produtoVarejo, settings);
  const produtoAtacado = { costPrice: custo, costIncludesInvoice: costIncludesInvoice === true, wholesaleMarginPercentOverride: toNumberOrNull(wholesaleMarginPercentOverride) };
  const wholesaleInstallment12 = parcelamento12xAtacadoDoProduto(produtoAtacado, settings);
  res.json({ salePrice, wholesalePrice, priceCash, installment12, wholesaleInstallment12, settings });
});

// Gera a lista de "Principais características" (armazenamento, RAM, tela,
// câmera, bateria etc.) a partir do modelo/condição/cores/variantes — sem
// salvar nada (o lojista revisa/edita no formulário e salva junto com o
// resto do produto, mesmo padrão de /catalog/pricing-settings/simulate).
// Funciona tanto num produto já cadastrado quanto ainda no formulário de
// criação (não depende de um id existente).
router.post("/catalog/characteristics/generate", requireAuth, requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Record<string, unknown>;
  const model = clean(body.model, 120);
  if (!model) { res.status(400).json({ error: "Informe o modelo do aparelho" }); return; }
  const condition = cleanCondition(body.condition);
  const colors = cleanColors(body.colors);
  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  const storages = [...new Set(rawVariants.map((v) => clean((v as { storage?: unknown })?.storage, 40)).filter(Boolean))];

  const prompt = [
    `Você é um especialista em celulares/smartphones do mercado brasileiro.`,
    `Gere uma lista curta de "principais características" pro anúncio de um aparelho, no estilo de ficha técnica resumida (tipo a "Ficha técnica gerada por IA" de marketplaces como Magazine Luiza).`,
    `Aparelho: ${model}.`,
    `Condição/selo de qualidade: ${CATALOG_CONDITION_CRITERIA[condition]?.label ?? condition}.`,
    colors.length > 0 ? `Cores disponíveis: ${colors.join(", ")}.` : null,
    storages.length > 0 ? `Armazenamento(s) disponível(is): ${storages.join(", ")}.` : null,
    ``,
    `Use seu conhecimento sobre esse modelo específico pra listar até 8 características reais dele (armazenamento, memória RAM, tamanho/tipo de tela, resolução da câmera traseira/frontal, capacidade da bateria, processador, se tem 5G, resistência à água, etc.) — só inclua o que você tiver confiança de estar correto pra esse modelo. Cada característica é uma frase curta (máx. 12 palavras), direta, sem markdown.`,
    `Se o aparelho não for "novo", pode incluir 1 característica sobre o estado de conservação usando o selo de qualidade informado acima.`,
    `Responda SOMENTE com um JSON array de strings, sem markdown, ex.: ["Tela Super Retina XDR 6,1\\"","128GB de armazenamento","Câmera dupla 12MP","Bateria de longa duração","5G"]`,
  ].filter(Boolean).join("\n");

  try {
    const { getOpenAiClientForTenant } = await import("../lib/aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create(
      { model: "gpt-4o", max_tokens: 500, messages: [{ role: "user", content: prompt }] },
      { timeout: 25_000 },
    );
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const text = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    let characteristics: string[] = [];
    if (start !== -1 && end !== -1) {
      try {
        const arr = JSON.parse(text.slice(start, end + 1));
        characteristics = cleanCharacteristics(arr) ?? [];
      } catch { /* segue com lista vazia — erro tratado abaixo */ }
    }
    if (characteristics.length === 0) { res.status(502).json({ error: "A IA não retornou uma lista válida. Tente novamente." }); return; }
    res.json({ characteristics });
  } catch (err) {
    req.log.error({ err }, "Catalog characteristics generation failed");
    const { OpenAI: OpenAISdk } = await import("openai");
    let message = "A IA está indisponível no momento. Tente novamente em instantes.";
    if (err instanceof OpenAISdk.APIConnectionTimeoutError || (err as { name?: string })?.name === "APIConnectionTimeoutError") {
      message = "A IA demorou demais pra gerar as características. Tente novamente.";
    } else if (err instanceof OpenAISdk.RateLimitError) {
      message = "A IA está sobrecarregada no momento (limite de uso atingido). Aguarde um instante e tente de novo.";
    } else if (err instanceof OpenAISdk.AuthenticationError) {
      message = "A chave de acesso à IA está inválida ou expirada. Fale com o administrador do sistema.";
    }
    res.status(503).json({ error: message });
  }
});

// ─── Selos de confiança/garantia customizados (vitrine pública) ─────────────
// Configuráveis pela loja (nome/descrição de cada selo) — mesmo padrão de
// appSettingsTable já usado pra configuração de preço (PRICING_KEY acima).
// Sem nenhum configurado ainda, usa um padrão pronto com a marca SheikCell.

type TrustBadge = { title: string; description: string };
const TRUST_BADGES_KEY = "catalog_trust_badges";
const DEFAULT_TRUST_BADGES: TrustBadge[] = [
  { title: "Qualidade Premium Dubai", description: "Aparelhos selecionados com padrão internacional de qualidade" },
  { title: "Garantia Sheik Cell", description: "Garantia direto com a loja em cada aparelho" },
  { title: "Testado e Aprovado", description: "Conferido em bateria, tela e funcionamento antes de sair da loja" },
];

function sanitizeTrustBadges(raw: unknown): TrustBadge[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    return { title: clean(o.title, 60), description: clean(o.description, 140) };
  }).filter((b) => b.title);
}

async function getTrustBadges(tenantId: number): Promise<TrustBadge[]> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, TRUST_BADGES_KEY))).limit(1);
  if (!row) return DEFAULT_TRUST_BADGES;
  try {
    const parsed = sanitizeTrustBadges(JSON.parse(row.value));
    return parsed.length > 0 ? parsed : DEFAULT_TRUST_BADGES;
  } catch {
    return DEFAULT_TRUST_BADGES;
  }
}

router.get("/catalog/trust-badges", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json({ badges: await getTrustBadges(tenantId) });
});

router.put("/catalog/trust-badges", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const badges = sanitizeTrustBadges((req.body as { badges?: unknown }).badges);
  await db.insert(appSettingsTable)
    .values({ tenantId, key: TRUST_BADGES_KEY, value: JSON.stringify(badges) })
    .onConflictDoUpdate({ target: [appSettingsTable.tenantId, appSettingsTable.key], set: { value: JSON.stringify(badges), updatedAt: new Date() } });
  res.json({ badges: badges.length > 0 ? badges : DEFAULT_TRUST_BADGES });
});

// ─── "Avise-me quando chegar" — pedidos de aviso de reposição de estoque ────

router.get("/catalog/stock-notifications", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(catalogStockNotificationsTable)
    .where(eq(catalogStockNotificationsTable.tenantId, tenantId))
    .orderBy(desc(catalogStockNotificationsTable.createdAt)).limit(300);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const products = productIds.length > 0
    ? await db.select({ id: catalogProductsTable.id, model: catalogProductsTable.model }).from(catalogProductsTable)
        .where(and(inArray(catalogProductsTable.id, productIds), eq(catalogProductsTable.tenantId, tenantId)))
    : [];
  const productById = new Map(products.map((p) => [p.id, p.model]));
  const variantIds = [...new Set(rows.map((r) => r.variantId).filter((v): v is number => v != null))];
  const variants = variantIds.length > 0
    ? await db.select({ id: catalogProductVariantsTable.id, storage: catalogProductVariantsTable.storage, color: catalogProductVariantsTable.color })
        .from(catalogProductVariantsTable).where(inArray(catalogProductVariantsTable.id, variantIds))
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));
  res.json({
    notifications: rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      model: productById.get(r.productId) ?? "(produto removido)",
      variant: r.variantId != null ? variantById.get(r.variantId) ?? null : null,
      customerName: r.customerName,
      customerContact: r.customerContact,
      notified: r.notified,
      createdAt: r.createdAt,
    })),
  });
});

router.patch("/catalog/stock-notifications/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  const notified = (req.body as { notified?: unknown }).notified === true;
  const [row] = await db.update(catalogStockNotificationsTable).set({ notified })
    .where(and(eq(catalogStockNotificationsTable.id, id), eq(catalogStockNotificationsTable.tenantId, tenantId))).returning();
  if (!row) { res.status(404).json({ error: "Pedido não encontrado" }); return; }
  res.json({ ok: true });
});

router.delete("/catalog/stock-notifications/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  await db.delete(catalogStockNotificationsTable)
    .where(and(eq(catalogStockNotificationsTable.id, id), eq(catalogStockNotificationsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ─── Formas de pagamento (vitrine pública) ──────────────────────────────────
// Configurável pela loja (mesmo padrão de TRUST_BADGES_KEY acima) — pedido
// do lojista foi "deixa em branco pra eu cadastrar depois", então o padrão
// aqui é lista VAZIA (sem nenhuma forma de pagamento pronta) — a seção "Ver
// formas de pagamento" só aparece na vitrine pública depois que a loja
// cadastrar pelo menos uma.

type PaymentMethod = { title: string; description: string };
const PAYMENT_METHODS_KEY = "catalog_payment_methods";

function sanitizePaymentMethods(raw: unknown): PaymentMethod[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    return { title: clean(o.title, 60), description: clean(o.description, 140) };
  }).filter((b) => b.title);
}

async function getPaymentMethods(tenantId: number): Promise<PaymentMethod[]> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, PAYMENT_METHODS_KEY))).limit(1);
  if (!row) return [];
  try {
    return sanitizePaymentMethods(JSON.parse(row.value));
  } catch {
    return [];
  }
}

router.get("/catalog/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json({ methods: await getPaymentMethods(tenantId) });
});

router.put("/catalog/payment-methods", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const methods = sanitizePaymentMethods((req.body as { methods?: unknown }).methods);
  await db.insert(appSettingsTable)
    .values({ tenantId, key: PAYMENT_METHODS_KEY, value: JSON.stringify(methods) })
    .onConflictDoUpdate({ target: [appSettingsTable.tenantId, appSettingsTable.key], set: { value: JSON.stringify(methods), updatedAt: new Date() } });
  res.json({ methods });
});

// ─── Avaliações de clientes (estrelas + comentário) ─────────────────────────
// Botão "Avaliar" só aparece na vitrine pública pra quem está no modo
// varejo (sem o código de atacado desbloqueado — ver wholesaleUnlocked no
// front). Sem aprovação prévia: aparece direto; a loja apaga pelo painel
// (botão "Avaliações") se algum comentário for indevido.

router.get("/catalog/reviews", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(catalogProductReviewsTable)
    .where(eq(catalogProductReviewsTable.tenantId, tenantId))
    .orderBy(desc(catalogProductReviewsTable.createdAt)).limit(300);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const products = productIds.length > 0
    ? await db.select({ id: catalogProductsTable.id, model: catalogProductsTable.model }).from(catalogProductsTable)
        .where(and(inArray(catalogProductsTable.id, productIds), eq(catalogProductsTable.tenantId, tenantId)))
    : [];
  const productById = new Map(products.map((p) => [p.id, p.model]));
  const variantIds = [...new Set(rows.map((r) => r.variantId).filter((v): v is number => v != null))];
  const variants = variantIds.length > 0
    ? await db.select({ id: catalogProductVariantsTable.id, storage: catalogProductVariantsTable.storage, color: catalogProductVariantsTable.color })
        .from(catalogProductVariantsTable).where(inArray(catalogProductVariantsTable.id, variantIds))
    : [];
  const variantById = new Map(variants.map((v) => [v.id, v]));
  res.json({
    reviews: rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      model: productById.get(r.productId) ?? "(produto removido)",
      variant: r.variantId != null ? variantById.get(r.variantId) ?? null : null,
      rating: r.rating,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      customerCity: r.customerCity,
      comment: r.comment,
      createdAt: r.createdAt,
    })),
  });
});

router.delete("/catalog/reviews/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  await db.delete(catalogProductReviewsTable)
    .where(and(eq(catalogProductReviewsTable.id, id), eq(catalogProductReviewsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// ─── Link público e contato (WhatsApp) da vitrine ───────────────────────────

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

router.get("/catalog/slug", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ catalogSlug: tenantsTable.catalogSlug }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  res.json({ slug: tenant?.catalogSlug ?? null });
});

router.put("/catalog/slug", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const raw = (req.body as { slug?: unknown }).slug;
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!slug) {
    await db.update(tenantsTable).set({ catalogSlug: null }).where(eq(tenantsTable.id, tenantId));
    res.json({ slug: null });
    return;
  }
  if (!SLUG_RE.test(slug)) { res.status(400).json({ error: "Use só letras minúsculas, números e hífen (3 a 40 caracteres)" }); return; }
  const [taken] = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.catalogSlug, slug)).limit(1);
  if (taken && taken.id !== tenantId) { res.status(409).json({ error: "Esse endereço já está em uso. Escolha outro." }); return; }
  await db.update(tenantsTable).set({ catalogSlug: slug }).where(eq(tenantsTable.id, tenantId));
  res.json({ slug });
});

// WhatsApp de vendas mostrado no botão da vitrine pública — configurado pelo
// admin da loja (não é o contactPhone administrativo do superadmin).
router.get("/catalog/whatsapp", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ catalogWhatsapp: tenantsTable.catalogWhatsapp, contactPhone: tenantsTable.contactPhone })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  res.json({ whatsapp: tenant?.catalogWhatsapp ?? tenant?.contactPhone ?? null });
});

router.put("/catalog/whatsapp", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const raw = (req.body as { whatsapp?: unknown }).whatsapp;
  const digits = typeof raw === "string" ? raw.replace(/\D/g, "").slice(0, 15) : "";
  if (raw && !digits) { res.status(400).json({ error: "Número inválido" }); return; }
  await db.update(tenantsTable).set({ catalogWhatsapp: digits || null }).where(eq(tenantsTable.id, tenantId));
  res.json({ whatsapp: digits || null });
});

// WhatsApp de atacado — número separado mostrado só pra quem desbloqueou o
// preço de atacado com o código de acesso. Null = a vitrine pública cai no
// mesmo número de varejo pra todo mundo (comportamento de antes desse campo
// existir).
router.get("/catalog/whatsapp-wholesale", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ whatsapp: tenantsTable.catalogWhatsappWholesale }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  res.json({ whatsapp: tenant?.whatsapp ?? null });
});

router.put("/catalog/whatsapp-wholesale", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const raw = (req.body as { whatsapp?: unknown }).whatsapp;
  const digits = typeof raw === "string" ? raw.replace(/\D/g, "").slice(0, 15) : "";
  if (raw && !digits) { res.status(400).json({ error: "Número inválido" }); return; }
  await db.update(tenantsTable).set({ catalogWhatsappWholesale: digits || null }).where(eq(tenantsTable.id, tenantId));
  res.json({ whatsapp: digits || null });
});

// Código de acesso ao preço de atacado — senha única compartilhada com
// técnicos/lojistas de confiança (não é um login individual). Nunca é
// devolvido em texto puro pra ninguém além do admin da própria loja aqui;
// a vitrine pública só recebe se o código enviado bateu (ver /catalog-public).
router.get("/catalog/wholesale-code", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ code: tenantsTable.catalogWholesaleCode }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  res.json({ hasCode: !!tenant?.code, code: tenant?.code ?? null });
});

router.put("/catalog/wholesale-code", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const raw = (req.body as { code?: unknown }).code;
  const code = typeof raw === "string" ? raw.trim().slice(0, 40) : "";
  await db.update(tenantsTable).set({ catalogWholesaleCode: code || null }).where(eq(tenantsTable.id, tenantId));
  res.json({ hasCode: !!code, code: code || null });
});

// ─── Importação de lista do fornecedor via IA ───────────────────────────────

type ParsedVariant = { storage: string | null; color: string | null; costPrice: number | null };
type ParsedItem = {
  model: string;
  condition: CatalogCondition;
  colors: string[];
  variants: ParsedVariant[];
  status: "approved" | "pending";
  issue: string | null;
  rawLine: string;
  // Categoria/subcategoria sugerida pela IA (ex.: ["Celulares","Samsung"]).
  // categoryId preenchido = já existe exatamente essa categoria/subcategoria
  // na loja (aplicada direto). categoryPath preenchido = sugestão que NÃO
  // bate com nenhuma categoria existente — precisa de autorização do lojista
  // pra criar (ver banner de "novas categorias sugeridas" no import).
  categoryId: number | null;
  categoryPath: string[] | null;
};

function extractJsonArray(raw: string): unknown[] | null {
  const text = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanParsedVariants(raw: unknown): ParsedVariant[] {
  const arr = Array.isArray(raw) ? raw : [];
  const list = arr.slice(0, 20).map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { storage: clean(o.storage, 40) || null, color: clean(o.color, 40) || null, costPrice: toNumberOrNull(o.costPrice) };
  });
  return list.length > 0 ? list : [{ storage: null, color: null, costPrice: null }];
}

// Junta itens com o mesmo modelo+condição (comparação sem diferenciar maiúsculas
// e espaços) num único item, combinando variantes/cores/categoria — ver o
// comentário no ponto de uso (import/parse) pra o motivo dessa segunda passada.
function mergeParsedItems(items: ParsedItem[]): ParsedItem[] {
  const normKey = (model: string, condition: string) => `${model.trim().toLowerCase().replace(/\s+/g, " ")}|${condition}`;
  const order: string[] = [];
  const byKey = new Map<string, ParsedItem>();
  for (const it of items) {
    const key = normKey(it.model, it.condition);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...it, variants: [...it.variants], colors: [...it.colors] });
      order.push(key);
      continue;
    }
    for (const v of it.variants) {
      const isPlaceholder = v.storage == null && v.color == null && v.costPrice == null;
      if (isPlaceholder) continue;
      const dup = existing.variants.some((ev) => ev.storage === v.storage && ev.color === v.color);
      if (!dup) existing.variants.push(v);
    }
    for (const c of it.colors) {
      if (!existing.colors.includes(c)) existing.colors.push(c);
    }
    if (existing.categoryId == null && existing.categoryPath == null) {
      existing.categoryId = it.categoryId;
      existing.categoryPath = it.categoryPath;
    }
    if (it.rawLine && existing.rawLine !== it.rawLine && !existing.rawLine.includes(it.rawLine)) {
      existing.rawLine = existing.rawLine ? `${existing.rawLine} | ${it.rawLine}` : it.rawLine;
    }
    // Recalcula status/issue em cima das variantes já mescladas — um item que
    // sozinho parecia "sem preço" pode ter ganhado preço do outro bloco mesclado.
    const hasPrice = existing.variants.some((v) => v.costPrice != null);
    const modelMissing = !existing.model || existing.model === "(modelo não identificado)";
    const missing = modelMissing || !hasPrice;
    existing.status = missing ? "pending" : "approved";
    existing.issue = missing ? (modelMissing ? "Modelo não identificado" : "Preço não identificado") : null;
  }
  return order.map((k) => byKey.get(k)!);
}

// Interpreta a sugestão de categoria da IA (ex.: ["Celulares","Samsung"]).
// Casa contra as categorias já cadastradas na loja, nível por nível
// (case-insensitive). Se o caminho inteiro já existe, devolve o id direto —
// nenhuma categoria nova precisa ser criada. Se faltar algum nível, devolve
// categoryPath com o caminho completo sugerido, pra pedir autorização do
// lojista antes de criar (a criação em si acontece no front, reaproveitando
// o CRUD de categorias já existente).
function cleanCategoryPath(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names = raw.map((v) => clean(v, 60)).filter(Boolean).slice(0, 2); // só 2 níveis (categoria > subcategoria)
  return names.length > 0 ? names : null;
}

function matchCategoryPath(categories: CatalogCategory[], pathNames: string[] | null): { categoryId: number | null; categoryPath: string[] | null } {
  if (!pathNames || pathNames.length === 0) return { categoryId: null, categoryPath: null };
  const norm = (s: string) => s.trim().toLowerCase();
  let parentId: number | null = null;
  for (const name of pathNames) {
    const found = categories.find((c) => norm(c.name) === norm(name) && c.parentId === parentId);
    if (!found) return { categoryId: null, categoryPath: pathNames };
    parentId = found.id;
  }
  return { categoryId: parentId, categoryPath: null };
}

router.post("/catalog/import/parse", requireAuth, requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawText = typeof (req.body as { rawText?: unknown }).rawText === "string" ? (req.body as { rawText: string }).rawText : "";
  const text = rawText.trim().slice(0, 12000);
  if (!text) { res.status(400).json({ error: "Cole a lista de aparelhos" }); return; }

  const existingCategories = await db.select().from(catalogCategoriesTable)
    .where(eq(catalogCategoriesTable.tenantId, tenantId))
    .orderBy(catalogCategoriesTable.sortOrder, catalogCategoriesTable.id);
  const categoryList = existingCategories
    .filter((c) => c.parentId == null)
    .map((top) => {
      const subs = existingCategories.filter((c) => c.parentId === top.id).map((s) => s.name);
      return subs.length > 0 ? `${top.name} (subcategorias: ${subs.join(", ")})` : top.name;
    })
    .join("; ");

  const prompt = [
    `Você organiza listas de fornecedores de celulares (mercado brasileiro) em dados estruturados.`,
    `Cada linha ou bloco da lista abaixo descreve um aparelho: modelo, armazenamento, cor(es) e preço de CUSTO (preço do fornecedor pra loja, não o preço de venda ao cliente final).`,
    `Ignore emojis, cabeçalhos, informações de garantia/contato/endereço — extraia SÓ os aparelhos.`,
    `IMPORTANTE — agrupamento: quando o MESMO modelo com a MESMA condição aparecer na lista várias vezes com armazenamentos e/ou cores diferentes, agrupe TUDO num ÚNICO item (uma família), nunca crie um item separado por armazenamento ou por cor. Dentro desse item, o array "variants" tem uma entrada {"storage","color","costPrice"} pra CADA combinação de armazenamento+cor encontrada (ex.: 128GB Preto, 128GB Azul e 256GB Preto do mesmo modelo/condição viram 3 variantes dentro do mesmo item). Se o preço de custo for igual pra todas as cores de um armazenamento, ainda assim crie uma variante por cor (repita o mesmo costPrice). Se a lista não menciona cor nenhuma pra um armazenamento, deixe "color": null.`,
    ``,
    `Categorias/subcategorias já cadastradas nessa loja (reaproveite pelo nome EXATO sempre que fizer sentido, em vez de inventar uma parecida): ${categoryList || "(nenhuma cadastrada ainda)"}.`,
    `Pra cada aparelho, sugira também "categoryPath": um array com 1 ou 2 níveis indicando a aba/sub-aba da vitrine pública onde ele se encaixa (ex.: ["Celulares","Samsung"] ou ["Peças de celular"]). Prefira sempre reaproveitar um nome já cadastrado acima; só sugira um nome novo quando não existir nada parecido. Se não tiver confiança nenhuma pra sugerir, use null.`,
    ``,
    `Lista:`,
    text,
    ``,
    `Responda SOMENTE com um JSON array válido, sem markdown, um objeto por aparelho (família modelo+condição, independente de cor/armazenamento), neste formato:`,
    `[{"model":"iPhone 15 Pro Max","condition":"excelente","colors":["Preto","Azul"],"variants":[{"storage":"256GB","color":"Preto","costPrice":3850},{"storage":"256GB","color":"Azul","costPrice":3850},{"storage":"512GB","color":"Preto","costPrice":4200}],"categoryPath":["Celulares","Apple"],"rawLine":"trecho original correspondente"}]`,
    `"colors" no nível do item é só a lista resumida de todas as cores encontradas pra esse modelo (informativo); o detalhe por combinação fica em "variants".`,
    `"condition" deve ser um destes: novo, excelente, muito_bom, bom, outlet (use "bom" se não estiver claro). Use "novo" quando a lista indicar que o aparelho é lacrado/lacrado de fábrica/nunca usado (ex.: "lacrado", "novo", "sealed") — não confunda com "excelente", que é pra seminovo em ótimo estado.`,
    `Se não conseguir identificar o modelo ou nenhum preço de custo com confiança, ainda inclua o item com o que conseguir e deixe os campos faltantes null.`,
  ].join("\n");

  try {
    const { getOpenAiClientForTenant } = await import("../lib/aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-4o",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      },
      // O client (aiClient.ts / integrations-openai-ai) usa 25s de timeout
      // por padrão — bom pra chamadas leves, mas curto demais aqui: essa
      // rota lê uma lista de fornecedor inteira (até 12000 caracteres) e
      // pede pra IA devolver até 4096 tokens de JSON estruturado, o que em
      // listas grandes passa de 25s com alguma frequência (timeout real,
      // não a IA "fora do ar" — só demora mais que o padrão). Sobrescreve
      // só nesta chamada, sem mudar o timeout padrão usado pelas outras
      // features de IA do sistema.
      { timeout: 55_000 },
    );
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const arr = extractJsonArray(raw);
    if (!arr) { res.status(502).json({ error: "A IA não retornou uma lista válida. Tente novamente." }); return; }

    const rawItems: ParsedItem[] = arr.slice(0, 200).map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const model = clean(o.model, 120);
      const variants = cleanParsedVariants(o.variants);
      const hasPrice = variants.some((v) => v.costPrice != null);
      const missing = !model || !hasPrice;
      const { categoryId, categoryPath } = matchCategoryPath(existingCategories, cleanCategoryPath(o.categoryPath));
      return {
        model: model || "(modelo não identificado)",
        condition: cleanCondition(o.condition),
        colors: cleanColors(o.colors),
        variants,
        status: missing ? "pending" : "approved",
        issue: missing ? (!model ? "Modelo não identificado" : "Preço não identificado") : null,
        rawLine: clean(o.rawLine, 300),
        categoryId,
        categoryPath,
      };
    });
    // Segunda passada, determinística (não depende da IA acertar sempre): mescla
    // itens que vieram separados mas são o MESMO aparelho (modelo+condição iguais)
    // — acontece quando a lista do fornecedor lista o mesmo modelo em blocos
    // diferentes (ex.: um bloco de 256GB e outro de 1TB) e a IA, mesmo instruída
    // a agrupar tudo, ainda assim devolve dois itens. Sem essa mesclagem, a tela
    // de importação mostra dois cartões pro mesmo modelo em vez de um só com
    // todas as combinações de armazenamento/cor como variantes selecionáveis.
    const items: ParsedItem[] = mergeParsedItems(rawItems);
    // Caminhos de categoria sugeridos que ainda não existem na loja, deduplicados —
    // o front pede autorização do lojista antes de criar qualquer um deles.
    const seen = new Set<string>();
    const newCategoryPaths: string[][] = [];
    for (const it of items) {
      if (!it.categoryPath) continue;
      const key = it.categoryPath.join(" > ").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      newCategoryPaths.push(it.categoryPath);
    }
    res.json({ items, newCategoryPaths });
  } catch (err) {
    req.log.error({ err }, "Catalog AI import failed");
    // Mensagem específica por causa (antes era sempre a mesma genérica
    // "IA indisponível", mesmo motivo pra qualquer erro — dificultava saber
    // se era só demora (lista grande, tenta de novo) ou algo que precisa de
    // ação (chave de API inválida/sem crédito, exige o admin verificar).
    const { OpenAI: OpenAISdk } = await import("openai");
    let message = "A IA está indisponível no momento. Tente novamente em instantes.";
    if (err instanceof OpenAISdk.APIConnectionTimeoutError || (err as { name?: string })?.name === "APIConnectionTimeoutError") {
      message = "A IA demorou demais pra analisar essa lista (listas grandes podem passar de 1 minuto). Tente novamente — se persistir, tente colar em partes menores.";
    } else if (err instanceof OpenAISdk.RateLimitError) {
      message = "A IA está sobrecarregada no momento (limite de uso atingido). Aguarde um instante e tente de novo.";
    } else if (err instanceof OpenAISdk.AuthenticationError) {
      message = "A chave de acesso à IA está inválida ou expirada. Fale com o administrador do sistema.";
    }
    res.status(503).json({ error: message });
  }
});

// Busca best-effort de fotos pra anexar automaticamente ao importar por IA —
// mesma API da busca manual (searchImages, rota /catalog/photo-search acima),
// mas nunca propaga erro: sem nenhum provedor configurado, ou se a busca
// falhar por qualquer motivo, o produto simplesmente importa sem foto,
// exatamente como já acontecia antes dessa feature existir.
async function autoPhotoSearchUrls(query: string, num = 3): Promise<string[]> {
  if (!photoSearchConfigured()) return [];
  try {
    const results = await searchImages(query, num);
    return results.map((r) => r.imageUrl).filter(Boolean);
  } catch (err) {
    logger.warn({ err, query }, "Catalog auto photo search failed");
    return [];
  }
}

// Baixa e anexa uma foto ao produto — mesma validação da rota manual
// /catalog/products/:id/photos/from-url, mas devolve boolean em vez de
// responder HTTP (uso interno, best-effort, nunca derruba a importação).
async function autoAttachPhoto(tenantId: number, productId: number, imageUrl: string, sortOrder = 0, color: string | null = null): Promise<boolean> {
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const r = await fetch(parsed, { signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "SheikCellVitrineBot/1.0" } });
    if (!r.ok) return false;
    const contentLength = Number(r.headers.get("content-length") ?? "0");
    if (contentLength > MAX_PHOTO_SIZE) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PHOTO_SIZE) return false;
    const mime = sniffImageMime(buf);
    const ext = mime ? PHOTO_MIME[mime] : null;
    if (!ext) return false;

    await mkdir(CATALOG_MEDIA_DIR, { recursive: true });
    const storedName = `${randomUUID()}.${ext}`;
    await writeFile(path.join(CATALOG_MEDIA_DIR, storedName), buf);
    await db.insert(catalogProductPhotosTable).values({ tenantId, productId, storedName, sourceUrl: parsed.toString(), sortOrder, color });
    return true;
  } catch {
    return false;
  }
}

// Protege contra imports enormes deixando o confirm lento — acima disso, os
// produtos ainda importam normalmente, só não tentam foto automática (dá pra
// buscar manualmente depois, um por um, na tela de edição).
const AUTO_IMPORT_PHOTO_LIMIT = 40;

// Teto de fotos automáticas por produto — mesmo teto do upload manual (o
// modal de edição já aceita até 8 arquivos de uma vez).
const AUTO_PHOTO_MAX_PER_PRODUCT = 8;

// Busca e anexa fotos tentando pegar UMA de cada cor cadastrada do produto
// que ainda não tem foto própria (ex.: "iPhone 14 Pro Max Preto", "iPhone 14
// Pro Max Vermelho", ...), marcando cada foto com a cor da busca que achou
// ela — é essa marcação que deixa a vitrine pública trocar de foto junto com
// o seletor de cor (ver publicPhotoIds/color). missingColors já vem filtrado
// pelo chamador (só as cores que ainda não têm foto — nem tenta de novo uma
// cor que já foi resolvida antes). usedUrls evita repetir uma foto já
// anexada (tanto entre cores nesta chamada quanto contra fotos que o produto
// já tinha, num "top up"). sortOrder incremental (a partir de startSortOrder)
// preserva a ordem: fotos existentes primeiro, novas depois.
async function autoAttachPhotosForProduct(
  tenantId: number,
  productId: number,
  model: string,
  missingColors: string[],
  hasAnyColor: boolean,
  usedUrls: Set<string>,
  startSortOrder: number,
  maxNewPhotos: number,
): Promise<number> {
  let sortOrder = startSortOrder;
  let attached = 0;

  async function attachFirstNew(urls: string[], color: string | null): Promise<boolean> {
    for (const url of urls) {
      if (usedUrls.has(url)) continue;
      if (await autoAttachPhoto(tenantId, productId, url, sortOrder, color)) {
        usedUrls.add(url);
        sortOrder++;
        attached++;
        return true;
      }
    }
    return false;
  }

  if (missingColors.length > 0) {
    for (const color of missingColors) {
      if (attached >= maxNewPhotos) break;
      const urls = await autoPhotoSearchUrls(`${model} ${color}`, 3);
      await attachFirstNew(urls, color);
    }
  } else if (!hasAnyColor) {
    // Produto sem nenhuma cor cadastrada: busca genérica normal do modelo,
    // sem marcação de cor (foto "geral").
    const urls = await autoPhotoSearchUrls(model, maxNewPhotos);
    for (const url of urls) {
      if (attached >= maxNewPhotos) break;
      await attachFirstNew([url], null);
    }
  }

  // Fallback: se alguma cor não achou foto própria (ou sobrou espaço),
  // completa o que falta com busca genérica do modelo, SEM marcar cor — essa
  // foto "geral" aparece pra qualquer cor que não tenha foto dedicada, em vez
  // de deixar o carrossel vazio.
  if (attached < maxNewPhotos) {
    const urls = await autoPhotoSearchUrls(model, maxNewPhotos - attached + 2);
    for (const url of urls) {
      if (attached >= maxNewPhotos) break;
      await attachFirstNew([url], null);
    }
  }

  return attached;
}

// Uma tentativa de foto por produto recém-importado (busca por cor + fallback
// genérico), tudo em paralelo. Melhor esforço: nunca lança erro, nunca atrasa
// a resposta além do timeout de uma busca+download (rodam junto, não somados
// por produto).
async function autoAttachPhotosOnImport(
  tenantId: number,
  products: (typeof catalogProductsTable.$inferSelect)[],
): Promise<number> {
  if (!photoSearchConfigured()) return 0;
  const targets = products.slice(0, AUTO_IMPORT_PHOTO_LIMIT);
  const outcomes = await Promise.allSettled(targets.map((p) => {
    const target = Math.min(AUTO_PHOTO_MAX_PER_PRODUCT, p.colors.length > 0 ? p.colors.length : 3);
    return autoAttachPhotosForProduct(tenantId, p.id, p.model, p.colors, p.colors.length === 0, new Set<string>(), 0, target);
  }));
  return outcomes.filter((o) => o.status === "fulfilled" && o.value > 0).length;
}

// "Recuperar" produtos que ficaram sem foto (ou sem foto suficiente pra ter
// uma de cada cor) — cobre três casos reais: (1) produtos importados numa
// época em que a busca automática ainda não tinha um provedor funcionando de
// verdade (ex.: só o Google Custom Search configurado, que está fechado pra
// clientes novos desde 2024 — a tentativa automática do import rodava e
// sempre falhava, calada, e o produto ficava sem foto pra sempre, sem nenhum
// jeito de tentar de novo em massa); (2) fotos que existiam mas o arquivo se
// perdeu (ex.: cadastradas antes do armazenamento permanente `/app/storage`
// existir); (3) produtos com várias cores cadastradas mas que só ganharam 1
// foto na importação original — "completa" até ter uma foto por cor. Mesmo
// best-effort do import automático, só que rodando sob demanda pra todos os
// produtos de uma vez, em vez de um por um na tela de editar produto.
const BULK_MISSING_PHOTO_LIMIT = 25;

router.post("/catalog/products/photos/fetch-missing", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  if (!photoSearchConfigured()) {
    res.status(501).json({ error: "Busca de imagens não configurada neste servidor." });
    return;
  }
  const rows = await db.select({ id: catalogProductsTable.id, model: catalogProductsTable.model, colors: catalogProductsTable.colors })
    .from(catalogProductsTable).where(eq(catalogProductsTable.tenantId, tenantId));
  const photosMap = await photosByProductIds(tenantId, rows.map((r) => r.id));

  const needsMore = rows
    .map((r) => {
      const existing = photosMap.get(r.id) ?? [];
      const target = Math.min(AUTO_PHOTO_MAX_PER_PRODUCT, r.colors.length > 0 ? r.colors.length : 3);
      const coveredColors = new Set(existing.map((ph) => ph.color).filter((c): c is string => !!c));
      const missingColors = r.colors.filter((c) => !coveredColors.has(c));
      const needed = Math.max(0, target - existing.length);
      return { row: r, existing, missingColors, needed };
    })
    .filter((x) => x.needed > 0 && (x.missingColors.length > 0 || x.row.colors.length === 0));

  const targets = needsMore.slice(0, BULK_MISSING_PHOTO_LIMIT);

  const outcomes = await Promise.allSettled(targets.map((t) => {
    const usedUrls = new Set(t.existing.map((ph) => ph.sourceUrl).filter((u): u is string => !!u));
    return autoAttachPhotosForProduct(
      tenantId, t.row.id, t.row.model, t.missingColors, t.row.colors.length === 0, usedUrls, t.existing.length, t.needed,
    );
  }));
  const attached = outcomes.filter((o) => o.status === "fulfilled" && o.value > 0).length;
  res.json({
    checked: targets.length,
    attached,
    remaining: Math.max(0, needsMore.length - targets.length),
    photoSearchConfigured: true,
  });
});

router.post("/catalog/import/confirm", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const items = (req.body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "Nenhum item para importar" }); return; }

  const settings = await getPricingSettings(tenantId);
  const toImportRaw = items.slice(0, 200).map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      model: clean(o.model, 120), condition: cleanCondition(o.condition), colors: cleanColors(o.colors),
      variants: cleanParsedVariants(o.variants), categoryIdRaw: o.categoryId,
    };
  }).filter((p) => p.model);

  if (toImportRaw.length === 0) { res.status(400).json({ error: "Nenhum item válido para importar" }); return; }
  // categoryId já vem resolvido pelo front (categoria existente escolhida
  // manualmente, ou criada com autorização a partir da sugestão da IA) — só
  // valida que a categoria realmente pertence a essa loja.
  const toImport = await Promise.all(toImportRaw.map(async (p) => ({ ...p, categoryId: await cleanCategoryId(tenantId, p.categoryIdRaw) })));

  const createdProducts: (typeof catalogProductsTable.$inferSelect)[] = [];
  for (const item of toImport) {
    const [product] = await db.insert(catalogProductsTable).values({
      tenantId, model: item.model, condition: item.condition, colors: item.colors, categoryId: item.categoryId, createdBy: req.session.userId ?? null,
    }).returning();
    await replaceVariants(tenantId, product.id, item.variants.map((v) => ({ storage: v.storage, color: v.color, costPrice: v.costPrice })), settings);
    createdProducts.push(product);
  }
  // Melhor esforço: tenta puxar 1 foto por produto recém-criado (mesma busca
  // usada no botão manual). Se a busca não estiver liberada (ex.: falta
  // vincular conta de faturamento no Google Cloud) ou falhar, os produtos já
  // foram importados normalmente — só ficam sem foto, como sempre.
  const photosAttached = await autoAttachPhotosOnImport(tenantId, createdProducts);
  res.status(201).json({ imported: createdProducts.length, products: createdProducts, photosAttached, photoSearchConfigured: photoSearchConfigured() });
});

export default router;

// ─── Vitrine pública (sem autenticação) ─────────────────────────────────────
// Rota separada, montada num prefixo distinto ("/catalog-public") pra nunca
// passar pelo requireModuleAccess("vitrine") aplicado acima (que exige sessão
// de loja) — a vitrine pública é vista por clientes, sem login.
export const catalogPublicRouter: IRouter = Router();

catalogPublicRouter.get("/catalog-public/:slug", async (req: Request, res: Response): Promise<void> => {
  const rawSlug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const slug = (rawSlug ?? "").toLowerCase();
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.catalogSlug, slug)).limit(1);
  if (!tenant || !tenant.isActive || !tenant.enabledModules.includes("vitrine")) {
    res.status(404).json({ error: "Vitrine não encontrada" });
    return;
  }
  const rows = await db.select().from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.tenantId, tenant.id), eq(catalogProductsTable.status, "active")))
    .orderBy(catalogProductsTable.sortOrder, desc(catalogProductsTable.createdAt));
  const ids = rows.map((r) => r.id);
  const [photos, variants, categories, pricingSettings, trustBadges, paymentMethods, reviewRows] = await Promise.all([
    photosByProductIds(tenant.id, ids),
    variantsByProductIds(tenant.id, ids),
    db.select().from(catalogCategoriesTable).where(eq(catalogCategoriesTable.tenantId, tenant.id)).orderBy(catalogCategoriesTable.sortOrder, catalogCategoriesTable.id),
    getPricingSettings(tenant.id),
    getTrustBadges(tenant.id),
    getPaymentMethods(tenant.id),
    ids.length > 0
      ? db.select({ productId: catalogProductReviewsTable.productId, rating: catalogProductReviewsTable.rating })
          .from(catalogProductReviewsTable)
          .where(and(eq(catalogProductReviewsTable.tenantId, tenant.id), inArray(catalogProductReviewsTable.productId, ids)))
      : Promise.resolve([]),
  ]);

  // Média/contagem de avaliação por produto — calculado aqui (não guardado
  // na tabela) pra nunca ficar desatualizado se uma avaliação for apagada.
  const reviewsSummaryByProduct = new Map<number, { average: number; count: number }>();
  for (const r of reviewRows) {
    const cur = reviewsSummaryByProduct.get(r.productId) ?? { average: 0, count: 0 };
    cur.average = (cur.average * cur.count + r.rating) / (cur.count + 1);
    cur.count += 1;
    reviewsSummaryByProduct.set(r.productId, cur);
  }

  // Preço de atacado só sai na resposta se o código enviado bater com o
  // configurado pela loja — sem código configurado, ninguém vê (nem com
  // código nenhum, nem com código errado).
  const sentCode = clean((req.query as Record<string, unknown>).code, 40);
  const wholesaleUnlocked = !!tenant.catalogWholesaleCode && sentCode === tenant.catalogWholesaleCode;

  const retailWa = tenant.catalogWhatsapp ?? tenant.contactPhone ?? null;
  res.json({
    storeName: tenant.name,
    whatsapp: retailWa,
    // Só faz sentido mandar o número de atacado pra quem já desbloqueou —
    // sem código bloqueado nem chega a aparecer no front. Cai no número de
    // varejo se a loja não configurou um número de atacado próprio.
    whatsappWholesale: wholesaleUnlocked ? (tenant.catalogWhatsappWholesale ?? retailWa) : null,
    hasWholesale: !!tenant.catalogWholesaleCode,
    wholesaleUnlocked,
    categories: categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder })),
    // Selos de confiança/garantia customizados pela loja — mostrados uma vez
    // por página (ver getTrustBadges/DEFAULT_TRUST_BADGES acima).
    trustBadges,
    // Formas de pagamento cadastradas pela loja — lista vazia até a loja
    // cadastrar a primeira (ver getPaymentMethods acima); o front só mostra
    // a seção "Ver formas de pagamento" se vier pelo menos uma.
    paymentMethods,
    // Nunca expõe custo/margem — só o que o cliente final (ou o
    // técnico/lojista com código, no caso do atacado) pode ver.
    products: rows
      .map((r) => ({
        id: r.id,
        model: r.model,
        condition: r.condition,
        colors: r.colors,
        description: r.description,
        categoryId: r.categoryId,
        aiCharacteristics: r.aiCharacteristics ?? null,
        // Aproximação de popularidade (clique em "Finalizar pedido"), usada
        // só pro filtro de ordenação "Mais comprado" no front — ver
        // comentário em catalogProductsTable.purchaseCount.
        purchaseCount: r.purchaseCount,
        // Resumo de avaliação (estrelas) — null quando o produto ainda não
        // tem nenhuma avaliação, pro front não mostrar "0 avaliações".
        reviewsSummary: reviewsSummaryByProduct.has(r.id)
          ? { average: Math.round(reviewsSummaryByProduct.get(r.id)!.average * 10) / 10, count: reviewsSummaryByProduct.get(r.id)!.count }
          : null,
        photos: publicPhotoIds(photos.get(r.id) ?? [], r.condition),
        variants: (variants.get(r.id) ?? [])
          .filter((v) => v.salePrice != null)
          .map((v) => {
            // Preço de atacado calculado na hora (sempre em sincronia com a
            // margem de atacado atual, ver withWholesaleInstallmentPricing);
            // só cai no valor gravado no banco se não der pra calcular
            // (produto sem custo cadastrado = número de atacado digitado à
            // mão pelo lojista).
            const wholesale = withWholesaleInstallmentPricing(v, pricingSettings);
            return {
              id: v.id, storage: v.storage, color: v.color, salePrice: v.salePrice, inStock: v.stockQty > 0,
              wholesalePrice: wholesaleUnlocked ? (wholesale.wholesalePriceCash ?? v.wholesalePrice) : null,
              // Preço "de" (comparação) — a vitrine pública só usa ele pra
              // mostrar o riscado/selo de desconto se for maior que o preço à
              // vista atual (ver cálculo no front, VitrinePublica.tsx).
              compareAtPrice: v.compareAtPrice,
              // à vista/12x calculados na hora, nunca expõe custo/margem (ver withInstallmentPricing).
              ...withInstallmentPricing(v, pricingSettings),
              // 12x de atacado só sai junto do preço de atacado, ou seja, só pra
              // quem já desbloqueou com o código (mesma regra do wholesalePrice acima).
              wholesaleInstallment12Value: wholesaleUnlocked ? wholesale.wholesaleInstallment12Value : null,
            };
          }),
      }))
      .filter((p) => p.variants.length > 0),
  });
});

// "Avise-me quando chegar" — cliente (sem login) pede pra ser avisado quando
// um produto/variante esgotado voltar ao estoque. Best-effort de validação:
// produto precisa existir e pertencer a essa loja; variantId (se enviado)
// precisa pertencer a esse produto — mas não IMPEDE o pedido se o item já
// tiver voltado ao estoque nesse meio tempo (o lojista decide o que fazer,
// não é um bloqueio automático).
catalogPublicRouter.post("/catalog-public/:slug/notify-me", async (req: Request, res: Response): Promise<void> => {
  const rawSlug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const slug = (rawSlug ?? "").toLowerCase();
  const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(and(eq(tenantsTable.catalogSlug, slug), eq(tenantsTable.isActive, true))).limit(1);
  if (!tenant) { res.status(404).json({ error: "Vitrine não encontrada" }); return; }

  const body = req.body as Record<string, unknown>;
  const productId = Number(body.productId);
  const variantIdRaw = body.variantId;
  const customerName = clean(body.customerName, 100);
  const customerContact = clean(body.customerContact, 100);
  if (!Number.isInteger(productId) || productId <= 0) { res.status(400).json({ error: "Produto inválido" }); return; }
  if (!customerName || !customerContact) { res.status(400).json({ error: "Informe seu nome e um contato (WhatsApp ou e-mail)" }); return; }

  const [product] = await db.select({ id: catalogProductsTable.id }).from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, productId), eq(catalogProductsTable.tenantId, tenant.id))).limit(1);
  if (!product) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  let variantId: number | null = null;
  if (variantIdRaw != null) {
    const vId = Number(variantIdRaw);
    if (Number.isInteger(vId) && vId > 0) {
      const [variant] = await db.select({ id: catalogProductVariantsTable.id }).from(catalogProductVariantsTable)
        .where(and(eq(catalogProductVariantsTable.id, vId), eq(catalogProductVariantsTable.productId, productId), eq(catalogProductVariantsTable.tenantId, tenant.id))).limit(1);
      if (variant) variantId = variant.id;
    }
  }

  await db.insert(catalogStockNotificationsTable).values({
    tenantId: tenant.id, productId, variantId, customerName, customerContact,
  });
  res.status(201).json({ ok: true });
});

// Contador de "clique em finalizar pedido" — usado só como aproximação de
// popularidade pro filtro "Mais comprado" na listagem (não existe hoje
// nenhum sistema de pedido/venda confirmada vinculado à Vitrine; "Finalizar
// pedido no WhatsApp" só abre uma conversa, a venda em si acontece fora do
// sistema). Best-effort: nunca falha alto, item inválido é só ignorado.
catalogPublicRouter.post("/catalog-public/:slug/checkout-click", async (req: Request, res: Response): Promise<void> => {
  const rawSlug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const slug = (rawSlug ?? "").toLowerCase();
  const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(and(eq(tenantsTable.catalogSlug, slug), eq(tenantsTable.isActive, true))).limit(1);
  if (!tenant) { res.status(404).json({ error: "Vitrine não encontrada" }); return; }

  const body = req.body as Record<string, unknown>;
  const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  for (const item of items.slice(0, 50)) {
    const productId = Number(item?.productId);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    const qtyRaw = Number(item?.qty);
    const qty = Number.isInteger(qtyRaw) && qtyRaw > 0 ? Math.min(qtyRaw, 50) : 1;
    await db.update(catalogProductsTable)
      .set({ purchaseCount: sql`${catalogProductsTable.purchaseCount} + ${qty}` })
      .where(and(eq(catalogProductsTable.id, productId), eq(catalogProductsTable.tenantId, tenant.id)));
  }
  res.status(200).json({ ok: true });
});

// Avaliação de cliente (estrelas + comentário) — sem login, capturando
// nome/telefone/cidade (pedido do lojista, pra confirmar que é venda real).
// O front só mostra o botão pra quem está no modo varejo (sem código de
// atacado desbloqueado), mas essa rota não impõe essa regra — é só de
// interface; qualquer avaliação recebida aqui é válida.
catalogPublicRouter.post("/catalog-public/:slug/reviews", async (req: Request, res: Response): Promise<void> => {
  const rawSlug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const slug = (rawSlug ?? "").toLowerCase();
  const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable)
    .where(and(eq(tenantsTable.catalogSlug, slug), eq(tenantsTable.isActive, true))).limit(1);
  if (!tenant) { res.status(404).json({ error: "Vitrine não encontrada" }); return; }

  const body = req.body as Record<string, unknown>;
  const productId = Number(body.productId);
  const variantIdRaw = body.variantId;
  const rating = Number(body.rating);
  const customerName = clean(body.customerName, 100);
  const customerPhone = clean(body.customerPhone, 40);
  const customerCity = clean(body.customerCity, 100);
  const comment = clean(body.comment, 500) || null;
  if (!Number.isInteger(productId) || productId <= 0) { res.status(400).json({ error: "Produto inválido" }); return; }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) { res.status(400).json({ error: "Nota inválida" }); return; }
  if (!customerName || !customerPhone || !customerCity) { res.status(400).json({ error: "Informe nome, telefone e cidade" }); return; }

  const [product] = await db.select({ id: catalogProductsTable.id }).from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, productId), eq(catalogProductsTable.tenantId, tenant.id))).limit(1);
  if (!product) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  let variantId: number | null = null;
  if (variantIdRaw != null) {
    const vId = Number(variantIdRaw);
    if (Number.isInteger(vId) && vId > 0) {
      const [variant] = await db.select({ id: catalogProductVariantsTable.id }).from(catalogProductVariantsTable)
        .where(and(eq(catalogProductVariantsTable.id, vId), eq(catalogProductVariantsTable.productId, productId), eq(catalogProductVariantsTable.tenantId, tenant.id))).limit(1);
      if (variant) variantId = variant.id;
    }
  }

  await db.insert(catalogProductReviewsTable).values({
    tenantId: tenant.id, productId, variantId, rating, customerName, customerPhone, customerCity, comment,
  });
  res.status(201).json({ ok: true });
});

catalogPublicRouter.get("/catalog-public/photos/:photoId/file", async (req: Request, res: Response): Promise<void> => {
  const photoId = Number(req.params.photoId);
  const [photo] = await db.select().from(catalogProductPhotosTable).where(eq(catalogProductPhotosTable.id, photoId)).limit(1);
  if (!photo) { res.status(404).json({ error: "Foto não encontrada" }); return; }
  const filepath = path.join(CATALOG_MEDIA_DIR, path.basename(photo.storedName));
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado no servidor" }); return; }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(filepath);
});
