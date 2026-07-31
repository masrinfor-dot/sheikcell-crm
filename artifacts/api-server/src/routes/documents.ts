import { Router, type IRouter, type Request, type Response } from "express";
import { db, documentsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor } from "../middlewares/auth";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";

const router: IRouter = Router();

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

// ─── Listar documentos ───────────────────────────────────────────────────────
router.get("/documents", requireAuth, async (_req, res): Promise<void> => {
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
    .orderBy(desc(documentsTable.createdAt));
  res.json(rows);
});

// ─── Enviar documento (base64, como as mídias do chat) ──────────────────────
router.post("/documents", requireAdminOrSupervisor, async (req, res): Promise<void> => {
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
  if (buf.length > MAX_SIZE) { res.status(400).json({ error: "Arquivo muito grande (máximo 15MB)" }); return; }

  await mkdir(DOCS_DIR, { recursive: true });
  const storedName = `${randomUUID()}.${ext}`;
  await writeFile(path.join(DOCS_DIR, storedName), buf);

  const [doc] = await db.insert(documentsTable).values({
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
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  const filepath = path.join(DOCS_DIR, path.basename(doc.storedName));
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado no servidor" }); return; }
  res.setHeader("Content-Type", doc.mimeType);
  // "inline" deixa o navegador abrir PDF/imagem direto; download continua possível.
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.fileName)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filepath);
});

// ─── Excluir documento ───────────────────────────────────────────────────────
router.delete("/documents/:id", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  await db.delete(documentsTable).where(eq(documentsTable.id, id));
  const filepath = path.join(DOCS_DIR, path.basename(doc.storedName));
  if (existsSync(filepath)) { await unlink(filepath).catch(() => {}); }
  res.json({ ok: true });
});

export default router;
