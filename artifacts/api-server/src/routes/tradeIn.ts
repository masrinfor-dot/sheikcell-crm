import { Router, type IRouter, type Request } from "express";
import { db, tradeInEvaluationsTable, usersTable, appSettingsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireAdmin, requireTenant } from "../middlewares/auth";
import { requirePerm } from "../lib/permissions";
import { requireModuleAccess } from "../lib/moduleAccess";
import {
  QUESTIONS_KEY, DEFAULT_QUESTIONS, sanitizeQuestions, validateTradeInAnswers, type QuestionsConfig,
} from "../lib/tradeInQuestions";
import {
  PAYMENT_METHODS_KEY, DEFAULT_PAYMENT_METHODS, sanitizePaymentMethods,
} from "../lib/tradeInPaymentMethods";
import { MEDIA_DIR } from "../lib/whatsappInbound";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

const router: IRouter = Router();
router.use("/trade-in", requireModuleAccess("avaliacao"));

// Anti-abuso: 1 avaliação por vez por usuário + intervalo mínimo entre chamadas.
const COOLDOWN_MS = 15000;
const lastCallByUser = new Map<number, number>();
const inFlight = new Set<number>();

// Histórico das últimas avaliações (toda a equipe vê, para consulta rápida).
router.get("/trade-in", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db
    .select({
      id: tradeInEvaluationsTable.id,
      userId: tradeInEvaluationsTable.userId,
      userName: usersTable.name,
      customerName: tradeInEvaluationsTable.customerName,
      device: tradeInEvaluationsTable.device,
      brand: tradeInEvaluationsTable.brand,
      model: tradeInEvaluationsTable.model,
      memory: tradeInEvaluationsTable.memory,
      color: tradeInEvaluationsTable.color,
      answers: tradeInEvaluationsTable.answers,
      marketPrice: tradeInEvaluationsTable.marketPrice,
      suggestedPrice: tradeInEvaluationsTable.suggestedPrice,
      aiSummary: tradeInEvaluationsTable.aiSummary,
      createdAt: tradeInEvaluationsTable.createdAt,
      // Precisa vir no histórico pra tela decidir se mostra "Finalizar compra"
      // (só quando ainda não fechado) e os dados já preenchidos quando fechado.
      sellerCustomerName: tradeInEvaluationsTable.sellerCustomerName,
      sellerCpf: tradeInEvaluationsTable.sellerCpf,
      imei: tradeInEvaluationsTable.imei,
      finalAgreedPrice: tradeInEvaluationsTable.finalAgreedPrice,
      closedAt: tradeInEvaluationsTable.closedAt,
      sellerRg: tradeInEvaluationsTable.sellerRg,
      sellerAddress: tradeInEvaluationsTable.sellerAddress,
      sellerNeighborhood: tradeInEvaluationsTable.sellerNeighborhood,
      sellerPhone: tradeInEvaluationsTable.sellerPhone,
      paymentMethod: tradeInEvaluationsTable.paymentMethod,
      pixKey: tradeInEvaluationsTable.pixKey,
      pixKeyHolder: tradeInEvaluationsTable.pixKeyHolder,
      // Pra reimprimir a nota (com fotos) e pra aba "Celulares comprados"
      // mostrar as fotos sem precisar abrir a avaliação uma por uma.
      documentPhotos: tradeInEvaluationsTable.documentPhotos,
      devicePhotos: tradeInEvaluationsTable.devicePhotos,
      paymentProofPhotos: tradeInEvaluationsTable.paymentProofPhotos,
    })
    .from(tradeInEvaluationsTable)
    .leftJoin(usersTable, eq(tradeInEvaluationsTable.userId, usersTable.id))
    .where(eq(tradeInEvaluationsTable.tenantId, tenantId))
    .orderBy(desc(tradeInEvaluationsTable.createdAt))
    .limit(200);
  res.json(rows);
});

type Answers = Record<string, string>;

// ─── Tabelas de margem ──────────────────────────────────────────────────────
// 1 = margem maior, 2 = média, 3 = menor. A % é a margem da loja: a sugestão
// de compra fica em torno de (100 − margem)% do valor de revenda.
type Margins = { t1: number; t2: number; t3: number };
const MARGIN_DEFAULTS: Margins = { t1: 40, t2: 30, t3: 20 };
const MARGINS_KEY = "trade_in_margins";

