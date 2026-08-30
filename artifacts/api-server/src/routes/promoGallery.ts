import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import { eq, and, desc } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db, promoItemsTable } from "@workspace/db";
import { requireAuth, requireAdminOrSupervisor, requireTenant, requireModule } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
// Exige o módulo contratado pela loja (teto por tenant, ver requireModule).
// Diferente da Vitrine (requireModuleAccess, view/edit por usuário), aqui é
// regra fixa por PAPEL: qualquer um do módulo pode ver/enviar, só
// admin/supervisor cadastra/apaga (pedido explícito do lojista) — ver os
// middlewares aplicados em cada rota abaixo.
router.use("/promo-gallery", requireModule("promocoes"));

// Fotos do banco de promoções ficam numa pasta própria, separada de mídia do
// WhatsApp/documentos/vitrine — mesmo cuidado já diagnosticado antes (ver
// whatsappInbound.ts, documents.ts, catalog.ts): em produção defina
// PROMO_MEDIA_DIR com o caminho absoluto de um volume JÁ persistente no
// serviço "api" do EasyPanel. Por padrão usa uma subpasta dentro do volume
// api-media (que já existe e já está confirmado funcionando em produção),
// evitando depender de configurar mais um volume novo.
export const PROMO_MEDIA_DIR = process.env["PROMO_MEDIA_DIR"]
  ? path.resolve(process.env["PROMO_MEDIA_DIR"])
  : path.resolve(process.cwd(), "media", "promocoes");

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

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.normalize("NFC").trim().slice(0, max) : "";

// ─── Listar ──────────────────────────────────────────────────────────────
// Qualquer usuário autenticado do módulo vê a galeria inteira — é quem vai
// usar pra mandar no Atendimento, não só quem cadastra.
router.get("/promo-gallery", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(promoItemsTable)
    .where(eq(promoItemsTable.tenantId, tenantId))
    .orderBy(desc(promoItemsTable.sortOrder), desc(promoItemsTable.createdAt));
  res.json(rows);
});

// ─── Cadastrar ───────────────────────────────────────────────────────────
// Só admin/supervisor (pedido explícito: vendedor só usa, não cadastra).
router.post("/promo-gallery", requireAdminOrSupervisor, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { title, mimeType, data } = req.body as { title?: string; mimeType?: string; data?: string };
  const cleanTitle = clean(title, 150);
  if (!cleanTitle) { res.status(400).json({ error: "Informe um título/legenda" }); return; }
  const mime = typeof mimeType === "string" ? mimeType.split(";")[0].trim() : "";
  const ext = PHOTO_MIME[mime];
  if (!ext) { res.status(400).json({ error: "Formato não permitido. Use JPEG, PNG ou WEBP." }); return; }
  if (typeof data !== "string" || !data) { res.status(400).json({ error: "Imagem vazia" }); return; }

  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) { res.status(400).json({ error: "Imagem vazia" }); return; }
  if (!photoContentMatchesMime(buf, mime)) { res.status(400).json({ error: "O conteúdo do arquivo não corresponde ao tipo informado" }); return; }
  if (buf.length > MAX_PHOTO_SIZE) { res.status(400).json({ error: "Imagem muito grande (máximo 8MB)" }); return; }

  await mkdir(PROMO_MEDIA_DIR, { recursive: true });
  const storedName = `${randomUUID()}.${ext}`;
  await writeFile(path.join(PROMO_MEDIA_DIR, storedName), buf);

  const [item] = await db.insert(promoItemsTable).values({
    tenantId,
    title: cleanTitle,
    storedName,
    createdBy: req.session.userId ?? null,
  }).returning();
  res.status(201).json(item);
});

// ─── Cadastrar em lote ───────────────────────────────────────────────────
// Pedido do lojista: cadastrar várias promoções de uma vez (várias fotos
// selecionadas juntas), com opção de trazer os títulos de uma planilha Excel
// em vez de digitar um por um. A planilha é só um jeito de dar título — as
// fotos em si sempre vêm no mesmo request, em base64 (mesmo formato do
// cadastro individual acima).
//
// Normaliza um cabeçalho de coluna pra comparar sem se importar com acento/
// maiúscula (ex.: "Título", "titulo", "TÍTULO" tudo bate igual).
function normalizeHeader(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

// Lê a primeira aba da planilha e monta um mapa "nome do arquivo" -> "título",
// aceitando várias variações de nome de coluna (pt/en). Nunca lança: planilha
// mal formatada só faz o mapa sair vazio (as fotos ainda cadastram, só usam o
// nome do arquivo como título de fallback).
function parseTitlesSheet(buf: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return map;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName]!, { defval: "" });
    for (const row of rows) {
      let fileCol: string | null = null;
      let titleCol: string | null = null;
      for (const key of Object.keys(row)) {
        const norm = normalizeHeader(key);
        if (["arquivo", "foto", "imagem", "file", "filename"].includes(norm)) fileCol = key;
        if (["titulo", "título", "legenda", "title", "caption"].includes(norm)) titleCol = key;
      }
      if (!fileCol || !titleCol) continue;
      const filename = String(row[fileCol] ?? "").trim().toLowerCase();
      const title = String(row[titleCol] ?? "").trim();
      if (filename && title) map.set(filename, title);
    }
  } catch (err) {
    logger.warn({ err }, "Banco de promoções: falha ao ler planilha de títulos (ignorada)");
  }
  return map;
}

