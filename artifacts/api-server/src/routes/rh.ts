import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { db, rhSettingsTable, rhCandidatesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();

export type RhQuestion = { id: string; label: string; type: "text" | "longtext" | "options"; options?: string[] };
export type RhStage = { id: string; title: string; description: string; type: "form" | "video"; enabled: boolean; questions: RhQuestion[]; maxVideoSeconds?: number | null };

const Q_TYPES = ["text", "longtext", "options"];
const MAX_VIDEO_BASE64 = 26 * 1024 * 1024; // ~19MB de vídeo real
// Limite configurável por etapa de vídeo: null = sem limite; número = segundos,
// sempre restrito a essa faixa pra evitar tanto travas irreais quanto vídeos gigantes.
const MIN_VIDEO_SECONDS = 5;
const MAX_VIDEO_SECONDS = 1800;
const DEFAULT_VIDEO_SECONDS = 60;

// Etapas padrão do processo (o admin personaliza depois).
const DEFAULT_STAGES: RhStage[] = [
  {
    id: "s1", title: "Pré-entrevista", type: "form", enabled: true,
    description: "Conte um pouco sobre você.",
    questions: [
      { id: "q1", label: "Qual sua idade?", type: "text" },
      { id: "q2", label: "Em qual bairro você mora?", type: "text" },
      { id: "q3", label: "Já trabalhou com vendas? Onde?", type: "longtext" },
      { id: "q4", label: "Por que quer trabalhar conosco?", type: "longtext" },
    ],
  },
  {
    id: "s2", title: "Teste de perfil", type: "form", enabled: true,
    description: "Escolha a opção que mais combina com você.",
    questions: [
      { id: "q1", label: "Um cliente chega irritado. O que você faz?", type: "options", options: ["Ouço com calma e tento resolver", "Chamo o gerente", "Respondo no mesmo tom"] },
      { id: "q2", label: "Você prefere trabalhar:", type: "options", options: ["Em equipe", "Sozinho", "Tanto faz"] },
      { id: "q3", label: "Quando bate a meta, você:", type: "options", options: ["Tenta vender ainda mais", "Relaxa o resto do mês", "Ajuda os colegas"] },
    ],
  },
  {
    id: "s3", title: "Prova escrita", type: "form", enabled: true,
    description: "Responda com suas palavras, caprichando na escrita.",
    questions: [
      { id: "q1", label: "Escreva como você apresentaria um celular para um cliente indeciso.", type: "longtext" },
      { id: "q2", label: "Um cliente quer devolver um produto sem defeito. Como você responde?", type: "longtext" },
    ],
  },
  {
    id: "s4", title: "Vídeo de apresentação", type: "video", enabled: true,
    description: "Grave um vídeo de até 60 segundos se apresentando: nome, experiência e por que devemos te contratar.",
    questions: [], maxVideoSeconds: DEFAULT_VIDEO_SECONDS,
  },
];

// Detecta o tipo real do vídeo pelos primeiros bytes (magic numbers).
// Só aceita webm/mkv (EBML), mp4/mov (ftyp) e ogg.
function detectVideoMime(head: Buffer): string | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  if (head.length >= 8 && head.toString("latin1", 4, 8) === "ftyp") return "video/mp4";
  if (head.length >= 4 && head.toString("latin1", 0, 4) === "OggS") return "video/ogg";
  return null;
}

// Configurações de RH da loja (tenant). Cria a linha padrão na primeira vez.
async function getSettings(tenantId: number) {
  const [row] = await db.select().from(rhSettingsTable)
    .where(eq(rhSettingsTable.tenantId, tenantId)).limit(1);
  if (row) return row;
  const [created] = await db.insert(rhSettingsTable).values({
    tenantId,
    publicToken: randomBytes(16).toString("hex"),
    stages: DEFAULT_STAGES,
  }).returning();
  return created!;
}

// Endpoints públicos (candidato, sem login) resolvem a loja pelo próprio token
// do link — o token é único e identifica a loja dona do processo seletivo.
async function getSettingsByToken(token: string) {
  const [row] = await db.select().from(rhSettingsTable)
    .where(eq(rhSettingsTable.publicToken, token)).limit(1);
  return row ?? null;
}