// Multi-loja: margens POR LOJA (app_settings tem PK composta tenant_id+key).
async function getMargins(tenantId: number): Promise<Margins> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, MARGINS_KEY))).limit(1);
  if (!row) return { ...MARGIN_DEFAULTS };
  try {
    const p = JSON.parse(row.value) as Partial<Margins>;
    const norm = (v: unknown, d: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 90 ? n : d;
    };
    return { t1: norm(p.t1, MARGIN_DEFAULTS.t1), t2: norm(p.t2, MARGIN_DEFAULTS.t2), t3: norm(p.t3, MARGIN_DEFAULTS.t3) };
  } catch {
    return { ...MARGIN_DEFAULTS };
  }
}

router.get("/trade-in/margins", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getMargins(tenantId));
});

router.patch("/trade-in/margins", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const body = req.body as Partial<Margins>;
  const cur = await getMargins(tenantId);
  const next: Margins = { ...cur };
  for (const k of ["t1", "t2", "t3"] as const) {
    if (body[k] === undefined) continue;
    const n = Math.round(Number(body[k]));
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      res.status(400).json({ error: "Margem deve ser entre 1% e 90%" });
      return;
    }
    next[k] = n;
  }
  await db.insert(appSettingsTable)
    .values({ tenantId, key: MARGINS_KEY, value: JSON.stringify(next) })
    .onConflictDoUpdate({
      // Chave composta: nunca sobrescreve a margem de outra loja.
      target: [appSettingsTable.tenantId, appSettingsTable.key],
      set: { value: JSON.stringify(next) },
    });
  res.json(next);
});

// ─── Perguntas do questionário (editáveis por loja) ─────────────────────────
// O admin edita perguntas/opções nas configurações; cada opção pode ser marcada
// como "bloqueia avaliação" (parte sem funcionar). Perguntas variam por marca
// (Apple x Android). Guardado por loja em app_settings (tenant_id + key).
// Lógica pura (defaults, sanitização e validação) em lib/tradeInQuestions.

async function getQuestionsConfig(tenantId: number): Promise<QuestionsConfig> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, QUESTIONS_KEY))).limit(1);
  if (!row) return DEFAULT_QUESTIONS;
  try {
    const { config } = sanitizeQuestions(JSON.parse(row.value));
    return config ?? DEFAULT_QUESTIONS;
  } catch {
    return DEFAULT_QUESTIONS;
  }
}

router.get("/trade-in/questions", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getQuestionsConfig(tenantId));
});

router.put("/trade-in/questions", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { config, error } = sanitizeQuestions(req.body);
  if (!config) { res.status(400).json({ error: error ?? "Configuração inválida" }); return; }
  await db.insert(appSettingsTable)
    .values({ tenantId, key: QUESTIONS_KEY, value: JSON.stringify(config) })
    .onConflictDoUpdate({
      // Chave composta: nunca sobrescreve as perguntas de outra loja.
      target: [appSettingsTable.tenantId, appSettingsTable.key],
      set: { value: JSON.stringify(config) },
    });
  res.json(config);
});

// Restaurar as perguntas padrão do sistema.
router.delete("/trade-in/questions", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  await db.delete(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, QUESTIONS_KEY)));
  res.json(DEFAULT_QUESTIONS);
});

// ─── Formas de pagamento (editáveis por loja) ────────────────────────────────
// Lista de opções sugeridas ao fechar a compra (nota de compra) — texto livre
// no banco (tradeInEvaluationsTable.paymentMethod), a lista aqui só alimenta o
// <select> da tela. Mesmo padrão de app_settings usado nas perguntas acima.

async function getPaymentMethodsConfig(tenantId: number): Promise<string[]> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, PAYMENT_METHODS_KEY))).limit(1);
  if (!row) return DEFAULT_PAYMENT_METHODS;
  try {
    const { methods } = sanitizePaymentMethods(JSON.parse(row.value));
    return methods ?? DEFAULT_PAYMENT_METHODS;
  } catch {
    return DEFAULT_PAYMENT_METHODS;
  }
}

