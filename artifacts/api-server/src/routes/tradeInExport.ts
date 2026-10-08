// Avaliação de usados vai para o ERP (07/10/2026: "somente no ERP vai ter a
// avaliação de usados"). Aqui:
// - GET /trade-in/export (admin): JSON (versão 1, kind "trade-in") com TODAS
//   as avaliações (balcão, vitrine e robô), compras fechadas, configuração e
//   tabela de valores. O ERP importa em Avaliação de usados › Importar do CRM.
//   Fotos vão por link TEMPORÁRIO assinado (72h) — são documentos de cliente,
//   nunca ficam públicas de vez.
// - GET/PUT /trade-in/moved: o admin desliga a avaliação aqui depois de
//   importar; a tela passa a apontar pro ERP e o robô para de avaliar.
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "fs";
import path from "path";
import { desc, eq } from "drizzle-orm";
import { db, tradeInBaseValuesTable, tradeInEvaluationsTable, usersTable, tenantsTable } from "@workspace/db";
import { requireAdmin, requireAuth, requireTenant } from "../middlewares/auth";
import { getMargins, getQuestionsConfig } from "../lib/tradeInConfig";
import { getEvalLimitConfig } from "../lib/tradeInEvalLimit";
import { PAYMENT_METHODS_KEY, DEFAULT_PAYMENT_METHODS, sanitizePaymentMethods } from "../lib/tradeInPaymentMethods";
import { MEDIA_DIR } from "../lib/whatsappInbound";
import {
  TRADE_IN_ERP_URL_KEY as ERP_URL_KEY, TRADE_IN_MOVED_KEY as MOVED_KEY, appSetting as setting, saveAppSetting as saveSetting, tradeInMovedToErp,
} from "../lib/tradeInMoved";

const router: IRouter = Router();
export const tradeInExportPublicRouter: IRouter = Router();

const PHOTO_TTL_MS = 72 * 3600_000;

// ─── Link assinado das fotos ─────────────────────────────────────────────

function signingKey(): string {
  return createHmac("sha256", process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret").update("trade-in-export-v1").digest("hex");
}

export function signExportPhoto(filename: string, nowMs = Date.now()): { exp: number; sig: string } {
  const exp = Math.floor((nowMs + PHOTO_TTL_MS) / 1000);
  return { exp, sig: createHmac("sha256", signingKey()).update(`${filename}.${exp}`).digest("hex") };
}

export function verifyExportPhoto(filename: string, exp: number, sig: string, nowMs = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const expected = createHmac("sha256", signingKey()).update(`${filename}.${exp}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function publicBaseUrl(req: Request): string {
  const configured = process.env["PUBLIC_API_URL"]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}/api`;
}

/** "/api/chat/media/abc.jpg" → link assinado público que o ERP consegue baixar. */
export function exportPhotoUrl(base: string, mediaUrl: string, nowMs = Date.now()): string | null {
  const file = path.basename(mediaUrl || "");
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return null;
  const { exp, sig } = signExportPhoto(file, nowMs);
  return `${base}/trade-in-export/photo/${encodeURIComponent(file)}?exp=${exp}&sig=${sig}`;
}

// ─── Desligado no CRM? ───────────────────────────────────────────────────

/** Bloqueia avaliar/fechar no CRM depois que a loja passou a avaliação pro ERP. */
export async function blockWhenMovedToErp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = req.session?.tenantId;
  if (typeof tenantId === "number" && (await tradeInMovedToErp(tenantId))) {
    res.status(410).json({ error: "A avaliação de usados agora é feita no ERP." });
    return;
  }
  next();
}

router.get("/trade-in/moved", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json({ moved: await tradeInMovedToErp(tenantId), erpUrl: (await setting(tenantId, ERP_URL_KEY)) ?? "" });
});

router.put("/trade-in/moved", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { moved, erpUrl } = req.body as { moved?: boolean; erpUrl?: string };
  const url = typeof erpUrl === "string" ? erpUrl.trim().slice(0, 300) : undefined;
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) { res.status(400).json({ error: "Endereço do ERP inválido (comece com https://)" }); return; }
  if (moved !== undefined) await saveSetting(tenantId, MOVED_KEY, moved ? "true" : "false");
  if (url !== undefined) await saveSetting(tenantId, ERP_URL_KEY, url);
  res.json({ moved: await tradeInMovedToErp(tenantId), erpUrl: (await setting(tenantId, ERP_URL_KEY)) ?? "" });
});

