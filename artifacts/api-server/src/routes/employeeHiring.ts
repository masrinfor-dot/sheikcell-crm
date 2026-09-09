import { Router, type IRouter, type Request, type Response } from "express";
import {
  db, employeesTable, employeeDocumentsTable, employeeContractTemplatesTable,
  rhCandidatesTable, storesTable, workShiftsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";
import { normalizePhone } from "../lib/phone";
import { getEmployee, CONTRACT_TYPES } from "./rhDp";
import { DOCS_DIR } from "./documents";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";

const router: IRouter = Router();

// Mesmo volume persistente de DOCS_DIR (documents.ts) — só numa subpasta.
// Assim os arquivos do colaborador sobrevivem a redeploy igual aos
// documentos da loja, sem precisar configurar nenhum volume novo no
// EasyPanel (ver comentário de DOCS_DIR em documents.ts).
const EMPLOYEE_DOCS_DIR = path.join(DOCS_DIR, "colaboradores");

// Tipos aceitos pro banco de arquivos do colaborador: fotos e PDFs (RG,
// CPF, CTPS, comprovantes, ASO, contrato assinado escaneado etc.). Sem
// Word/Excel aqui — documento pessoal digitalizado é foto ou PDF.
const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_SIZE = 15 * 1024 * 1024; // 15MB
const INLINE_SAFE = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function contentMatchesMime(buf: Buffer, mime: string): boolean {
  const startsWith = (sig: number[]) => sig.every((b, i) => buf[i] === b);
  switch (mime) {
    case "application/pdf": return startsWith([0x25, 0x50, 0x44, 0x46]);
    case "image/jpeg": return startsWith([0xff, 0xd8, 0xff]);
    case "image/png": return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/webp": return startsWith([0x52, 0x49, 0x46, 0x46]) && buf.length > 11 && buf.toString("ascii", 8, 12) === "WEBP";
    default: return false;
  }
}

// Checklist sugerido pro admin (o front mostra estes rótulos) — mas o
// backend aceita qualquer docType em texto livre, pra não travar em cima
// de uma lista fixa (loja pode ter documento diferente pra pedir).
const KNOWN_DOC_TYPES = new Set([
  "foto_3x4", "rg", "cpf", "ctps", "comprovante_residencia", "titulo_eleitor",
  "pis_nit", "certidao_civil", "carteira_vacinacao", "exame_admissional",
  "reservista", "contrato_trabalho", "contrato_trabalho_assinado", "outro",
]);

function sanitizeDocType(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, 60);
  if (!t) return null;
  return t;
}

async function getEmployeeDocument(employeeId: number, docId: number, tenantId: number) {
  const [row] = await db.select().from(employeeDocumentsTable)
    .where(and(eq(employeeDocumentsTable.id, docId), eq(employeeDocumentsTable.employeeId, employeeId), eq(employeeDocumentsTable.tenantId, tenantId)));
  return row ?? null;
}

// ── Iniciar contratação ──────────────────────────────────────────────────
// A partir de um candidato aprovado (copia nome/telefone/e-mail/CPF/cargo),
// ou avulso (sem candidatura, só o nome). Cria o colaborador já com
// hiringStatus "em_contratacao" — clicar de novo no mesmo candidato não
// duplica: devolve o colaborador já criado antes pra essa candidatura.
router.post("/rh-dp/hiring/start", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;

  if (b.candidateId != null) {
    const candidateId = parseInt(String(b.candidateId), 10);
    if (isNaN(candidateId)) { res.status(400).json({ error: "Candidato inválido" }); return; }
    const [candidate] = await db.select().from(rhCandidatesTable)
      .where(and(eq(rhCandidatesTable.id, candidateId), eq(rhCandidatesTable.tenantId, tenantId)));
    if (!candidate) { res.status(404).json({ error: "Candidato não encontrado" }); return; }

    const [existing] = await db.select().from(employeesTable)
      .where(and(eq(employeesTable.candidateId, candidateId), eq(employeesTable.tenantId, tenantId)));
    if (existing) { res.json(existing); return; }

    const [created] = await db.insert(employeesTable).values({
      tenantId,
      candidateId,
      hiringStatus: "em_contratacao",
      name: candidate.name.slice(0, 120),
      phone: normalizePhone(candidate.phone) || null,
      email: candidate.email?.trim().slice(0, 120) || null,
      cpf: candidate.cpf?.trim().slice(0, 20) || null,
      role: candidate.positionName?.trim().slice(0, 80) || null,
    }).returning();
    res.status(201).json(created);
    return;
  }

  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  if (!name) { res.status(400).json({ error: "Informe o nome do colaborador" }); return; }
  const [created] = await db.insert(employeesTable).values({
    tenantId, name, hiringStatus: "em_contratacao",
  }).returning();
  res.status(201).json(created);
});