router.get("/trade-in/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getPaymentMethodsConfig(tenantId));
});

router.put("/trade-in/payment-methods", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { methods, error } = sanitizePaymentMethods(req.body);
  if (!methods) { res.status(400).json({ error: error ?? "Configuração inválida" }); return; }
  await db.insert(appSettingsTable)
    .values({ tenantId, key: PAYMENT_METHODS_KEY, value: JSON.stringify(methods) })
    .onConflictDoUpdate({
      target: [appSettingsTable.tenantId, appSettingsTable.key],
      set: { value: JSON.stringify(methods) },
    });
  res.json(methods);
});

// Restaurar as formas de pagamento padrão do sistema.
router.delete("/trade-in/payment-methods", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  await db.delete(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, PAYMENT_METHODS_KEY)));
  res.json(DEFAULT_PAYMENT_METHODS);
});

// Sanitiza texto como DADO de aparelho (sem quebras/aspas — evita injeção).
const clean = (v: unknown, max: number) => (typeof v === "string"
  ? v.normalize("NFC").replace(/[^\p{L}\p{N} .,+\-()/%–]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max)
  : "");

// Um "celular comprado" (avaliação já com closedAt) só pode ser editado —
// dados, fotos ou excluído — por admin/supervisor; qualquer vendedor com
// acesso de edição ao módulo continua livre para FECHAR uma avaliação nova
// (closedAt ainda nulo) e mexer nas fotos dela até fechar o negócio.
const isManager = (req: Request): boolean =>
  req.session.userRole === "admin" || req.session.userRole === "supervisor";

// Chama a IA de preços (com busca na web; cai para estimativa sem web).
async function askPriceAI(prompt: string, tenantId: number): Promise<string> {
  const { getOpenAiClientForTenant } = await import("../lib/aiClient");
  const openai = await getOpenAiClientForTenant(tenantId);
  try {
    const r = await openai.responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search_preview" }],
      input: prompt,
      max_output_tokens: 1024,
    });
    return (r.output_text ?? "").trim();
  } catch {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [{ role: "user", content: `${prompt}\n\n(Obs.: você está sem acesso à web; estime pelos preços que conhece do mercado brasileiro e diga na justificativa que é uma estimativa.)` }],
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  }
}

function extractJson<T>(raw: string): T | null {
  const jsonText = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(jsonText.slice(start, end + 1)) as T; } catch { return null; }
}

// Preço base (estilo Trocafone): logo após informar marca/modelo/memória/cor,
// estima o valor MÁXIMO de compra para aparelho em perfeito estado.
router.post("/trade-in/base-price", requireAuth, requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { brand, model, memory, color } = req.body as { brand?: string; model?: string; memory?: string; color?: string };
  const fBrand = clean(brand, 40);
  const fModel = clean(model, 60);
  const fMemory = clean(memory, 20);
  const fColor = clean(color, 30);
  if (!fBrand || !fModel) { res.status(400).json({ error: "Informe a marca e o modelo do aparelho" }); return; }
  const dev = [fBrand, fModel, fMemory, fColor].filter(Boolean).join(" ");

  const marginTableRaw = (req.body as { marginTable?: unknown }).marginTable;
  const marginTable = marginTableRaw === 1 || marginTableRaw === 2 || marginTableRaw === 3 ? marginTableRaw : 2;
  const margins = await getMargins(tenantId);
  const marginPct = marginTable === 1 ? margins.t1 : marginTable === 2 ? margins.t2 : margins.t3;
  const payPct = 100 - marginPct;

  const uid = req.session.userId!;
  if (inFlight.has(uid)) { res.status(429).json({ error: "Já existe uma avaliação em andamento. Aguarde." }); return; }
  const last = lastCallByUser.get(uid) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) { res.status(429).json({ error: "Aguarde alguns segundos antes de avaliar novamente." }); return; }
  inFlight.add(uid);
  lastCallByUser.set(uid, Date.now());

  const prompt = [
    `Você é o avaliador de compra de celulares usados da Sheikcell (loja no Brasil).`,
    `Pesquise na web os preços ATUAIS de venda do aparelho usado abaixo no mercado brasileiro (OLX, Mercado Livre, Trocafone).`,
    ``,
    `Aparelho: ${dev.slice(0, 120)}`,
    ``,
    `Considere um aparelho em PERFEITO estado (tudo funcionando, sem marcas, bateria ótima).`,
    `A loja trabalha com margem de ${marginPct}%: o valor MÁXIMO de compra fica em torno de ${payPct}% do valor de revenda.`,
    ``,
    `Responda SOMENTE com um JSON válido, sem markdown, neste formato:`,
    `{"marketPrice":"R$ X – R$ Y (faixa de revenda)","basePrice":"R$ Z"}`,
  ].join("\n");

  try {
    const parsed = extractJson<{ marketPrice?: string; basePrice?: string }>(await askPriceAI(prompt, tenantId));
    const marketPrice = (parsed?.marketPrice ?? "").toString().slice(0, 200);
    const basePrice = (parsed?.basePrice ?? "").toString().slice(0, 100);
    if (!basePrice) { res.status(502).json({ error: "A IA não retornou um preço base. Tente novamente." }); return; }
    res.json({ device: dev, marketPrice, basePrice });
  } catch (err) {
    req.log.error({ err }, "Trade-in base price failed");
    res.status(503).json({ error: "A IA está indisponível no momento. Tente novamente em instantes." });
  } finally {
    inFlight.delete(uid);
  }
});