router.post("/promo-gallery/bulk", requireAdminOrSupervisor, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { items, titlesSheet } = req.body as {
    items?: { filename?: string; title?: string; mimeType?: string; data?: string }[];
    titlesSheet?: string; // planilha .xlsx em base64 (opcional)
  };
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "Nenhuma foto selecionada" }); return; }
  if (items.length > 60) { res.status(400).json({ error: "Máximo de 60 fotos por vez" }); return; }

  const titleMap = titlesSheet ? parseTitlesSheet(Buffer.from(titlesSheet, "base64")) : new Map<string, string>();

  await mkdir(PROMO_MEDIA_DIR, { recursive: true });
  const created: (typeof promoItemsTable.$inferSelect)[] = [];
  const failed: { filename: string; error: string }[] = [];

  for (const it of items) {
    const originalName = clean(it.filename, 200) || "arquivo";
    try {
      const mime = typeof it.mimeType === "string" ? it.mimeType.split(";")[0].trim() : "";
      const ext = PHOTO_MIME[mime];
      if (!ext) { failed.push({ filename: originalName, error: "Formato não permitido (use JPEG, PNG ou WEBP)" }); continue; }
      if (typeof it.data !== "string" || !it.data) { failed.push({ filename: originalName, error: "Imagem vazia" }); continue; }
      const buf = Buffer.from(it.data, "base64");
      if (buf.length === 0 || buf.length > MAX_PHOTO_SIZE) { failed.push({ filename: originalName, error: "Imagem vazia ou maior que 8MB" }); continue; }
      if (!photoContentMatchesMime(buf, mime)) { failed.push({ filename: originalName, error: "Conteúdo não corresponde ao tipo informado" }); continue; }

      // Prioridade do título: o que o usuário digitou/editou na tela > o que
      // veio da planilha (casado pelo nome do arquivo) > nome do arquivo sem
      // extensão (nunca fica sem título nenhum).
      const fromSheet = titleMap.get(originalName.toLowerCase());
      const fallback = originalName.replace(/\.[^.]+$/, "");
      const finalTitle = clean(it.title, 150) || fromSheet || fallback;

      const storedName = `${randomUUID()}.${ext}`;
      await writeFile(path.join(PROMO_MEDIA_DIR, storedName), buf);
      const [item] = await db.insert(promoItemsTable).values({
        tenantId, title: finalTitle, storedName, createdBy: req.session.userId ?? null,
      }).returning();
      created.push(item);
    } catch (err) {
      logger.error({ err, filename: originalName }, "Banco de promoções: falha ao cadastrar item do lote");
      failed.push({ filename: originalName, error: "Falha inesperada ao salvar" });
    }
  }

  res.status(created.length > 0 ? 201 : 400).json({ created, failed });
});

// ─── Apagar ──────────────────────────────────────────────────────────────
router.delete("/promo-gallery/:id", requireAdminOrSupervisor, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  const [item] = await db.select().from(promoItemsTable)
    .where(and(eq(promoItemsTable.id, id), eq(promoItemsTable.tenantId, tenantId))).limit(1);
  if (!item) { res.status(404).json({ error: "Item não encontrado" }); return; }
  await db.delete(promoItemsTable).where(eq(promoItemsTable.id, id));
  const filepath = path.join(PROMO_MEDIA_DIR, path.basename(item.storedName));
  if (existsSync(filepath)) await unlink(filepath).catch(() => {});
  res.json({ ok: true });
});

// ─── Servir o arquivo ────────────────────────────────────────────────────
// Autenticado (diferente da vitrine pública) — a galeria é uso interno da
// equipe, nunca exposta a quem não tem login.
router.get("/promo-gallery/:id/file", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  const [item] = await db.select().from(promoItemsTable)
    .where(and(eq(promoItemsTable.id, id), eq(promoItemsTable.tenantId, tenantId))).limit(1);
  if (!item) { res.status(404).json({ error: "Item não encontrado" }); return; }
  const filepath = path.join(PROMO_MEDIA_DIR, path.basename(item.storedName));
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado no servidor" }); return; }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(filepath);
});

export default router;