router.post("/rh-dp/employees/:id/finalize-hiring", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await getEmployee(id, tenantId);
  if (!existing) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const [updated] = await db.update(employeesTable).set({ hiringStatus: "ativo" })
    .where(and(eq(employeesTable.id, id), eq(employeesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

// Reabrir contratação (ex.: colaborador finalizado por engano, ou precisa
// completar documentação depois) — simétrico ao finalizar.
router.post("/rh-dp/employees/:id/reopen-hiring", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await getEmployee(id, tenantId);
  if (!existing) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const [updated] = await db.update(employeesTable).set({ hiringStatus: "em_contratacao" })
    .where(and(eq(employeesTable.id, id), eq(employeesTable.tenantId, tenantId))).returning();
  res.json(updated);
});

// ── Banco de arquivos do colaborador ─────────────────────────────────────
router.get("/rh-dp/employees/:id/documents", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await getEmployee(employeeId, tenantId);
  if (!existing) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const rows = await db.select({
    id: employeeDocumentsTable.id,
    employeeId: employeeDocumentsTable.employeeId,
    docType: employeeDocumentsTable.docType,
    label: employeeDocumentsTable.label,
    fileName: employeeDocumentsTable.fileName,
    mimeType: employeeDocumentsTable.mimeType,
    sizeBytes: employeeDocumentsTable.sizeBytes,
    textContent: employeeDocumentsTable.textContent,
    uploadedByUserId: employeeDocumentsTable.uploadedByUserId,
    createdAt: employeeDocumentsTable.createdAt,
  }).from(employeeDocumentsTable)
    .where(and(eq(employeeDocumentsTable.employeeId, employeeId), eq(employeeDocumentsTable.tenantId, tenantId)))
    .orderBy(desc(employeeDocumentsTable.createdAt));
  res.json(rows);
});

// Envia um arquivo (docType + data base64) OU um texto (docType + textContent,
// ex.: contrato gerado) — nunca os dois numa mesma chamada.
router.post("/rh-dp/employees/:id/documents", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const existing = await getEmployee(employeeId, tenantId);
  if (!existing) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const docType = sanitizeDocType(b.docType);
  if (!docType) { res.status(400).json({ error: "Informe o tipo do documento" }); return; }
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 120) || null : null;

  if (typeof b.textContent === "string" && b.textContent.trim()) {
    const [created] = await db.insert(employeeDocumentsTable).values({
      tenantId, employeeId, docType, label,
      textContent: b.textContent.slice(0, 50_000),
      uploadedByUserId: req.session.userId ?? null,
    }).returning();
    res.status(201).json(created);
    return;
  }

  const { data, mimeType, fileName } = b as { data?: unknown; mimeType?: unknown; fileName?: unknown };
  const mime = typeof mimeType === "string" ? mimeType.split(";")[0].trim() : "";
  const ext = ALLOWED_MIME[mime];
  if (!ext) { res.status(400).json({ error: "Tipo de arquivo não permitido. Use foto (JPG/PNG/WEBP) ou PDF." }); return; }
  if (typeof data !== "string" || !data) { res.status(400).json({ error: "Arquivo vazio" }); return; }
  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) { res.status(400).json({ error: "Arquivo vazio" }); return; }
  if (!contentMatchesMime(buf, mime)) { res.status(400).json({ error: "O conteúdo do arquivo não corresponde ao tipo informado" }); return; }
  if (buf.length > MAX_SIZE) { res.status(400).json({ error: "Arquivo muito grande (máximo 15MB)" }); return; }

  await mkdir(EMPLOYEE_DOCS_DIR, { recursive: true });
  const storedName = `${randomUUID()}.${ext}`;
  await writeFile(path.join(EMPLOYEE_DOCS_DIR, storedName), buf);

  const [created] = await db.insert(employeeDocumentsTable).values({
    tenantId, employeeId, docType, label,
    fileName: typeof fileName === "string" && fileName.trim() ? fileName.trim().slice(0, 255) : `${docType}.${ext}`,
    mimeType: mime, storedName, sizeBytes: buf.length,
    uploadedByUserId: req.session.userId ?? null,
  }).returning();
  res.status(201).json(created);
});