// Avaliação com IA: pesquisa preços atuais na web e sugere valor de compra.
router.post("/trade-in/evaluate", requireAuth, requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { device, answers, brand, model, memory, color, customerName } = req.body as {
    device?: string; answers?: Answers;
    brand?: string; model?: string; memory?: string; color?: string; customerName?: string;
  };
  // Campos estruturados (novo formulário). Se vierem, o texto do aparelho é
  // montado a partir deles; senão vale o texto livre (compatibilidade).
  const fBrand = clean(brand, 40);
  const fModel = clean(model, 60);
  const fMemory = clean(memory, 20);
  const fColor = clean(color, 30);
  // Nome do cliente é opcional aqui (só referência/busca no histórico) — quem
  // bloqueia de verdade é o CPF/nome exigido ao FECHAR o negócio (etapa 4).
  const fCustomerName = clean(customerName, 120);
  const composed = [fBrand, fModel, fMemory, fColor].filter(Boolean).join(" ");
  const dev = (composed || (device ?? "")).trim().slice(0, 160);
  if (!dev) { res.status(400).json({ error: "Informe a marca e o modelo do aparelho" }); return; }
  if (composed && (!fBrand || !fModel)) { res.status(400).json({ error: "Informe a marca e o modelo do aparelho" }); return; }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) { res.status(400).json({ error: "Responda o questionário de estado" }); return; }

  // Limita e sanitiza as respostas ANTES de usar e de gravar (anti-abuso).
  const cleanAnswers: Answers = {};
  for (const [k, v] of Object.entries(answers).slice(0, 30)) {
    if (typeof v !== "string") continue;
    const key = k.trim().slice(0, 60);
    const val = v.trim().slice(0, 200);
    if (key && val) cleanAnswers[key] = val;
  }
  if (Object.keys(cleanAnswers).length === 0) { res.status(400).json({ error: "Responda o questionário de estado" }); return; }

  // Validação estrita contra o questionário configurado da loja (por marca):
  // toda pergunta respondida, nenhuma chave desconhecida, cada valor uma opção
  // configurada e nenhuma opção que bloqueia — senão dá para burlar o bloqueio
  // chamando a API direto com respostas inventadas.
  const qConfig = await getQuestionsConfig(tenantId);
  const isApple = /apple|iphone/i.test(fBrand || dev);
  const validation = validateTradeInAnswers(isApple ? qConfig.apple : qConfig.android, cleanAnswers);
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  // Tabela de margem escolhida (1 = maior, 2 = média, 3 = menor).
  const marginTableRaw = (req.body as { marginTable?: unknown }).marginTable;
  const marginTable = marginTableRaw === 1 || marginTableRaw === 2 || marginTableRaw === 3 ? marginTableRaw : 2;
  const margins = await getMargins(tenantId);
  const marginPct = marginTable === 1 ? margins.t1 : marginTable === 2 ? margins.t2 : margins.t3;
  const payPct = 100 - marginPct;

  // Cooldown + 1 chamada em andamento por usuário (chamadas de IA custam).
  const uid = req.session.userId!;
  if (inFlight.has(uid)) { res.status(429).json({ error: "Já existe uma avaliação em andamento. Aguarde." }); return; }
  const last = lastCallByUser.get(uid) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    res.status(429).json({ error: "Aguarde alguns segundos antes de avaliar novamente." });
    return;
  }
  inFlight.add(uid);
  lastCallByUser.set(uid, Date.now());

  const condLines = Object.entries(cleanAnswers)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const prompt = [
    `Você é o avaliador de compra de celulares usados da Sheikcell (loja no Brasil).`,
    `Pesquise na web os preços ATUAIS de venda do aparelho usado abaixo no mercado brasileiro (OLX, Mercado Livre, Trocafone).`,
    ``,
    `Aparelho: ${dev.slice(0, 120)}`,
    ...(clean((req.body as { basePrice?: unknown }).basePrice, 60)
      ? [`Preço base já estimado para este aparelho em perfeito estado: ${clean((req.body as { basePrice?: unknown }).basePrice, 60)} (use como teto e desconte pelo estado abaixo).`]
      : []),
    `Estado informado pelo vendedor:`,
    condLines || "- (sem detalhes)",
    ``,
    `Regras da sugestão:`,
    `1. Estime a faixa de preço que esse aparelho usado é VENDIDO hoje no Brasil, já descontando o estado informado (tela trincada, bateria ruim etc. reduzem bastante).`,
    `2. A loja trabalha com margem de ${marginPct}% nesta avaliação: sugira um valor de COMPRA em torno de ${payPct}% do valor de revenda estimado (ajuste um pouco para baixo se o estado for regular).`,
    ``,
    `Responda SOMENTE com um JSON válido, sem markdown, neste formato:`,
    `{"marketPrice":"R$ X – R$ Y (faixa de revenda)","suggestedPrice":"R$ Z","summary":"justificativa curta em 2-4 frases, citando o que pesou na avaliação"}`,
  ].join("\n");

  try {
    const parsed = extractJson<{ marketPrice?: string; suggestedPrice?: string; summary?: string }>(await askPriceAI(prompt, tenantId));
    if (!parsed) {
      res.status(502).json({ error: "A IA não retornou uma avaliação válida. Tente novamente." });
      return;
    }
    const marketPrice = (parsed.marketPrice ?? "").toString().slice(0, 200);
    const suggestedPrice = (parsed.suggestedPrice ?? "").toString().slice(0, 100);
    const summary = (parsed.summary ?? "").toString().slice(0, 1500);
    if (!suggestedPrice) {
      res.status(502).json({ error: "A IA não sugeriu um valor. Tente novamente." });
      return;
    }

    const [saved] = await db.insert(tradeInEvaluationsTable).values({
      tenantId,
      userId: req.session.userId ?? null,
      customerName: fCustomerName || null,
      device: dev.slice(0, 160),
      brand: fBrand || null,
      model: fModel || null,
      memory: fMemory || null,
      color: fColor || null,
      answers: cleanAnswers,
      marketPrice: marketPrice || null,
      suggestedPrice,
      aiSummary: summary || null,
    }).returning();

    res.json({
      id: saved.id, device: saved.device, marketPrice, suggestedPrice, summary, createdAt: saved.createdAt,
      customerName: saved.customerName,
    });
  } catch (err) {
    req.log.error({ err }, "Trade-in AI evaluation failed");
    res.status(503).json({ error: "A IA está indisponível no momento. Tente novamente em instantes." });
  } finally {
    inFlight.delete(uid);
  }
});

