import { Router, type IRouter } from "express";
import { db, filmCompatTable, appSettingsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import * as XLSX from "xlsx";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

// Linhas cruas da planilha → registros válidos (mesmas regras do import xlsx).
function parseCompatRows(rows: unknown[][]): { clean: { film: string; models: string; notes: string | null }[]; errors: string[] } {
  const clean: { film: string; models: string; notes: string | null }[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const film = String(r?.[0] ?? "").trim();
    const models = String(r?.[1] ?? "").trim();
    const notes = String(r?.[2] ?? "").trim();
    if (!film && !models) return; // linha vazia
    // pula cabeçalho (1ª linha com palavras típicas)
    if (i === 0 && /pel[ií]cula|filme|modelo|aparelho/i.test(`${film} ${models}`) && clean.length === 0) return;
    if (!film || !models) { errors.push(`Linha ${i + 1}: precisa de película E aparelhos`); return; }
    clean.push({ film: film.slice(0, 120), models: models.slice(0, 1000), notes: notes ? notes.slice(0, 500) : null });
  });
  return { clean, errors };
}

const SHEET_URL_KEY = "film_compat_sheet_url";

/** Converte um link do Google Planilhas no link de exportação CSV. */
function sheetCsvUrl(url: string): string | null {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

// Toda a equipe consulta a compatibilidade.
router.get("/film-compat", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(filmCompatTable).orderBy(asc(filmCompatTable.film));
  res.json(rows);
});

// Importa planilha (Excel/CSV) para atualizar a tabela de uma vez.
// Colunas esperadas: 1ª = película, 2ª = aparelhos compatíveis, 3ª = observações (opcional).
// mode: 'replace' apaga tudo e recomeça; 'append' só adiciona.
router.post("/film-compat/import", requireAdmin, async (req, res): Promise<void> => {
  const { fileData, mode } = (req.body ?? {}) as { fileData?: string; mode?: string };
  if (typeof fileData !== "string" || !fileData) { res.status(400).json({ error: "Envie o arquivo da planilha" }); return; }
  if (fileData.length > 15 * 1024 * 1024) { res.status(400).json({ error: "Planilha muito grande (máx. ~10MB)" }); return; }
  const importMode = mode === "replace" ? "replace" : "append";
  const fileBuf = Buffer.from(fileData, "base64");
  if (fileBuf.length > 10 * 1024 * 1024) { res.status(400).json({ error: "Planilha muito grande (máx. 10MB)" }); return; }

  const MAX_ROWS = 2000;
  let rows: unknown[][];
  try {
    // codepage 65001 = UTF-8 (evita acentos quebrados em CSV salvo sem BOM);
    // sheetRows limita a leitura ANTES de materializar tudo (proteção contra
    // arquivos comprimidos que explodem em milhões de linhas).
    const wb = XLSX.read(fileBuf, { type: "buffer", codepage: 65001, sheetRows: MAX_ROWS + 2 });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) { res.status(400).json({ error: "Planilha vazia" }); return; }
    rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, { header: 1, blankrows: false });
  } catch {
    res.status(400).json({ error: "Não consegui ler o arquivo — use Excel (.xlsx) ou CSV" }); return;
  }
  if (rows.length > MAX_ROWS + 1) { res.status(400).json({ error: `Máximo de ${MAX_ROWS} linhas por importação` }); return; }

  const { clean, errors } = parseCompatRows(rows);

  if (clean.length === 0) {
    res.status(400).json({ error: "Nenhuma linha válida na planilha. Use: coluna A = película, coluna B = aparelhos, coluna C = observações (opcional)." });
    return;
  }
  if (clean.length > MAX_ROWS) { res.status(400).json({ error: `Máximo de ${MAX_ROWS} linhas por importação` }); return; }

  // Modo substituir é destrutivo: só executa se TODAS as linhas forem válidas,
  // para não apagar a tabela e ficar só com uma parte.
  if (importMode === "replace" && errors.length > 0) {
    res.status(400).json({
      error: `A planilha tem ${errors.length} linha(s) com problema. Corrija antes de substituir a tabela: ${errors.slice(0, 5).join("; ")}`,
    });
    return;
  }

  await db.transaction(async (tx) => {
    if (importMode === "replace") await tx.delete(filmCompatTable);
    await tx.insert(filmCompatTable).values(clean);
  });
  res.json({ ok: true, imported: clean.length, skipped: errors.length, errors: errors.slice(0, 10), mode: importMode });
});

// ---------- Google Planilhas (atualização contínua) ----------

// Link salvo do Google Planilhas (admin).
router.get("/film-compat/sheet", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, SHEET_URL_KEY)).limit(1);
  res.json({ url: row?.value ?? "" });
});

