import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { db, rhSettingsTable, rhCandidatesTable, rhPositionsTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { requireTenant } from "../middlewares/auth";
import { requireModuleAccess } from "../lib/moduleAccess";

const router: IRouter = Router();

// Perfil comportamental (estilo DISC simplificado, 4 tipos definidos pelo
// lojista) — cada opção de uma pergunta "options" pode ser marcada com um
// destes 4 perfis (optionProfiles, mesmo índice de `options`); ao responder,
// o perfil marcado na alternativa escolhida soma 1 ponto (ver
// computeProfileResult abaixo). null = alternativa não representa nenhum perfil.
export const PROFILE_TYPES = ["analitico", "dominante", "apoiador", "inovador"] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export type RhQuestion = {
  id: string; label: string; type: "text" | "longtext" | "options"; options?: string[];
  optionProfiles?: (ProfileType | null)[];
};
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
    // Alternativas já marcadas com o perfil comportamental (mesmo índice de
    // `options`) — exemplo pronto de como usar optionProfiles; o admin pode
    // ajustar livremente no editor ou reorganizar tudo via "Organizar com IA".
    questions: [
      { id: "q1", label: "Um cliente chega irritado. O que você faz?", type: "options", options: ["Ouço com calma e tento resolver", "Chamo o gerente", "Respondo no mesmo tom"], optionProfiles: ["apoiador", null, "dominante"] },
      { id: "q2", label: "Você prefere trabalhar:", type: "options", options: ["Em equipe", "Sozinho", "Tanto faz"], optionProfiles: ["apoiador", "analitico", null] },
      { id: "q3", label: "Quando bate a meta, você:", type: "options", options: ["Tenta vender ainda mais", "Relaxa o resto do mês", "Ajuda os colegas"], optionProfiles: ["dominante", null, "apoiador"] },
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

// Valida CPF de verdade (dígitos verificadores), não só a contagem de 11
// números — é a chave que impede repetir o processo seletivo, então vale a
// pena recusar CPF claramente inválido/inventado já na entrada.
function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // todos os dígitos iguais (ex.: 00000000000)
  const calcCheckDigit = (base: string, factor: number): number => {
    let sum = 0;
    for (const ch of base) sum += parseInt(ch, 10) * factor--;
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = calcCheckDigit(digits.slice(0, 9), 10);
  const d2 = calcCheckDigit(digits.slice(0, 9) + d1, 11);
  return digits.slice(9) === `${d1}${d2}`;
}

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
          // optionProfiles: mesmo índice de `options` — só grava o array se
          // pelo menos 1 alternativa tiver perfil marcado (pergunta comum de
          // múltipla escolha, sem nada a ver com teste de perfil, fica sem
          // esse campo, do jeito que já era antes desta feature).
          const rawProfiles = Array.isArray(q?.optionProfiles) ? q.optionProfiles : [];
          const profiles: (ProfileType | null)[] = opts.map((_, idx) => {
            const v = rawProfiles[idx];
            return (PROFILE_TYPES as readonly string[]).includes(v as string) ? (v as ProfileType) : null;
          });
          if (profiles.some((p) => p != null)) question.optionProfiles = profiles;
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

function sanitizePositionName(input: unknown): string | null {
  const name = typeof input === "string" ? input.trim().slice(0, 80) : "";
  return name || null;
}

// Extrai o array JSON da resposta da IA (mesmo padrão de catalog.ts): tira
// eventuais fences de markdown e pega o trecho entre o primeiro "[" e o
// último "]" — a IA às vezes escreve texto antes/depois do JSON mesmo
// quando instruída a responder só com o array.
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

// Tally do perfil comportamental: cada pergunta "options" com optionProfiles
// soma 1 ponto pro perfil marcado na alternativa que o candidato escolheu.
// O perfil dominante é o de maior contagem (empate resolvido pela ordem de
// PROFILE_TYPES); null se a candidatura não tinha nenhuma pergunta com perfil
// configurado (processo sem "teste de perfil" com opções marcadas).
function computeProfileResult(
  stages: RhStage[],
  answers: Record<string, Record<string, string>>,
): { result: ProfileType | null; scores: Record<ProfileType, number> | null } {
  const scores: Record<ProfileType, number> = { analitico: 0, dominante: 0, apoiador: 0, inovador: 0 };
  for (const stage of stages) {
    const stageAnswers = answers[stage.id];
    if (!stageAnswers) continue;
    for (const q of stage.questions) {
      if (q.type !== "options" || !q.options || !q.optionProfiles) continue;
      const given = stageAnswers[q.id];
      if (given == null) continue;
      const idx = q.options.indexOf(given);
      if (idx === -1) continue;
      const profile = q.optionProfiles[idx];
      if (profile) scores[profile]++;
    }
  }
  const total = PROFILE_TYPES.reduce((sum, p) => sum + scores[p], 0);
  if (total === 0) return { result: null, scores: null };
  let best: ProfileType = PROFILE_TYPES[0];
  for (const p of PROFILE_TYPES) if (scores[p] > scores[best]) best = p;
  return { result: best, scores };
}

// Cargos ativos da loja, na ordem configurada — usado tanto pela tela pública
// (escolha da vaga) quanto pelo admin.
async function getActivePositions(tenantId: number) {
  return db.select({ id: rhPositionsTable.id, name: rhPositionsTable.name })
    .from(rhPositionsTable)
    .where(and(eq(rhPositionsTable.tenantId, tenantId), eq(rhPositionsTable.active, true)))
    .orderBy(asc(rhPositionsTable.sortOrder), asc(rhPositionsTable.id));
}

// ── Público (candidato, sem login) ─────────────────────────────────────────

// Etapas visíveis para o candidato (sem dados internos). Se a loja tem pelo
// menos 1 cargo ativo configurado, devolve só a lista de cargos — o
// candidato escolhe 1 (nunca vários) e o front busca as etapas daquele
// cargo em seguida (rota abaixo). Loja sem nenhum cargo configurado (todo
// mundo até criar esta feature) continua recebendo `stages` direto, do
// jeito que já funcionava — o link que já foi compartilhado não muda.
router.get("/rh/public/:token", async (req, res): Promise<void> => {
  // Rota pública (Candidatura, sem login): resolve a loja pelo token do link.
  const settings = await getSettingsByToken(req.params.token);
  if (!settings) {
    res.status(404).json({ error: "Link inválido ou expirado" }); return;
  }
  const positions = await getActivePositions(settings.tenantId);
  if (positions.length > 0) {
    res.json({ positions, stages: null });
    return;
  }
  const stages = (settings.stages as RhStage[]).filter((s) => s.enabled);
  res.json({ positions: null, stages });
});

// Etapas do cargo escolhido — só depois que o candidato seleciona a vaga.
router.get("/rh/public/:token/position/:positionId", async (req, res): Promise<void> => {
  const settings = await getSettingsByToken(req.params.token);
  if (!settings) {
    res.status(404).json({ error: "Link inválido ou expirado" }); return;
  }
  const positionId = parseInt(String(req.params.positionId), 10);
  if (isNaN(positionId)) { res.status(400).json({ error: "Vaga inválida" }); return; }
  const [position] = await db.select().from(rhPositionsTable)
    .where(and(eq(rhPositionsTable.id, positionId), eq(rhPositionsTable.tenantId, settings.tenantId), eq(rhPositionsTable.active, true)))
    .limit(1);
  if (!position) { res.status(404).json({ error: "Vaga não encontrada — pode ter sido encerrada" }); return; }
  const stages = (position.stages as RhStage[]).filter((s) => s.enabled);
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
  const body = (req.body ?? {}) as {
    name?: string; phone?: string; email?: string; cpf?: string; positionId?: number;
    answers?: Record<string, Record<string, string>>;
    videoData?: string; videoMime?: string;
  };

  // Se a loja tem cargo(s) ativo(s), a vaga é obrigatória — 1 só, nunca
  // várias (o candidato escolhe antes, ver rota GET .../position/:id).
  // Loja sem cargo configurado continua no processo único de sempre.
  const activePositions = await getActivePositions(settings.tenantId);
  let stages: RhStage[];
  let positionId: number | null = null;
  let positionName: string | null = null;
  if (activePositions.length > 0) {
    const requestedId = typeof body.positionId === "number" ? body.positionId : NaN;
    const [position] = await db.select().from(rhPositionsTable)
      .where(and(eq(rhPositionsTable.id, requestedId), eq(rhPositionsTable.tenantId, settings.tenantId), eq(rhPositionsTable.active, true)))
      .limit(1);
    if (!position) { res.status(400).json({ error: "Escolha a vaga desejada" }); return; }
    stages = (position.stages as RhStage[]).filter((s) => s.enabled);
    positionId = position.id;
    positionName = position.name;
  } else {
    stages = (settings.stages as RhStage[]).filter((s) => s.enabled);
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 30) : "";
  if (!name || !phone) { res.status(400).json({ error: "Informe seu nome e telefone" }); return; }
  const cpfDigits = typeof body.cpf === "string" ? body.cpf.replace(/\D/g, "") : "";
  if (!isValidCpf(cpfDigits)) { res.status(400).json({ error: "Informe um CPF válido" }); return; }
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) || null : null;

  // Sem repetir o processo: 1 CPF só pode concluir a candidatura 1 vez nesta
  // loja (independente do cargo). Índice único parcial em rh_candidates (ver
  // migration 0067) é a rede de segurança contra corrida; esta checagem é só
  // pra devolver uma mensagem amigável no caminho normal.
  const [already] = await db.select({ id: rhCandidatesTable.id }).from(rhCandidatesTable)
    .where(and(eq(rhCandidatesTable.tenantId, settings.tenantId), eq(rhCandidatesTable.cpf, cpfDigits))).limit(1);
  if (already) {
    res.status(409).json({ error: "Este CPF já concluiu o nosso processo seletivo anteriormente. Não é possível se candidatar de novo — se quiser, fale diretamente com a loja." });
    return;
  }

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

  const { result: profileResult, scores: profileScores } = computeProfileResult(stages, answers);

  try {
    const [created] = await db.insert(rhCandidatesTable).values({
      tenantId: settings.tenantId, // loja dona do processo (vem do token do link)
      name, phone, email, cpf: cpfDigits, positionId, positionName, answers, videoData, videoMime,
      stagesSnapshot: stages, // congela as etapas do momento da candidatura
      profileResult, profileScores,
    }).returning({ id: rhCandidatesTable.id });
    res.status(201).json({ ok: true, id: created!.id });
  } catch (err) {
    // Corrida rara (2 envios do mesmo CPF ao mesmo tempo) — o índice único
    // parcial (migration 0067) barra o segundo; devolve a mesma mensagem
    // amigável em vez do erro cru do Postgres.
    if (err instanceof Error && /rh_candidates_tenant_cpf_uniq/.test(err.message)) {
      res.status(409).json({ error: "Este CPF já concluiu o nosso processo seletivo anteriormente. Não é possível se candidatar de novo — se quiser, fale diretamente com a loja." });
      return;
    }
    throw err;
  }
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

// ── Cargos (processo seletivo por função) ───────────────────────────────────
// Assim que a loja cadastra o primeiro cargo, o link público (que já existe,
// não muda) passa a pedir a escolha da vaga antes do questionário — ver
// GET /rh/public/:token acima.

router.get("/rh/positions", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(rhPositionsTable)
    .where(eq(rhPositionsTable.tenantId, tenantId))
    .orderBy(asc(rhPositionsTable.sortOrder), asc(rhPositionsTable.id));
  res.json(rows);
});

router.post("/rh/positions", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const name = sanitizePositionName((req.body ?? {}).name);
  if (!name) { res.status(400).json({ error: "Nome do cargo é obrigatório" }); return; }
  const stages = sanitizeStages((req.body ?? {}).stages) ?? DEFAULT_STAGES;
  const [{ max } = { max: 0 }] = await db.select({ max: rhPositionsTable.sortOrder }).from(rhPositionsTable)
    .where(eq(rhPositionsTable.tenantId, tenantId)).orderBy(desc(rhPositionsTable.sortOrder)).limit(1);
  const [created] = await db.insert(rhPositionsTable).values({
    tenantId, name, stages, sortOrder: (max ?? 0) + 1,
  }).returning();
  res.status(201).json(created);
});

router.patch("/rh/positions/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const body = (req.body ?? {}) as { name?: unknown; active?: unknown; stages?: unknown };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) {
    const name = sanitizePositionName(body.name);
    if (!name) { res.status(400).json({ error: "Nome do cargo é obrigatório" }); return; }
    update.name = name;
  }
  if (body.active !== undefined) update.active = body.active === true;
  if (body.stages !== undefined) {
    const stages = sanitizeStages(body.stages);
    if (!stages) { res.status(400).json({ error: "Etapas inválidas — cada etapa precisa de título e (se for formulário) de 1 a 30 perguntas; opções precisam de 2+ alternativas" }); return; }
    update.stages = stages;
  }
  const [updated] = await db.update(rhPositionsTable).set(update)
    .where(and(eq(rhPositionsTable.id, id), eq(rhPositionsTable.tenantId, tenantId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Cargo não encontrado" }); return; }
  res.json(updated);
});

router.delete("/rh/positions/:id", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(rhPositionsTable)
    .where(and(eq(rhPositionsTable.id, id), eq(rhPositionsTable.tenantId, tenantId)));
  // Candidaturas já recebidas mantêm o nome do cargo congelado
  // (positionName) — excluir o cargo não apaga o histórico de ninguém.
  res.json({ ok: true });
});

// ── Organizar lista de perguntas com IA ─────────────────────────────────────
// O lojista cola uma lista crua de perguntas (sem organização nenhuma,
// misturando dados pessoais/experiência/teste de perfil/técnicas) e a IA
// organiza em etapas coerentes pra vaga. Reaproveita sanitizeStages pra
// validar/normalizar o resultado — nunca confia direto no que a IA devolve.
// Não salva nada sozinho: devolve as etapas propostas pro front mostrar no
// editor, o admin revisa/ajusta e só persiste ao clicar em Salvar (mesmo
// fluxo de revisão da importação por IA da Vitrine Aparelhos).
router.post("/rh/ai-organize", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = (req.body ?? {}) as { rawText?: unknown; positionName?: unknown };
  const rawText = typeof body.rawText === "string" ? body.rawText.trim().slice(0, 12000) : "";
  if (!rawText) { res.status(400).json({ error: "Cole a lista de perguntas" }); return; }
  const positionName = typeof body.positionName === "string" ? body.positionName.trim().slice(0, 80) : "";

  const prompt = [
    `Você organiza uma lista de perguntas de processo seletivo (RH, mercado brasileiro) em etapas estruturadas de formulário.`,
    positionName ? `A vaga é: "${positionName}".` : `Não foi informada uma vaga específica — organize de forma genérica.`,
    `Abaixo está uma lista de perguntas que o lojista quer usar no processo seletivo, sem organização nenhuma (pode misturar perguntas de todo tipo: dados pessoais, experiência, teste de perfil comportamental, perguntas técnicas etc.).`,
    `Sua tarefa: agrupar essas perguntas em etapas (stages) coerentes por tema (ex.: "Pré-entrevista", "Teste de perfil", "Perguntas técnicas"), na ordem que fizer mais sentido pro candidato responder. NÃO invente perguntas novas fora da lista, exceto na regra especial abaixo. Mantenha o texto original de cada pergunta o máximo possível (só ajuste ortografia/pontuação óbvias).`,
    `Pra cada pergunta, escolha o tipo mais adequado: "text" (resposta curta, ex.: idade, bairro, telefone), "longtext" (resposta longa/dissertativa) ou "options" (múltipla escolha — quando a pergunta já vier com alternativas na lista, OU quando for uma pergunta de teste de perfil comportamental, ver regra especial).`,
    ``,
    `REGRA ESPECIAL — teste de perfil comportamental: quando uma pergunta claramente pedir pra avaliar o COMPORTAMENTO/PERFIL do candidato (ex.: "como você reage a...", "você prefere trabalhar...", "quando algo dá errado, você...", "diante de uma meta difícil..."), gere de 2 a 4 alternativas de resposta plausíveis (só se a pergunta ainda não tiver alternativas prontas na lista original) e classifique CADA alternativa com um destes 4 perfis, no array "optionProfiles" (mesmo índice de "options"; use null se a alternativa não representar nenhum perfil claro):`,
    `- "analitico": foco em precisão, dados, fatos, organização, processos claros e lógicos, atenção a detalhes.`,
    `- "dominante": foco em resultados, metas, velocidade, decisão rápida, liderança, autonomia.`,
    `- "apoiador": foco em pessoas, harmonia, colaboração, empatia, ambiente estável, ouvir bem.`,
    `- "inovador": foco em ideias, criatividade, comunicação, conexões, adaptabilidade, otimismo.`,
    `Só use "optionProfiles" em perguntas de teste de perfil de verdade — perguntas comuns de múltipla escolha (não comportamentais) devem vir sem esse campo (ou com todos os valores null).`,
    ``,
    `Lista de perguntas do lojista:`,
    rawText,
    ``,
    `Responda SOMENTE com um JSON array válido, sem markdown, neste formato:`,
    `[{"title":"Pré-entrevista","description":"Conte um pouco sobre você.","questions":[{"label":"Qual sua idade?","type":"text"},{"label":"Um cliente chega irritado. O que você faz?","type":"options","options":["Ouço com calma e tento resolver","Chamo o gerente","Respondo no mesmo tom"],"optionProfiles":["apoiador","dominante",null]}]}]`,
    `Máximo 10 etapas, máximo 30 perguntas por etapa, entre 2 e 8 alternativas por pergunta "options". "description" é uma frase curta de instrução pro candidato (pode ficar "").`,
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
    const stages = sanitizeStages(arr);
    if (!stages) { res.status(502).json({ error: "A IA organizou algo fora do esperado (etapa sem título, pergunta sem opções suficientes etc.). Tente novamente ou ajuste o texto colado." }); return; }
    res.json({ stages });
  } catch (err) {
    req.log.error({ err }, "RH AI organize failed");
    res.status(503).json({ error: "A IA está indisponível no momento. Tente novamente em instantes." });
  }
});

router.get("/rh/candidates", requireModuleAccess("rh"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select({
    id: rhCandidatesTable.id,
    name: rhCandidatesTable.name,
    phone: rhCandidatesTable.phone,
    email: rhCandidatesTable.email,
    cpf: rhCandidatesTable.cpf,
    positionId: rhCandidatesTable.positionId,
    positionName: rhCandidatesTable.positionName,
    status: rhCandidatesTable.status,
    answers: rhCandidatesTable.answers,
    notes: rhCandidatesTable.notes,
    stagesSnapshot: rhCandidatesTable.stagesSnapshot,
    hasVideo: rhCandidatesTable.videoMime,
    profileResult: rhCandidatesTable.profileResult,
    profileScores: rhCandidatesTable.profileScores,
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
    if (!["novo", "pre_aprovado", "aprovado", "reprovado"].includes(status)) { res.status(400).json({ error: "Status inválido" }); return; }
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