// ─── Fechar negócio (etapa 4) ───────────────────────────────────────────────
// Captura os dados reais da compra: quem vendeu, CPF, IMEI do aparelho e o
// valor final negociado (pode diferir do sugerido pela IA).
const CPF_RE = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;

router.patch("/trade-in/:id/close", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Avaliação inválida" }); return; }

  const {
    sellerCustomerName, sellerCpf, imei, finalAgreedPrice, sellerRg, sellerAddress, sellerPhone,
    sellerNeighborhood, paymentMethod, pixKey, pixKeyHolder,
  } = req.body as {
    sellerCustomerName?: string; sellerCpf?: string; imei?: string; finalAgreedPrice?: string;
    sellerRg?: string; sellerAddress?: string; sellerPhone?: string;
    sellerNeighborhood?: string; paymentMethod?: string; pixKey?: string; pixKeyHolder?: string;
  };
  const name = clean(sellerCustomerName, 120);
  const cpf = typeof sellerCpf === "string" ? sellerCpf.trim().slice(0, 20) : "";
  const imeiClean = typeof imei === "string" ? imei.replace(/\D/g, "").slice(0, 20) : "";
  const finalPrice = clean(finalAgreedPrice, 60);
  // Dados extras da nota de compra (RG/endereço/telefone/pagamento) —
  // completam a nota mas não bloqueiam o fechamento se a loja não tiver essa
  // info na hora (mesmo espírito do IMEI opcional).
  const rg = clean(sellerRg, 30);
  const address = clean(sellerAddress, 300);
  const neighborhood = clean(sellerNeighborhood, 120);
  const phone = clean(sellerPhone, 30);
  const payMethod = clean(paymentMethod, 40);
  const pKey = typeof pixKey === "string" ? pixKey.trim().slice(0, 140) : "";
  const pKeyHolder = clean(pixKeyHolder, 120);

  if (!name) { res.status(400).json({ error: "Informe o nome do cliente vendedor" }); return; }
  if (!CPF_RE.test(cpf)) { res.status(400).json({ error: "CPF inválido" }); return; }
  // IMEI é OPCIONAL ao fechar: às vezes o aparelho comprado chega com defeito
  // e nem liga pra conferir o IMEI na hora — dá pra fechar o negócio sem ele
  // e preencher depois (ver aba "Celulares comprados"). Se vier preenchido,
  // ainda valida o formato (14-17 dígitos) pra não gravar lixo.
  if (imeiClean && (imeiClean.length < 14 || imeiClean.length > 17)) {
    res.status(400).json({ error: "IMEI inválido (se for preencher, use entre 14 e 17 dígitos)" }); return;
  }
  if (!finalPrice) { res.status(400).json({ error: "Informe o valor final negociado" }); return; }

  const [existing] = await db.select({ id: tradeInEvaluationsTable.id, closedAt: tradeInEvaluationsTable.closedAt })
    .from(tradeInEvaluationsTable)
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Avaliação não encontrada" }); return; }
  // Já é um celular comprado (negócio já fechado antes)? Só admin/supervisor
  // pode editar os dados dessa compra — vendedor comum só fecha uma vez.
  if (existing.closedAt && !isManager(req)) {
    res.status(403).json({ error: "Somente admin ou supervisor pode editar uma compra já fechada" });
    return;
  }

  const [saved] = await db.update(tradeInEvaluationsTable)
    .set({
      sellerCustomerName: name,
      sellerCpf: cpf,
      imei: imeiClean || null,
      finalAgreedPrice: finalPrice,
      sellerRg: rg || null,
      sellerAddress: address || null,
      sellerNeighborhood: neighborhood || null,
      sellerPhone: phone || null,
      paymentMethod: payMethod || null,
      pixKey: pKey || null,
      pixKeyHolder: pKeyHolder || null,
      // Preserva a data original do fechamento se já estava fechado (ex.:
      // só voltando pra completar o IMEI depois) — só grava agora na
      // primeira vez.
      closedAt: existing.closedAt ?? new Date(),
    })
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId)))
    .returning();

  res.json(saved);
});

