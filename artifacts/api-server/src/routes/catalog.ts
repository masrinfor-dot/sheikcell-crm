import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  db,
  catalogProductsTable,
  catalogProductPhotosTable,
  appSettingsTable,
  tenantsTable,
} from "@workspace/db";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { requirePerm } from "../lib/permissions";
import {
  sanitizePricingSettings,
  precoVendaDoProduto,
  type PricingSettings,
} from "../lib/catalogPricing";
import { CATALOG_CONDITIONS, type CatalogCondition } from "@workspace/db";

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
  return CATALOG_CONDITIONS.includes(v as CatalogCondition) ? (v as CatalogCondition) : "seminovo";
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function photosByProductIds(tenantId: number, productIds: number[]) {
  if (productIds.length === 0) return new Map<number, { id: number; storedName: string; sortOrder: number }[]>();
  const rows = await db.select().from(catalogProductPhotosTable)
    .where(and(eq(catalogProductPhotosTable.tenantId, tenantId), inArray(catalogProductPhotosTable.productId, productIds)))
    .orderBy(catalogProductPhotosTable.sortOrder);
  const map = new Map<number, { id: number; storedName: string; sortOrder: number }[]>();
  for (const p of rows) {
    const list = map.get(p.productId) ?? [];
    list.push({ id: p.id, storedName: p.storedName, sortOrder: p.sortOrder });
    map.set(p.productId, list);
  }
  return map;
}

// ─── Listar / criar / editar / excluir produtos ─────────────────────────────

router.get("/catalog/products", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(catalogProductsTable)
    .where(eq(catalogProductsTable.tenantId, tenantId))
    .orderBy(desc(catalogProductsTable.createdAt));
  const photos = await photosByProductIds(tenantId, rows.map((r) => r.id));
  const settings = await getPricingSettings(tenantId);
  res.json({
    settings,
    products: rows.map((r) => ({ ...r, photos: photos.get(r.id) ?? [] })),
  });
});

router.post("/catalog/products", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Record<string, unknown>;
  const model = clean(body.model, 120);
  if (!model) { res.status(400).json({ error: "Informe o modelo do aparelho" }); return; }

  const costPrice = toNumberOrNull(body.costPrice);
  const costIncludesInvoice = body.costIncludesInvoice === true;
  const marginPercentOverride = toNumberOrNull(body.marginPercentOverride);
  let salePrice = toNumberOrNull(body.salePrice);
  if (salePrice == null && costPrice != null) {
    const settings = await getPricingSettings(tenantId);
    salePrice = precoVendaDoProduto({ costPrice, costIncludesInvoice, marginPercentOverride }, settings);
  }

  const [product] = await db.insert(catalogProductsTable).values({
    tenantId,
    model,
    storage: clean(body.storage, 40) || null,
    condition: cleanCondition(body.condition),
    colors: cleanColors(body.colors),
    description: clean(body.description, 2000) || null,
    costPrice: costPrice != null ? String(costPrice) : null,
    costIncludesInvoice,
    marginPercentOverride: marginPercentOverride != null ? String(marginPercentOverride) : null,
    salePrice: salePrice != null ? String(salePrice) : null,
    stockQty: Number.isInteger(body.stockQty) ? Math.max(0, body.stockQty as number) : 1,
    status: body.status === "inactive" || body.status === "sold" ? body.status : "active",
    createdBy: req.session.userId ?? null,
  }).returning();
  res.status(201).json({ ...product, photos: [] });
});