// ─── Exportação ──────────────────────────────────────────────────────────

router.get("/trade-in/export", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId)).limit(1);
  const base = publicBaseUrl(req);
  const now = Date.now();
  const photos = (list: string[] | null | undefined) =>
    (list ?? []).map((u) => exportPhotoUrl(base, u, now)).filter((u): u is string => !!u);

  const [margins, questions, evalLimit, paymentRaw, baseValues, rows] = await Promise.all([
    getMargins(tenantId),
    getQuestionsConfig(tenantId),
    getEvalLimitConfig(tenantId),
    setting(tenantId, PAYMENT_METHODS_KEY),
    db.select().from(tradeInBaseValuesTable).where(eq(tradeInBaseValuesTable.tenantId, tenantId)),
    db.select({ e: tradeInEvaluationsTable, userName: usersTable.name })
      .from(tradeInEvaluationsTable)
      .leftJoin(usersTable, eq(tradeInEvaluationsTable.userId, usersTable.id))
      .where(eq(tradeInEvaluationsTable.tenantId, tenantId))
      .orderBy(desc(tradeInEvaluationsTable.createdAt)),
  ]);
  let paymentMethods: string[] = DEFAULT_PAYMENT_METHODS;
  if (paymentRaw) {
    try { paymentMethods = sanitizePaymentMethods(JSON.parse(paymentRaw)).methods ?? DEFAULT_PAYMENT_METHODS; } catch { /* padrão */ }
  }

  const payload = {
    version: 1,
    kind: "trade-in",
    source: "sheikcell-crm",
    exportedAt: new Date(now).toISOString(),
    photosValidUntil: new Date(now + PHOTO_TTL_MS).toISOString(),
    tenant: tenant ?? { id: tenantId, name: null },
    settings: { margins, questions, paymentMethods, evalLimit },
    baseValues: baseValues.map((b) => ({ id: b.id, brand: b.brand, model: b.model, storage: b.storage, baseValue: Number(b.baseValue) })),
    evaluations: rows.map(({ e, userName }) => ({
      id: e.id,
      source: e.source,
      userName: userName ?? null,
      customerName: e.customerName,
      device: e.device,
      brand: e.brand,
      model: e.model,
      memory: e.memory,
      color: e.color,
      answers: e.answers,
      marketPrice: e.marketPrice,
      suggestedPrice: e.suggestedPrice,
      aiSummary: e.aiSummary,
      wantedProduct: e.wantedProduct,
      createdAt: e.createdAt,
      closedAt: e.closedAt,
      storeName: e.storeName,
      sellerCustomerName: e.sellerCustomerName,
      sellerCpf: e.sellerCpf,
      sellerRg: e.sellerRg,
      sellerAddress: e.sellerAddress,
      sellerNeighborhood: e.sellerNeighborhood,
      sellerPhone: e.sellerPhone,
      imei: e.imei,
      finalAgreedPrice: e.finalAgreedPrice,
      paymentMethod: e.paymentMethod,
      pixKey: e.pixKey,
      pixKeyHolder: e.pixKeyHolder,
      documentPhotos: photos(e.documentPhotos),
      devicePhotos: photos(e.devicePhotos),
      paymentProofPhotos: photos(e.paymentProofPhotos),
    })),
  };
  res.setHeader("Content-Disposition", `attachment; filename="avaliacoes-usados-${new Date(now).toISOString().slice(0, 10)}.json"`);
  res.json(payload);
});

// Foto por link assinado (só pro ERP baixar na importação). Sem assinatura
// válida e dentro do prazo, 404.
tradeInExportPublicRouter.get("/trade-in-export/photo/:file", (req: Request, res: Response): void => {
  const file = path.basename(String(req.params.file ?? ""));
  const exp = Number(req.query["exp"]);
  const sig = typeof req.query["sig"] === "string" ? req.query["sig"] : "";
  if (!verifyExportPhoto(file, exp, sig)) { res.status(404).end(); return; }
  const filepath = path.join(MEDIA_DIR, file);
  if (!existsSync(filepath)) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(filepath);
});

export default router;