// ─── Fotos da nota de compra (documento do cliente / aparelho) ────────────
// Upload 1 foto por vez (base64), igual ao padrão já usado em anexos de
// tarefa/chat — evita estourar o limite de corpo da requisição quando o
// vendedor seleciona várias fotos de uma vez. Guarda só a URL na lista
// (document_photos ou device_photos) da avaliação.
const ALLOWED_PHOTO_MIMES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
};
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB — foto de celular, com folga
const MAX_PHOTOS_PER_KIND = 8;

async function saveTradeInPhoto(base64: string, rawMimetype: string): Promise<string> {
  const mimetype = rawMimetype.split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED_PHOTO_MIMES[mimetype];
  if (!ext) throw new Error("Tipo de foto não suportado (use JPG, PNG, WEBP ou HEIC)");
  const buf = Buffer.from(base64, "base64");
  if (buf.byteLength > MAX_PHOTO_BYTES) throw new Error("Foto muito grande (máximo 10 MB)");
  await mkdir(MEDIA_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(MEDIA_DIR, filename), buf);
  return `/api/chat/media/${filename}`;
}

router.post("/trade-in/:id/photos", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Avaliação inválida" }); return; }
  const { kind, base64, mimetype } = req.body as { kind?: "document" | "device" | "payment"; base64?: string; mimetype?: string };
  if (kind !== "document" && kind !== "device" && kind !== "payment") { res.status(400).json({ error: "Tipo de foto inválido" }); return; }
  if (!base64 || !mimetype) { res.status(400).json({ error: "Foto inválida" }); return; }

  const [evalRow] = await db.select().from(tradeInEvaluationsTable)
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId))).limit(1);
  if (!evalRow) { res.status(404).json({ error: "Avaliação não encontrada" }); return; }
  if (evalRow.closedAt && !isManager(req)) {
    res.status(403).json({ error: "Somente admin ou supervisor pode editar uma compra já fechada" });
    return;
  }

  const column = kind === "document" ? "documentPhotos" : kind === "device" ? "devicePhotos" : "paymentProofPhotos";
  const current = evalRow[column] ?? [];
  if (current.length >= MAX_PHOTOS_PER_KIND) {
    res.status(400).json({ error: `Máximo de ${MAX_PHOTOS_PER_KIND} fotos por categoria` }); return;
  }

  let url: string;
  try {
    url = await saveTradeInPhoto(base64, mimetype);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Erro ao salvar foto" }); return;
  }

  const nextList = [...current, url];
  const [saved] = await db.update(tradeInEvaluationsTable)
    .set({ [column]: nextList })
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId)))
    .returning();

  res.json({ documentPhotos: saved!.documentPhotos, devicePhotos: saved!.devicePhotos, paymentProofPhotos: saved!.paymentProofPhotos });
});