router.patch("/catalog/products/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Produto inválido" }); return; }
  const [existing] = await db.select().from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, id), eq(catalogProductsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  const body = req.body as Record<string, unknown>;
  const costPrice = "costPrice" in body ? toNumberOrNull(body.costPrice) : Number(existing.costPrice ?? "") || null;
  const costIncludesInvoice = "costIncludesInvoice" in body ? body.costIncludesInvoice === true : existing.costIncludesInvoice;
  const marginPercentOverride = "marginPercentOverride" in body ? toNumberOrNull(body.marginPercentOverride) : (existing.marginPercentOverride != null ? Number(existing.marginPercentOverride) : null);

  let salePrice: number | null;
  if ("salePrice" in body) {
    // Preço definido manualmente pelo lojista — respeita a sobrescrita.
    salePrice = toNumberOrNull(body.salePrice);
  } else if ("costPrice" in body || "marginPercentOverride" in body || "costIncludesInvoice" in body) {
    // Custo/margem mudaram e o preço não foi informado — recalcula.
    const settings = await getPricingSettings(tenantId);
    salePrice = costPrice != null ? precoVendaDoProduto({ costPrice, costIncludesInvoice, marginPercentOverride }, settings) : null;
  } else {
    salePrice = existing.salePrice != null ? Number(existing.salePrice) : null;
  }

  const [updated] = await db.update(catalogProductsTable).set({
    model: "model" in body ? (clean(body.model, 120) || existing.model) : existing.model,
    storage: "storage" in body ? (clean(body.storage, 40) || null) : existing.storage,
    condition: "condition" in body ? cleanCondition(body.condition) : existing.condition,
    colors: "colors" in body ? cleanColors(body.colors) : existing.colors,
    description: "description" in body ? (clean(body.description, 2000) || null) : existing.description,
    costPrice: costPrice != null ? String(costPrice) : null,
    costIncludesInvoice,
    marginPercentOverride: marginPercentOverride != null ? String(marginPercentOverride) : null,
    salePrice: salePrice != null ? String(salePrice) : null,
    stockQty: "stockQty" in body && Number.isInteger(body.stockQty) ? Math.max(0, body.stockQty as number) : existing.stockQty,
    status: body.status === "active" || body.status === "inactive" || body.status === "sold" ? body.status : existing.status,
    sortOrder: "sortOrder" in body && Number.isInteger(body.sortOrder) ? (body.sortOrder as number) : existing.sortOrder,
    updatedAt: new Date(),
  }).where(and(eq(catalogProductsTable.id, id), eq(catalogProductsTable.tenantId, tenantId))).returning();

  const photos = await photosByProductIds(tenantId, [id]);
  res.json({ ...updated, photos: photos.get(id) ?? [] });
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

// ─── Fotos ───────────────────────────────────────────────────────────────────

router.post("/catalog/products/:id/photos", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const productId = Number(req.params.id);
  const [existing] = await db.select({ id: catalogProductsTable.id }).from(catalogProductsTable)
    .where(and(eq(catalogProductsTable.id, productId), eq(catalogProductsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Produto não encontrado" }); return; }

  const { mimeType, data } = req.body as { mimeType?: string; data?: string };
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
    tenantId, productId, storedName, sortOrder: count ? 1 : 0,
  }).returning();
  res.status(201).json(photo);
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

// Simulação de preço sem salvar — usada pela calculadora no formulário do produto.
router.post("/catalog/pricing-settings/simulate", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const settings = await getPricingSettings(tenantId);
  const { costPrice, costIncludesInvoice, marginPercentOverride } = req.body as { costPrice?: unknown; costIncludesInvoice?: unknown; marginPercentOverride?: unknown };
  const custo = toNumberOrNull(costPrice);
  if (custo == null || custo <= 0) { res.status(400).json({ error: "Informe o custo do aparelho" }); return; }
  const salePrice = precoVendaDoProduto(
    { costPrice: custo, costIncludesInvoice: costIncludesInvoice === true, marginPercentOverride: toNumberOrNull(marginPercentOverride) },
    settings,
  );
  res.json({ salePrice, settings });
});

// ─── Link público da vitrine ─────────────────────────────────────────────────

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

// ─── Importação de lista do fornecedor via IA ───────────────────────────────

type ParsedItem = {
  model: string;
  storage: string | null;
  condition: CatalogCondition;
  colors: string[];
  costPrice: number | null;
  status: "approved" | "pending";
  issue: string | null;
  rawLine: string;
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

router.post("/catalog/import/parse", requireAuth, requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rawText = typeof (req.body as { rawText?: unknown }).rawText === "string" ? (req.body as { rawText: string }).rawText : "";
  const text = rawText.trim().slice(0, 12000);
  if (!text) { res.status(400).json({ error: "Cole a lista de aparelhos" }); return; }

  const prompt = [
    `Você organiza listas de fornecedores de celulares (mercado brasileiro) em dados estruturados.`,
    `Cada linha ou bloco da lista abaixo descreve um aparelho: modelo, armazenamento, cor(es) e preço de CUSTO (preço do fornecedor pra loja, não o preço de venda ao cliente final).`,
    `Ignore emojis, cabeçalhos, informações de garantia/contato/endereço — extraia SÓ os aparelhos.`,
    ``,
    `Lista:`,
    text,
    ``,
    `Responda SOMENTE com um JSON array válido, sem markdown, um objeto por aparelho, neste formato:`,
    `[{"model":"iPhone 15 Pro Max","storage":"256GB","condition":"seminovo","colors":["Preto","Azul"],"costPrice":3850,"rawLine":"trecho original correspondente"}]`,
    `"condition" deve ser um destes: lacrado, seminovo, cpo, usado (use "seminovo" se não estiver claro).`,
    `Se não conseguir identificar o modelo ou o preço com confiança, ainda inclua o item com o que conseguir e deixe o campo faltante null.`,
  ].join("\n");

  try {
    const { getOpenAiClientForTenant } = await import("../lib/aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const arr = extractJsonArray(raw);
    if (!arr) { res.status(502).json({ error: "A IA não retornou uma lista válida. Tente novamente." }); return; }

    const items: ParsedItem[] = arr.slice(0, 200).map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const model = clean(o.model, 120);
      const costPrice = toNumberOrNull(o.costPrice);
      const missing = !model || costPrice == null;
      return {
        model: model || "(modelo não identificado)",
        storage: clean(o.storage, 40) || null,
        condition: cleanCondition(o.condition),
        colors: cleanColors(o.colors),
        costPrice,
        status: missing ? "pending" : "approved",
        issue: missing ? (!model ? "Modelo não identificado" : "Preço não identificado") : null,
        rawLine: clean(o.rawLine, 300),
      };
    });
    res.json({ items });
  } catch (err) {
    req.log.error({ err }, "Catalog AI import failed");
    res.status(503).json({ error: "A IA está indisponível no momento. Tente novamente em instantes." });
  }
});

router.post("/catalog/import/confirm", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const items = (req.body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "Nenhum item para importar" }); return; }

  const settings = await getPricingSettings(tenantId);
  const toInsert = items.slice(0, 200).map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const model = clean(o.model, 120);
    const costPrice = toNumberOrNull(o.costPrice);
    const marginPercentOverride = toNumberOrNull(o.marginPercentOverride);
    const salePrice = "salePrice" in o
      ? toNumberOrNull(o.salePrice)
      : (costPrice != null ? precoVendaDoProduto({ costPrice, costIncludesInvoice: false, marginPercentOverride }, settings) : null);
    return {
      tenantId,
      model: model || "(sem modelo)",
      storage: clean(o.storage, 40) || null,
      condition: cleanCondition(o.condition),
      colors: cleanColors(o.colors),
      costPrice: costPrice != null ? String(costPrice) : null,
      marginPercentOverride: marginPercentOverride != null ? String(marginPercentOverride) : null,
      salePrice: salePrice != null ? String(salePrice) : null,
      createdBy: req.session.userId ?? null,
    };
  }).filter((p) => p.model !== "(sem modelo)");

  if (toInsert.length === 0) { res.status(400).json({ error: "Nenhum item válido para importar" }); return; }
  const inserted = await db.insert(catalogProductsTable).values(toInsert).returning();
  res.status(201).json({ imported: inserted.length, products: inserted });
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
  const photos = await photosByProductIds(tenant.id, rows.map((r) => r.id));
  res.json({
    storeName: tenant.name,
    whatsapp: tenant.contactPhone ?? null,
    // Nunca expõe custo/margem — só o que o cliente final pode ver.
    products: rows.map((r) => ({
      id: r.id,
      model: r.model,
      storage: r.storage,
      condition: r.condition,
      colors: r.colors,
      description: r.description,
      salePrice: r.salePrice,
      inStock: r.stockQty > 0,
      photos: (photos.get(r.id) ?? []).map((p) => p.id),
    })),
  });
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