// Edita rótulo e/ou o texto (só faz sentido pra linha de texto, ex.: editar
// o contrato antes de finalizar) — nunca troca o arquivo em si (exclua e
// suba de novo pra isso).
router.patch("/rh-dp/employees/:id/documents/:docId", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  if (isNaN(employeeId) || isNaN(docId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const doc = await getEmployeeDocument(employeeId, docId, tenantId);
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  if ("label" in b) update.label = typeof b.label === "string" ? b.label.trim().slice(0, 120) || null : null;
  if ("textContent" in b) {
    if (doc.storedName) { res.status(400).json({ error: "Este documento é um arquivo — não é possível editar o texto" }); return; }
    update.textContent = typeof b.textContent === "string" ? b.textContent.slice(0, 50_000) : null;
  }
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(employeeDocumentsTable).set(update)
    .where(and(eq(employeeDocumentsTable.id, docId), eq(employeeDocumentsTable.tenantId, tenantId))).returning();
  res.json(updated);
});

router.get("/rh-dp/employees/:id/documents/:docId/file", requireModuleAccess("rh"), async (req: Request, res: Response): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  if (isNaN(employeeId) || isNaN(docId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const doc = await getEmployeeDocument(employeeId, docId, tenantId);
  if (!doc || !doc.storedName || !doc.mimeType) { res.status(404).json({ error: "Arquivo não encontrado" }); return; }
  const filepath = path.join(EMPLOYEE_DOCS_DIR, path.basename(doc.storedName));
  if (!existsSync(filepath)) { res.status(404).json({ error: "Arquivo não encontrado no servidor" }); return; }
  res.setHeader("Content-Type", doc.mimeType);
  const disposition = INLINE_SAFE.has(doc.mimeType) ? "inline" : "attachment";
  res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(doc.fileName ?? doc.storedName)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filepath);
});

router.delete("/rh-dp/employees/:id/documents/:docId", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  if (isNaN(employeeId) || isNaN(docId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const doc = await getEmployeeDocument(employeeId, docId, tenantId);
  if (!doc) { res.status(404).json({ error: "Documento não encontrado" }); return; }
  await db.delete(employeeDocumentsTable).where(and(eq(employeeDocumentsTable.id, docId), eq(employeeDocumentsTable.tenantId, tenantId)));
  if (doc.storedName) {
    const filepath = path.join(EMPLOYEE_DOCS_DIR, path.basename(doc.storedName));
    if (existsSync(filepath)) { await unlink(filepath).catch(() => {}); }
  }
  res.json({ ok: true });
});

// ── Modelos de contrato de trabalho (personalizáveis) ────────────────────
router.get("/rh-dp/contract-templates", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(employeeContractTemplatesTable)
    .where(eq(employeeContractTemplatesTable.tenantId, tenantId))
    .orderBy(desc(employeeContractTemplatesTable.isDefault), employeeContractTemplatesTable.name);
  res.json(rows);
});

router.post("/rh-dp/contract-templates", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  if (!name) { res.status(400).json({ error: "Dê um nome ao modelo" }); return; }
  const bodyText = typeof b.bodyText === "string" ? b.bodyText.trim() : "";
  if (!bodyText) { res.status(400).json({ error: "O texto do contrato não pode ficar vazio" }); return; }
  const contractType = typeof b.contractType === "string" && CONTRACT_TYPES.includes(b.contractType as typeof CONTRACT_TYPES[number]) ? b.contractType : null;
  const isDefault = b.isDefault === true;
  if (isDefault) {
    await db.update(employeeContractTemplatesTable).set({ isDefault: false }).where(eq(employeeContractTemplatesTable.tenantId, tenantId));
  }
  const [created] = await db.insert(employeeContractTemplatesTable).values({
    tenantId, name, contractType, bodyText: bodyText.slice(0, 50_000), isDefault,
  }).returning();
  res.status(201).json(created);
});