// Salva (ou remove, com url vazia) o link do Google Planilhas.
router.put("/film-compat/sheet", requireAdmin, async (req, res): Promise<void> => {
  const url = String((req.body as Record<string, unknown> | undefined)?.["url"] ?? "").trim();
  if (url && !sheetCsvUrl(url)) {
    res.status(400).json({ error: "Cole o link de uma planilha do Google (docs.google.com/spreadsheets/...)" });
    return;
  }
  await db.insert(appSettingsTable).values({ key: SHEET_URL_KEY, value: url, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: url, updatedAt: new Date() } });
  res.json({ url });
});

// Puxa a planilha do Google e SUBSTITUI a tabela de compatibilidade.
router.post("/film-compat/sheet/sync", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, SHEET_URL_KEY)).limit(1);
  const url = row?.value?.trim();
  if (!url) { res.status(400).json({ error: "Salve primeiro o link do Google Planilhas" }); return; }
  const csvUrl = sheetCsvUrl(url);
  if (!csvUrl) { res.status(400).json({ error: "Link salvo é inválido — salve o link da planilha de novo" }); return; }

  let text: string;
  try {
    const r = await fetch(csvUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(String(r.status));
    text = await r.text();
  } catch {
    res.status(400).json({ error: "Não consegui baixar a planilha. Confira se o compartilhamento está como 'Qualquer pessoa com o link pode ver'." });
    return;
  }
  // Página de login do Google em vez do CSV = planilha não é pública.
  if (/<html/i.test(text.slice(0, 500))) {
    res.status(400).json({ error: "A planilha não está pública. No Google Planilhas: Compartilhar → 'Qualquer pessoa com o link' → Leitor." });
    return;
  }
  if (text.length > 10 * 1024 * 1024) { res.status(400).json({ error: "Planilha muito grande (máx. 10MB)" }); return; }

  const MAX_ROWS = 2000;
  let rows: unknown[][];
  try {
    const wb = XLSX.read(Buffer.from(text, "utf-8"), { type: "buffer", codepage: 65001, sheetRows: MAX_ROWS + 2 });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) { res.status(400).json({ error: "Planilha vazia" }); return; }
    rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, { header: 1, blankrows: false });
  } catch {
    res.status(400).json({ error: "Não consegui ler os dados da planilha" }); return;
  }
  if (rows.length > MAX_ROWS + 1) { res.status(400).json({ error: `Máximo de ${MAX_ROWS} linhas` }); return; }

  const { clean, errors } = parseCompatRows(rows);
  if (clean.length === 0) {
    res.status(400).json({ error: "Nenhuma linha válida. Use: coluna A = película, coluna B = aparelhos, coluna C = observações (opcional)." });
    return;
  }
  // Sincronizar substitui tudo — só roda se TODAS as linhas forem válidas.
  if (errors.length > 0) {
    res.status(400).json({ error: `A planilha tem ${errors.length} linha(s) com problema: ${errors.slice(0, 5).join("; ")}` });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(filmCompatTable);
    await tx.insert(filmCompatTable).values(clean);
  });
  res.json({ ok: true, imported: clean.length });
});

// Só o admin edita a tabela.
router.post("/film-compat", requireAdmin, async (req, res): Promise<void> => {
  const { film, models, notes } = req.body as { film?: string; models?: string; notes?: string };
  const f = (film ?? "").trim();
  const m = (models ?? "").trim();
  if (!f) { res.status(400).json({ error: "Informe a película" }); return; }
  if (!m) { res.status(400).json({ error: "Informe os aparelhos compatíveis" }); return; }
  const [inserted] = await db.insert(filmCompatTable)
    .values({ film: f.slice(0, 120), models: m.slice(0, 1000), notes: (notes ?? "").trim().slice(0, 500) || null })
    .returning();
  res.status(201).json(inserted);
});

router.patch("/film-compat/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { film, models, notes } = req.body as { film?: string; models?: string; notes?: string | null };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (film !== undefined) {
    const f = film.trim();
    if (!f) { res.status(400).json({ error: "Informe a película" }); return; }
    update.film = f.slice(0, 120);
  }
  if (models !== undefined) {
    const m = models.trim();
    if (!m) { res.status(400).json({ error: "Informe os aparelhos compatíveis" }); return; }
    update.models = m.slice(0, 1000);
  }
  if (notes !== undefined) update.notes = (notes ?? "").trim().slice(0, 500) || null;
  const [updated] = await db.update(filmCompatTable).set(update)
    .where(eq(filmCompatTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Registro não encontrado" }); return; }
  res.json(updated);
});

router.delete("/film-compat/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(filmCompatTable).where(eq(filmCompatTable.id, id));
  res.json({ ok: true });
});

export default router;
