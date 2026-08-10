import { Router, type IRouter, type Request, type Response } from "express";
import { db, documentsTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor, requireTenant, requireModule } from "../middlewares/auth";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";

const router: IRouter = Router();
router.use("/documents", requireModule("documentos"));

// Documentos ficam separados das mídias do WhatsApp.
export const DOCS_DIR = path.resolve(process.cwd(), "documents");

const CATEGORIES = ["ata", "documento", "comunicado", "contrato"];

// Tipos aceitos: documentos de escritório, PDF e imagens (foto de ata assinada).
const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_SIZE = 15 * 1024 * 1024; // 15MB

// Só PDF e imagens verificadas abrem direto no navegador; o resto baixa.
const INLINE_SAFE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

// Valida a assinatura (magic bytes) contra o MIME declarado.
function contentMatchesMime(buf: Buffer, mime: string): boolean {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => buf[offset + i] === b);
  switch (mime) {
    case "application/pdf": return startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
    case "image/jpeg": return startsWith([0xff, 0xd8, 0xff]);
    case "image/png": return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/webp": return startsWith([0x52, 0x49, 0x46, 0x46]) && buf.length > 11 && buf.toString("ascii", 8, 12) === "WEBP";
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      return startsWith([0xd0, 0xcf, 0x11, 0xe0]); // OLE2
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return startsWith([0x50, 0x4b]); // ZIP
    case "text/plain": {
      // Precisa ser UTF-8 válido e sem cara de HTML/SVG.
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, 64 * 1024)); } catch { return false; }
      return !/<\s*(script|svg|html|iframe|!doctype)/i.test(text);
    }
    default: return false;
  }
}

// ─── Listar documentos ───────────────────────────────────────────────────────
router.get("/documents", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      category: documentsTable.category,
      description: documentsTable.description,
      fileName: documentsTable.fileName,
      mimeType: documentsTable.mimeType,
      sizeBytes: documentsTable.sizeBytes,
      createdAt: documentsTable.createdAt,
      uploadedBy: documentsTable.uploadedBy,
      uploaderName: usersTable.name,
    })
    .from(documentsTable)
    .leftJoin(usersTable, eq(documentsTable.uploadedBy, usersTable.id))
    .where(eq(documentsTable.tenantId, tenantId))
    .orderBy(desc(documentsTable.createdAt));
  res.json(rows);
});

// ─── Enviar documento (base64, como as mídias do chat) ──────────────────────
router.post("/documents", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { title, category, description, fileName, mimeType, data } = req.body ?? {};
  const cleanTitle = typeof title === "string" ? title.trim().slice(0, 200) : "";
  if (!cleanTitle) { res.status(400).json({ error: "Informe um título" }); return; }
  const cat = CATEGORIES.includes(category) ? category : "documento";
  const mime = typeof mimeType === "string" ? mimeType.split(";")[0].trim() : "";
  const ext = ALLOWED_MIME[mime];
  if (!ext) { res.status(400).json({ error: "Tipo de arquivo não permitido. Use PDF, Word, Excel, PowerPoint, texto ou imagem." }); return; }
  if (typeof data !== "string" || !data) { res.status(400).json({ error: "Arquivo vazio" }); return; }

  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) { res.status(400).json({ error: "Arquivo vazio" }); return; }
  // Confere a assinatura do arquivo: o tipo declarado precisa bater com o
  // conteúdo real (impede HTML/SVG disfarçado de imagem/PDF).
  if (!contentMatchesMime(buf, mime)) {
    res.status(400).json({ error: "O conteúdo do arquivo não corresponde ao tipo informado" });
    return;
  }
  if (buf.length > MAX_SIZE) { res.status(400).json({ error: "Arquivo muito grande (máximo 15MB)" }); return; }

  await mkdir(DOCS_DIR, { recursive: true });
  const storedName = `${randomUUID()}.${ext}`;
  await writeFile(path.join(DOCS_DIR, storedName), buf);

  const [doc] = await db.insert(documentsTable).values({
    tenantId,
    title: cleanTitle,
    category: cat,
    description: typeof description === "string" ? description.trim().slice(0, 1000) || null : null,
    fileName: typeof fileName === "string" && fileName.trim() ? fileName.trim().slice(0, 255) : `${cleanTitle}.${ext}`,
    storedName,
    mimeType: mime,
    sizeBytes: buf.length,
    uploadedBy: req.session.userId ?? null,
  }).returning();
  res.status(201).json(doc);
});

// ─── Baixar/visualizar arquivo ───────────────────────────────────────────────
router.get("/documents/:id/file", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [doc] = await db.select().from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.tenantId, tenantId)));
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  const filepath = path.join(DOCS_DIR, path.basename(doc.storedName));
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado no servidor" }); return; }
  res.setHeader("Content-Type", doc.mimeType);
  // PDF/imagem verificados abrem no navegador; os demais tipos sempre baixam.
  const disposition = INLINE_SAFE.has(doc.mimeType) ? "inline" : "attachment";
  res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(doc.fileName)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filepath);
});

// ─── Excluir documento ───────────────────────────────────────────────────────
router.delete("/documents/:id", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [doc] = await db.select().from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.tenantId, tenantId)));
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  await db.delete(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.tenantId, tenantId)));
  const filepath = path.join(DOCS_DIR, path.basename(doc.storedName));
  if (existsSync(filepath)) { await unlink(filepath).catch(() => {}); }
  res.json({ ok: true });
});

export default router;