router.patch("/rh-dp/contract-templates/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  if (typeof b.name === "string") {
    const name = b.name.trim().slice(0, 120);
    if (!name) { res.status(400).json({ error: "Nome não pode ficar vazio" }); return; }
    update.name = name;
  }
  if (typeof b.bodyText === "string") {
    const bodyText = b.bodyText.trim();
    if (!bodyText) { res.status(400).json({ error: "O texto do contrato não pode ficar vazio" }); return; }
    update.bodyText = bodyText.slice(0, 50_000);
  }
  if ("contractType" in b) {
    update.contractType = typeof b.contractType === "string" && CONTRACT_TYPES.includes(b.contractType as typeof CONTRACT_TYPES[number]) ? b.contractType : null;
  }
  if (b.isDefault === true) {
    await db.update(employeeContractTemplatesTable).set({ isDefault: false }).where(eq(employeeContractTemplatesTable.tenantId, tenantId));
    update.isDefault = true;
  } else if (b.isDefault === false) {
    update.isDefault = false;
  }
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(employeeContractTemplatesTable).set(update)
    .where(and(eq(employeeContractTemplatesTable.id, id), eq(employeeContractTemplatesTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Modelo não encontrado" }); return; }
  res.json(updated);
});

router.delete("/rh-dp/contract-templates/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(employeeContractTemplatesTable)
    .where(and(eq(employeeContractTemplatesTable.id, id), eq(employeeContractTemplatesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

// Placeholders substituídos ao gerar o contrato de um colaborador (usado
// pelo frontend pra montar o texto final antes de salvar como documento).
router.get("/rh-dp/employees/:id/contract-preview", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const employeeId = parseInt(String(req.params.id), 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: "ID inválido" }); return; }
  const templateId = parseInt(String(req.query.templateId ?? ""), 10);
  if (isNaN(templateId)) { res.status(400).json({ error: "Informe o modelo" }); return; }

  const emp = await getEmployee(employeeId, tenantId);
  if (!emp) { res.status(404).json({ error: "Colaborador não encontrado" }); return; }
  const [template] = await db.select().from(employeeContractTemplatesTable)
    .where(and(eq(employeeContractTemplatesTable.id, templateId), eq(employeeContractTemplatesTable.tenantId, tenantId)));
  if (!template) { res.status(404).json({ error: "Modelo não encontrado" }); return; }

  let storeName: string | null = null;
  if (emp.storeId != null) {
    const [store] = await db.select({ name: storesTable.name }).from(storesTable).where(eq(storesTable.id, emp.storeId));
    storeName = store?.name ?? null;
  }
  let shiftName: string | null = null;
  if (emp.shiftId != null) {
    const [shift] = await db.select({ name: workShiftsTable.name }).from(workShiftsTable).where(eq(workShiftsTable.id, emp.shiftId));
    shiftName = shift?.name ?? null;
  }
  const salario = emp.salaryCents != null ? (emp.salaryCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "";
  const admissao = emp.admissionDate ? new Date(`${emp.admissionDate}T00:00:00`).toLocaleDateString("pt-BR") : "";
  const contractTypeLabel: Record<string, string> = { clt: "CLT", pj: "PJ", estagio: "Estágio" };

  const values: Record<string, string> = {
    nome: emp.name ?? "", cpf: emp.cpf ?? "", rg: emp.rg ?? "",
    cargo: emp.role ?? "", funcao: emp.jobFunction ?? "",
    salario, admissao, escala: shiftName ?? "", loja: storeName ?? "",
    tipo_contrato: emp.contractType ? contractTypeLabel[emp.contractType] ?? emp.contractType : "",
  };
  const text = template.bodyText.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => values[key] ?? m);
  res.json({ text });
});

export default router;