router.delete("/trade-in/:id/photos", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Avaliação inválida" }); return; }
  const { kind, url } = req.body as { kind?: "document" | "device" | "payment"; url?: string };
  if (kind !== "document" && kind !== "device" && kind !== "payment") { res.status(400).json({ error: "Tipo de foto inválido" }); return; }
  if (!url) { res.status(400).json({ error: "Foto inválida" }); return; }

  const [evalRow] = await db.select().from(tradeInEvaluationsTable)
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId))).limit(1);
  if (!evalRow) { res.status(404).json({ error: "Avaliação não encontrada" }); return; }
  if (evalRow.closedAt && !isManager(req)) {
    res.status(403).json({ error: "Somente admin ou supervisor pode editar uma compra já fechada" });
    return;
  }

  const column = kind === "document" ? "documentPhotos" : kind === "device" ? "devicePhotos" : "paymentProofPhotos";
  const current = evalRow[column] ?? [];
  const nextList = current.filter((u) => u !== url);

  const [saved] = await db.update(tradeInEvaluationsTable)
    .set({ [column]: nextList })
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId)))
    .returning();

  res.json({ documentPhotos: saved!.documentPhotos, devicePhotos: saved!.devicePhotos, paymentProofPhotos: saved!.paymentProofPhotos });
});

// Excluir uma avaliação/compra — só admin ou supervisor (item sensível: some
// da aba "Celulares comprados" e do histórico pra sempre).
router.delete("/trade-in/:id", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Avaliação inválida" }); return; }
  if (!isManager(req)) { res.status(403).json({ error: "Somente admin ou supervisor pode excluir" }); return; }

  const [deleted] = await db.delete(tradeInEvaluationsTable)
    .where(and(eq(tradeInEvaluationsTable.id, id), eq(tradeInEvaluationsTable.tenantId, tenantId)))
    .returning({ id: tradeInEvaluationsTable.id });
  if (!deleted) { res.status(404).json({ error: "Avaliação não encontrada" }); return; }
  res.json({ ok: true });
});

export default router;
