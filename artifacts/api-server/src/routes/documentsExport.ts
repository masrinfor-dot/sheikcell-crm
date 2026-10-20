// Documentos da loja vão para o ERP (17/10/2026). Aqui:
// - GET /documents/export (admin): JSON (versão 1, kind "documents") com
//   todos os documentos da loja. O ERP importa em Documentos da loja ›
//   Importar do CRM. Cada arquivo vai por link TEMPORÁRIO assinado (72h) —
//   contratos e atas nunca ficam públicos de vez. `crmApiUrl` diz ao ERP de
//   onde ele pode baixar (o ERP recusa link de outro endereço).
// - GET/PUT /documents/moved: o admin desliga o envio/exclusão aqui depois de
//   importar; a tela passa a apontar pro ERP e fica só consulta.
import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "fs";
import path from "path";
import { desc, eq } from "drizzle-orm";
import { db, documentsTable, usersTable, tenantsTable } from "@workspace/db";
import { requireAdmin, requireAuth, requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { appSetting as setting, saveAppSetting as saveSetting } from "../lib/tradeInMoved";
import { DOCUMENTS_ERP_URL_KEY as ERP_URL_KEY, DOCUMENTS_MOVED_KEY as MOVED_KEY, documentsMovedToErp } from "../lib/documentsMoved";
import { DOCS_DIR } from "./documents";

const router: IRouter = Router();
export const documentsExportPublicRouter: IRouter = Router();

const FILE_TTL_MS = 72 * 3600_000;

// ─── Link assinado dos arquivos ──────────────────────────────────────────

function signingKey(): string {
  return createHmac("sha256", process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret").update("documents-export-v1").digest("hex");
}

export function signExportDocument(id: number, nowMs = Date.now()): { exp: number; sig: string } {
  const exp = Math.floor((nowMs + FILE_TTL_MS) / 1000);
  return { exp, sig: createHmac("sha256", signingKey()).update(`doc.${id}.${exp}`).digest("hex") };
}

export function verifyExportDocument(id: number, exp: number, sig: string, nowMs = Date.now()): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  const expected = createHmac("sha256", signingKey()).update(`doc.${id}.${exp}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function exportDocumentUrl(base: string, id: number, nowMs = Date.now()): string {
  const { exp, sig } = signExportDocument(id, nowMs);
  return `${base}/documents-export/file/${id}?exp=${exp}&sig=${sig}`;
}

function publicBaseUrl(req: Request): string {
  const configured = process.env["PUBLIC_API_URL"]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}/api`;
}

// ─── Desligado no CRM? (o bloqueio de enviar/excluir fica em documents.ts) ─

router.get("/documents/moved", requireModuleAccess("documentos"), requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json({ moved: await documentsMovedToErp(tenantId), erpUrl: (await setting(tenantId, ERP_URL_KEY)) ?? "" });
});

router.put("/documents/moved", requireModuleAccess("documentos"), requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { moved, erpUrl } = req.body as { moved?: boolean; erpUrl?: string };
  const url = typeof erpUrl === "string" ? erpUrl.trim().slice(0, 300) : undefined;
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) { res.status(400).json({ error: "Endereço do ERP inválido (comece com https://)" }); return; }
  if (moved !== undefined) await saveSetting(tenantId, MOVED_KEY, moved ? "true" : "false");
  if (url !== undefined) await saveSetting(tenantId, ERP_URL_KEY, url);
  res.json({ moved: await documentsMovedToErp(tenantId), erpUrl: (await setting(tenantId, ERP_URL_KEY)) ?? "" });
});

// ─── Exportação ──────────────────────────────────────────────────────────

router.get("/documents/export", requireModuleAccess("documentos"), requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [tenant] = await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId)).limit(1);
  const base = publicBaseUrl(req);
  const now = Date.now();
  const rows = await db
    .select({ d: documentsTable, userName: usersTable.name, userEmail: usersTable.email })
    .from(documentsTable)
    .leftJoin(usersTable, eq(documentsTable.uploadedBy, usersTable.id))
    .where(eq(documentsTable.tenantId, tenantId))
    .orderBy(desc(documentsTable.createdAt));

  const payload = {
    version: 1,
    kind: "documents",
    source: "sheikcell-crm",
    exportedAt: new Date(now).toISOString(),
    filesValidUntil: new Date(now + FILE_TTL_MS).toISOString(),
    crmApiUrl: base,
    tenant: tenant ?? { id: tenantId, name: null },
    documents: rows.map(({ d, userName, userEmail }) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      // "notes" (e não "description"): no ERP, "description" vira CAIXA ALTA.
      notes: d.description,
      fileName: d.fileName,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      uploadedByName: userName ?? null,
      uploadedByEmail: userEmail ?? null,
      createdAt: d.createdAt,
      fileUrl: exportDocumentUrl(base, d.id, now),
    })),
  };
  // Trocas com o ERP: o arquivo baixado para o ERP entra no histórico (só a contagem).
  void import("../lib/erpExchanges").then((m) => m.recordErpExchange({
    tenantId, method: "FILE", path: "/documents/export", httpStatus: 200, ok: true, durationMs: 0,
    itemCount: payload.documents.length,
  })).catch(() => {});
  res.setHeader("Content-Disposition", `attachment; filename="documentos-${new Date(now).toISOString().slice(0, 10)}.json"`);
  res.json(payload);
});

// Arquivo por link assinado (só pro ERP baixar na importação). Sem assinatura
// válida e dentro do prazo, 404.
documentsExportPublicRouter.get("/documents-export/file/:id", async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const exp = Number(req.query["exp"]);
  const sig = typeof req.query["sig"] === "string" ? req.query["sig"] : "";
  if (!verifyExportDocument(id, exp, sig)) { res.status(404).end(); return; }
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id)).limit(1);
  if (!doc) { res.status(404).end(); return; }
  const filepath = path.join(DOCS_DIR, path.basename(doc.storedName));
  if (!existsSync(filepath)) { res.status(404).end(); return; }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(filepath);
});

export default router;