function sanitizeStages(input: unknown): RhStage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10) return null;
  const out: RhStage[] = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as Partial<RhStage>;
    const title = typeof s?.title === "string" ? s.title.trim().slice(0, 120) : "";
    if (!title) return null;
    const type = s?.type === "video" ? "video" : "form";
    const questions: RhQuestion[] = [];
    // maxVideoSeconds: null = sem limite; número inválido/ausente cai no
    // padrão de 60s; qualquer número informado é sempre restrito à faixa
    // [MIN_VIDEO_SECONDS, MAX_VIDEO_SECONDS] pra não aceitar valor absurdo.
    let maxVideoSeconds: number | null = DEFAULT_VIDEO_SECONDS;
    if (type === "video") {
      if (s?.maxVideoSeconds === null) {
        maxVideoSeconds = null;
      } else if (typeof s?.maxVideoSeconds === "number" && Number.isFinite(s.maxVideoSeconds)) {
        maxVideoSeconds = Math.max(MIN_VIDEO_SECONDS, Math.min(MAX_VIDEO_SECONDS, Math.round(s.maxVideoSeconds)));
      }
    }
    if (type === "form") {
      if (!Array.isArray(s?.questions) || s.questions.length === 0 || s.questions.length > 30) return null;
      for (let j = 0; j < s.questions.length; j++) {
        const q = s.questions[j] as Partial<RhQuestion>;
        const label = typeof q?.label === "string" ? q.label.trim().slice(0, 300) : "";
        const qType = Q_TYPES.includes(q?.type as string) ? (q!.type as RhQuestion["type"]) : "text";
        if (!label) return null;
        const question: RhQuestion = { id: `q${j + 1}`, label, type: qType };
        if (qType === "options") {
          const opts = Array.isArray(q?.options)
            ? q.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 200)).slice(0, 8)
            : [];
          if (opts.length < 2) return null;
          question.options = opts;
        }
        questions.push(question);
      }
    }
    out.push({
      id: `s${i + 1}`, title, type,
      description: typeof s?.description === "string" ? s.description.trim().slice(0, 1000) : "",
      enabled: s?.enabled !== false,
      questions,
      ...(type === "video" ? { maxVideoSeconds } : {}),
    });
  }
  return out;
}

// ── Público (candidato, sem login) ─────────────────────────────────────────

// Etapas visíveis para o candidato (sem dados internos).
router.get("/rh/public/:token", async (req, res): Promise<void> => {
  // Rota pública (Candidatura, sem login): resolve a loja pelo token do link.
  const settings = await getSettingsByToken(req.params.token);
  if (!settings) {
    res.status(404).json({ error: "Link inválido ou expirado" }); return;
  }
  const stages = (settings.stages as RhStage[]).filter((s) => s.enabled);
  res.json({ stages });
});

router.post("/rh/public/:token/apply", async (req, res): Promise<void> => {
  // Rota pública (sem login): a loja (tenant) vem do token do link — não há
  // sessão. TODO(multi-loja): se um dia existir link "genérico" sem token,
  // usar tenant 1 como padrão para não quebrar o fluxo público.
  const settings = await getSettingsByToken(req.params.token);
  if (!settings) {
    res.status(404).json({ error: "Link inválido ou expirado" }); return;
  }
  const stages = (settings.stages as RhStage[]).filter((s) => s.enabled);
  const body = (req.body ?? {}) as {
    name?: string; phone?: string; email?: string;
    answers?: Record<string, Record<string, string>>;
    videoData?: string; videoMime?: string;
  };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 30) : "";
  if (!name || !phone) { res.status(400).json({ error: "Informe seu nome e telefone" }); return; }
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) || null : null;

  // Valida respostas de cada etapa habilitada.
  const answers: Record<string, Record<string, string>> = {};
  let videoData: string | null = null;
  let videoMime: string | null = null;
  for (const stage of stages) {
    if (stage.type === "video") {
      const vd = typeof body.videoData === "string" ? body.videoData : "";
      if (!vd) { res.status(400).json({ error: `Grave o vídeo da etapa "${stage.title}"` }); return; }
      if (vd.length > MAX_VIDEO_BASE64) { res.status(400).json({ error: "Vídeo muito grande — grave um vídeo mais curto" }); return; }
      if (!/^[A-Za-z0-9+/=]+$/.test(vd)) { res.status(400).json({ error: "Vídeo inválido" }); return; }
      // Confere os bytes reais do arquivo (assinatura) — o mime do cliente é ignorado.
      const detected = detectVideoMime(Buffer.from(vd.slice(0, 64), "base64"));
      if (!detected) { res.status(400).json({ error: "Arquivo inválido — grave o vídeo pelo próprio formulário" }); return; }
      videoData = vd;
      videoMime = detected;
      continue;
    }
    const given = body.answers?.[stage.id] ?? {};
    const clean: Record<string, string> = {};
    for (const q of stage.questions) {
      const v = typeof given[q.id] === "string" ? given[q.id]!.trim().slice(0, 5000) : "";
      if (!v) { res.status(400).json({ error: `Responda: "${q.label}" (etapa ${stage.title})` }); return; }
      if (q.type === "options" && !(q.options ?? []).includes(v)) {
        res.status(400).json({ error: `Escolha uma opção válida em "${q.label}"` }); return;
      }
      clean[q.id] = v;
    }
    answers[stage.id] = clean;
  }

  const [created] = await db.insert(rhCandidatesTable).values({
    tenantId: settings.tenantId, // loja dona do processo (vem do token do link)
    name, phone, email, answers, videoData, videoMime,
    stagesSnapshot: stages, // congela as etapas do momento da candidatura
  }).returning({ id: rhCandidatesTable.id });
  res.status(201).json({ ok: true, id: created!.id });
});

