import { Router, type IRouter } from "express";
import { db, tradeInEvaluationsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { requirePerm } from "../lib/permissions";

const router: IRouter = Router();

// Anti-abuso: 1 avaliação por vez por usuário + intervalo mínimo entre chamadas.
const COOLDOWN_MS = 15000;
const lastCallByUser = new Map<number, number>();
const inFlight = new Set<number>();

// Histórico das últimas avaliações (toda a equipe vê, para consulta rápida).
router.get("/trade-in", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: tradeInEvaluationsTable.id,
      userId: tradeInEvaluationsTable.userId,
      userName: usersTable.name,
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
    })
    .from(tradeInEvaluationsTable)
    .leftJoin(usersTable, eq(tradeInEvaluationsTable.userId, usersTable.id))
    .orderBy(desc(tradeInEvaluationsTable.createdAt))
    .limit(200);
  res.json(rows);
});

type Answers = Record<string, string>;

// Avaliação com IA: pesquisa preços atuais na web e sugere valor de compra.
router.post("/trade-in/evaluate", requireAuth, requirePerm("usar_ia"), async (req, res): Promise<void> => {
  const { device, answers, brand, model, memory, color } = req.body as {
    device?: string; answers?: Answers;
    brand?: string; model?: string; memory?: string; color?: string;
  };
  // Campos estruturados (novo formulário). Se vierem, o texto do aparelho é
  // montado a partir deles; senão vale o texto livre (compatibilidade).
  // Sanitiza como DADO de aparelho: só letras/números/espaço e pontuação leve
  // (nada de quebras de linha, aspas, chaves etc. — evita injeção no prompt).
  const clean = (v: unknown, max: number) => (typeof v === "string"
    ? v.normalize("NFC").replace(/[^\p{L}\p{N} .,+\-()/]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "");
  const fBrand = clean(brand, 40);
  const fModel = clean(model, 60);
  const fMemory = clean(memory, 20);
  const fColor = clean(color, 30);
  const composed = [fBrand, fModel, fMemory, fColor].filter(Boolean).join(" ");
  const dev = (composed || (device ?? "")).trim().slice(0, 160);
  if (!dev) { res.status(400).json({ error: "Informe a marca e o modelo do aparelho" }); return; }
  if (composed && (!fBrand || !fModel)) { res.status(400).json({ error: "Informe a marca e o modelo do aparelho" }); return; }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) { res.status(400).json({ error: "Responda o questionário de estado" }); return; }

  // Limita e sanitiza as respostas ANTES de usar e de gravar (anti-abuso).
  const cleanAnswers: Answers = {};
  for (const [k, v] of Object.entries(answers).slice(0, 20)) {
    if (typeof v !== "string") continue;
    const key = k.trim().slice(0, 60);
    const val = v.trim().slice(0, 200);
    if (key && val) cleanAnswers[key] = val;
  }
  if (Object.keys(cleanAnswers).length === 0) { res.status(400).json({ error: "Responda o questionário de estado" }); return; }

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
    `Estado informado pelo vendedor:`,
    condLines || "- (sem detalhes)",
    ``,
    `Regras da sugestão:`,
    `1. Estime a faixa de preço que esse aparelho usado é VENDIDO hoje no Brasil, já descontando o estado informado (tela trincada, bateria ruim etc. reduzem bastante).`,
    `2. A loja precisa de margem: sugira um valor de COMPRA em torno de 60% a 75% do valor de revenda estimado, mais baixo se o estado for ruim.`,
    `3. Se o aparelho não liga ou tem defeito grave, avalie como aparelho para peças.`,
    ``,
    `Responda SOMENTE com um JSON válido, sem markdown, neste formato:`,
    `{"marketPrice":"R$ X – R$ Y (faixa de revenda)","suggestedPrice":"R$ Z","summary":"justificativa curta em 2-4 frases, citando o que pesou na avaliação"}`,
  ].join("\n");

  try {
    const { openai } = await import("@workspace/integrations-openai-ai");
    let raw = "";
    try {
      // Primeiro tenta com busca na web (preços reais de hoje).
      const r = await openai.responses.create({
        model: "gpt-4o",
        tools: [{ type: "web_search_preview" }],
        input: prompt,
        max_output_tokens: 1024,
      });
      raw = (r.output_text ?? "").trim();
    } catch {
      // Sem acesso à busca: cai para estimativa pelo conhecimento do modelo.
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 1024,
        messages: [{ role: "user", content: `${prompt}\n\n(Obs.: você está sem acesso à web; estime pelos preços que conhece do mercado brasileiro e diga na justificativa que é uma estimativa.)` }],
      });
      raw = completion.choices[0]?.message?.content?.trim() ?? "";
    }

    const jsonText = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start === -1 || end === -1) {
      res.status(502).json({ error: "A IA não retornou uma avaliação válida. Tente novamente." });
      return;
    }
    let parsed: { marketPrice?: string; suggestedPrice?: string; summary?: string };
    try {
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    } catch {
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
      userId: req.session.userId ?? null,
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

    res.json({ id: saved.id, device: saved.device, marketPrice, suggestedPrice, summary, createdAt: saved.createdAt });
  } catch (err) {
    req.log.error({ err }, "Trade-in AI evaluation failed");
    res.status(503).json({ error: "A IA está indisponível no momento. Tente novamente em instantes." });
  } finally {
    inFlight.delete(uid);
  }
});

export default router;