// ── Admin ──────────────────────────────────────────────────────────────────

router.get("/rh/settings", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const s = await getSettings(tenantId);
  res.json({ publicToken: s.publicToken, stages: s.stages });
});

router.put("/rh/settings", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const stages = sanitizeStages((req.body ?? {}).stages);
  if (!stages) {
    res.status(400).json({ error: "Etapas inválidas — cada etapa precisa de título e (se for formulário) de 1 a 30 perguntas; opções precisam de 2+ alternativas" });
    return;
  }
  const s = await getSettings(tenantId);
  await db.update(rhSettingsTable).set({ stages, updatedAt: new Date() })
    .where(and(eq(rhSettingsTable.id, s.id), eq(rhSettingsTable.tenantId, tenantId)));
  res.json({ ok: true });
});

router.post("/rh/settings/regenerate-token", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const s = await getSettings(tenantId);
  const publicToken = randomBytes(16).toString("hex");
  await db.update(rhSettingsTable).set({ publicToken, updatedAt: new Date() })
    .where(and(eq(rhSettingsTable.id, s.id), eq(rhSettingsTable.tenantId, tenantId)));
  res.json({ publicToken });
});

router.get("/rh/candidates", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select({
    id: rhCandidatesTable.id,
    name: rhCandidatesTable.name,
    phone: rhCandidatesTable.phone,
    email: rhCandidatesTable.email,
    status: rhCandidatesTable.status,
    answers: rhCandidatesTable.answers,
    notes: rhCandidatesTable.notes,
    stagesSnapshot: rhCandidatesTable.stagesSnapshot,
    hasVideo: rhCandidatesTable.videoMime,
    createdAt: rhCandidatesTable.createdAt,
  }).from(rhCandidatesTable)
    .where(eq(rhCandidatesTable.tenantId, tenantId))
    .orderBy(desc(rhCandidatesTable.createdAt)).limit(500);
  res.json(rows.map((r) => ({ ...r, hasVideo: !!r.hasVideo })));
});

router.get("/rh/candidates/:id/video", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [row] = await db.select({ videoData: rhCandidatesTable.videoData, videoMime: rhCandidatesTable.videoMime })
    .from(rhCandidatesTable).where(and(eq(rhCandidatesTable.id, id), eq(rhCandidatesTable.tenantId, tenantId)));
  if (!row?.videoData) { res.status(404).json({ error: "Sem vídeo" }); return; }
  const buf = Buffer.from(row.videoData, "base64");
  const safeMime = ["video/webm", "video/mp4", "video/ogg"].includes(row.videoMime ?? "") ? row.videoMime! : "video/webm";
  res.setHeader("Content-Type", safeMime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Content-Length", String(buf.length));
  res.send(buf);
});

router.patch("/rh/candidates/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { status, notes } = (req.body ?? {}) as { status?: string; notes?: string };
  const update: Record<string, unknown> = {};
  if (status !== undefined) {
    if (!["novo", "aprovado", "reprovado"].includes(status)) { res.status(400).json({ error: "Status inválido" }); return; }
    update.status = status;
  }
  if (notes !== undefined) update.notes = typeof notes === "string" ? notes.trim().slice(0, 5000) || null : null;
  if (Object.keys(update).length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  const [updated] = await db.update(rhCandidatesTable).set(update)
    .where(and(eq(rhCandidatesTable.id, id), eq(rhCandidatesTable.tenantId, tenantId)))
    .returning({ id: rhCandidatesTable.id, status: rhCandidatesTable.status, notes: rhCandidatesTable.notes });
  if (!updated) { res.status(404).json({ error: "Candidato não encontrado" }); return; }
  res.json(updated);
});

router.delete("/rh/candidates/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(rhCandidatesTable)
    .where(and(eq(rhCandidatesTable.id, id), eq(rhCandidatesTable.tenantId, tenantId)));
  res.json({ ok: true });
});

export default router;
