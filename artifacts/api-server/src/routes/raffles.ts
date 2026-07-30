import { createHmac } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, rafflesTable, raffleDrawsTable, conversationsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type Winner = { phone: string; name: string; conversationId: number; sent: boolean; error?: string };

// ---------- validação ----------

function numArrayOrNull(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n));
  return out.length ? out : null;
}

function strArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out.slice(0, 20) : null;
}

function sanitizeRaffle(body: Record<string, unknown>): { data?: typeof rafflesTable.$inferInsert; error?: string } {
  const name = String(body["name"] ?? "").trim();
  const prize = String(body["prize"] ?? "").trim();
  const messageTemplate = String(body["messageTemplate"] ?? "").trim();
  if (!name) return { error: "Dê um nome ao sorteio" };
  if (!prize) return { error: "Informe o prêmio" };
  if (!messageTemplate) return { error: "Escreva a mensagem para o ganhador" };
  const winnersCount = parseInt(String(body["winnersCount"] ?? 1), 10);
  if (!Number.isFinite(winnersCount) || winnersCount < 1 || winnersCount > 20) {
    return { error: "Quantidade de ganhadores deve ser de 1 a 20" };
  }
  const recurrence = String(body["recurrence"] ?? "once");
  if (!["once", "weekly", "monthly"].includes(recurrence)) return { error: "Recorrência inválida" };
  let dayOfWeek: number | null = null;
  let dayOfMonth: number | null = null;
  if (recurrence === "weekly") {
    dayOfWeek = parseInt(String(body["dayOfWeek"] ?? ""), 10);
    if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return { error: "Escolha o dia da semana do sorteio" };
  }
  if (recurrence === "monthly") {
    dayOfMonth = parseInt(String(body["dayOfMonth"] ?? ""), 10);
    if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) return { error: "Dia do mês deve ser de 1 a 28" };
  }
  let periodDays: number | null = null;
  if (body["periodDays"] != null && String(body["periodDays"]).trim() !== "") {
    periodDays = parseInt(String(body["periodDays"]), 10);
    if (!Number.isFinite(periodDays) || periodDays < 1 || periodDays > 365) return { error: "Período deve ser de 1 a 365 dias" };
  }
  return {
    data: {
      name: name.slice(0, 120),
      prize: prize.slice(0, 200),
      messageTemplate: messageTemplate.slice(0, 1000),
      storeName: String(body["storeName"] ?? "").trim().slice(0, 120) || null,
      sectorIds: numArrayOrNull(body["sectorIds"]),
      vendedorIds: numArrayOrNull(body["vendedorIds"]),
      sessionKeys: strArrayOrNull(body["sessionKeys"]),
      periodDays,
      onlyResolved: body["onlyResolved"] === true,
      excludePreviousWinners: body["excludePreviousWinners"] !== false,
      winnersCount,
      recurrence,
      dayOfWeek,
      dayOfMonth,
      active: body["active"] !== false,
    },
  };
}

// ---------- elegíveis + sorteio ----------

type Raffle = typeof rafflesTable.$inferSelect;

async function eligibleClients(raffle: Raffle): Promise<{ phone: string; name: string; conversationId: number }[]> {
  const conds = [sql`${conversationsTable.phone} <> ''`, eq(conversationsTable.channel, "whatsapp")];
  const sectorIds = numArrayOrNull(raffle.sectorIds);
  const vendedorIds = numArrayOrNull(raffle.vendedorIds);
  const sessionKeys = strArrayOrNull(raffle.sessionKeys);
  if (sectorIds) conds.push(inArray(conversationsTable.sectorId, sectorIds));
  if (vendedorIds) conds.push(inArray(conversationsTable.assigneeId, vendedorIds));
  if (sessionKeys) conds.push(inArray(conversationsTable.sessionKey, sessionKeys));
  if (raffle.onlyResolved) conds.push(inArray(conversationsTable.status, ["resolved", "archived"]));
  if (raffle.periodDays) {
    conds.push(gte(conversationsTable.updatedAt, new Date(Date.now() - raffle.periodDays * 86_400_000)));
  }

  const rows = await db.select({
    id: conversationsTable.id,
    phone: conversationsTable.phone,
    name: conversationsTable.name,
    updatedAt: conversationsTable.updatedAt,
  }).from(conversationsTable).where(and(...conds));

  // Cada cliente (telefone) entra UMA vez — fica com a conversa mais recente.
  const byPhone = new Map<string, { phone: string; name: string; conversationId: number; at: number }>();
  for (const r of rows) {
    const key = r.phone.replace(/\D/g, "");
    if (!key) continue;
    const at = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    const cur = byPhone.get(key);
    if (!cur || at > cur.at) byPhone.set(key, { phone: r.phone, name: r.name, conversationId: r.id, at });
  }

  let list = [...byPhone.values()];

  if (raffle.excludePreviousWinners) {
    const draws = await db.select({ winners: raffleDrawsTable.winners })
      .from(raffleDrawsTable).where(eq(raffleDrawsTable.raffleId, raffle.id));
    const won = new Set<string>();
    for (const d of draws) {
      for (const w of (d.winners as Winner[] | null) ?? []) won.add(String(w.phone).replace(/\D/g, ""));
    }
    list = list.filter((c) => !won.has(c.phone.replace(/\D/g, "")));
  }

  return list.map(({ phone, name, conversationId }) => ({ phone, name, conversationId }));
}

function fillTemplate(template: string, w: { name: string }, raffle: Raffle): string {
  return template
    .replaceAll("{nome}", w.name || "cliente")
    .replaceAll("{premio}", raffle.prize)
    .replaceAll("{loja}", raffle.storeName || "nossa loja");
}

async function sendWhatsAppText(conversationId: number, content: string): Promise<boolean> {
  const [conv] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId)).limit(1);
  if (!conv || !conv.phone) return false;

  const { messagesTable } = await import("@workspace/db");
  const { broadcast } = await import("../lib/sseEmitter");
  const { isPotentialConversation, restrictedRecipients } = await import("../lib/conversationScope");

  const [msg] = await db.insert(messagesTable).values({
    conversationId: conv.id,
    content,
    direction: "outbound",
    type: "text",
    status: "sent",
    senderName: "Sorteio automático",
  }).returning();

  await db.update(conversationsTable).set({
    lastMessage: content,
    lastMessageDirection: "outbound",
    lastMessageAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(conversationsTable.id, conv.id));

  broadcast("message", { conversationId: conv.id, message: msg }, conv.sectorId,
    isPotentialConversation(conv), await restrictedRecipients(conv));

  const bridgeUrl = process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
  const bridgeSecret = createHmac(
    "sha256",
    process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret",
  ).update("whatsapp-bridge-v1").digest("hex");
  let delivered = true;
  try {
    const r = await fetch(`${bridgeUrl}/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret },
      body: JSON.stringify({ to: conv.phone, text: content, session: conv.sessionKey }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) delivered = false;
  } catch {
    delivered = false;
  }
  if (!delivered && msg) {
    const [failedMsg] = await db.update(messagesTable).set({ status: "failed" })
      .where(eq(messagesTable.id, msg.id)).returning();
    if (failedMsg) {
      broadcast("message_updated", { conversationId: conv.id, message: failedMsg }, conv.sectorId,
        isPotentialConversation(conv), await restrictedRecipients(conv));
    }
  }
  return delivered;
}

// Evita dois sorteios do MESMO sorteio ao mesmo tempo neste processo
// (clique duplo no "Sortear agora" ou tick do agendador junto com manual).
const drawInProgress = new Set<number>();

/** Executa um sorteio: escolhe ganhadores ao acaso e envia a mensagem automática. */
export async function runRaffleDraw(raffle: Raffle, periodKey: string): Promise<{ draw: typeof raffleDrawsTable.$inferSelect; eligible: number }> {
  if (drawInProgress.has(raffle.id)) throw new Error("Este sorteio já está sendo executado — aguarde");
  drawInProgress.add(raffle.id);
  try {
    return await doRunRaffleDraw(raffle, periodKey);
  } finally {
    drawInProgress.delete(raffle.id);
  }
}

async function doRunRaffleDraw(raffle: Raffle, periodKey: string): Promise<{ draw: typeof raffleDrawsTable.$inferSelect; eligible: number }> {
  const pool = await eligibleClients(raffle);
  const isAuto = !periodKey.startsWith("manual-");
  // Backstop no banco: registra o período ANTES de enviar qualquer mensagem.
  // Se outro processo já sorteou este período, o índice único barra aqui.
  let placeholderId: number | null = null;
  if (isAuto) {
    try {
      const [ph] = await db.insert(raffleDrawsTable).values({
        raffleId: raffle.id, periodKey, eligibleCount: pool.length, winners: [],
      }).returning({ id: raffleDrawsTable.id });
      placeholderId = ph?.id ?? null;
    } catch {
      throw new Error("Este período já foi sorteado");
    }
  }
  // Embaralha (Fisher-Yates) e pega os N primeiros.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked = pool.slice(0, raffle.winnersCount);

  const winners: Winner[] = [];
  for (const w of picked) {
    let sent = false;
    let error: string | undefined;
    try {
      sent = await sendWhatsAppText(w.conversationId, fillTemplate(raffle.messageTemplate, w, raffle));
      if (!sent) error = "Falha no envio pelo WhatsApp";
    } catch (err) {
      error = err instanceof Error ? err.message : "Erro no envio";
    }
    winners.push({ ...w, sent, ...(error ? { error } : {}) });
  }

  let draw: typeof raffleDrawsTable.$inferSelect;
  if (placeholderId != null) {
    const [upd] = await db.update(raffleDrawsTable).set({ winners, eligibleCount: pool.length })
      .where(eq(raffleDrawsTable.id, placeholderId)).returning();
    draw = upd!;
  } else {
    const [ins] = await db.insert(raffleDrawsTable).values({
      raffleId: raffle.id, periodKey, eligibleCount: pool.length, winners,
    }).returning();
    draw = ins!;
  }

  // Só o fluxo automático marca o período como rodado — sorteio manual não pode
  // "roubar" a chave da recorrência (senão o automático rodaria de novo no mesmo dia).
  if (isAuto) {
    await db.update(rafflesTable).set({ lastRunKey: periodKey }).where(eq(rafflesTable.id, raffle.id));
  }
  return { draw, eligible: pool.length };
}

// ---------- recorrência (chamado pelo agendador) ----------

function spParts(): { ymd: string; weekday: number; day: number; hour: number; isoWeek: string; month: string } {
  const now = new Date();
  const tz = "America/Sao_Paulo";
  const ymd = now.toLocaleDateString("en-CA", { timeZone: tz });
  const wd = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  const day = parseInt(ymd.slice(8, 10), 10);
  const hour = parseInt(now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }), 10);
  return { ymd, weekday, day, hour, isoWeek: `${ymd.slice(0, 4)}-W${ymd}`, month: ymd.slice(0, 7) };
}

let ticking = false;

/** Roda sorteios recorrentes no dia certo (a partir das 10h, horário de Brasília). */
export async function runDueRaffles(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const p = spParts();
    if (p.hour < 10) return; // sorteia a partir das 10h para não madrugar o cliente
    const raffles = await db.select().from(rafflesTable)
      .where(and(eq(rafflesTable.active, true)));
    for (const r of raffles) {
      try {
        let key: string | null = null;
        if (r.recurrence === "weekly" && r.dayOfWeek === p.weekday) key = `${p.ymd}`;
        if (r.recurrence === "monthly" && r.dayOfMonth === p.day) key = p.month;
        if (!key || r.lastRunKey === key) continue;
        // Reivindica de forma atômica: só um processo sorteia por período.
        const [claimed] = await db.update(rafflesTable).set({ lastRunKey: key })
          .where(and(eq(rafflesTable.id, r.id), eq(rafflesTable.active, true),
            r.lastRunKey == null ? sql`${rafflesTable.lastRunKey} IS NULL` : eq(rafflesTable.lastRunKey, r.lastRunKey)))
          .returning();
        if (!claimed) continue;
        await runRaffleDraw({ ...r, lastRunKey: key }, key);
        logger.info({ raffleId: r.id, key }, "Sorteio recorrente executado");
      } catch (err) {
        logger.warn({ err, raffleId: r.id }, "Falha em sorteio recorrente");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de sorteios falhou");
  } finally {
    ticking = false;
  }
}

// ---------- rotas (admin) ----------

router.get("/raffles", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(rafflesTable).orderBy(desc(rafflesTable.id));
  res.json(rows);
});

router.post("/raffles", requireAdmin, async (req, res): Promise<void> => {
  const { data, error } = sanitizeRaffle((req.body ?? {}) as Record<string, unknown>);
  if (!data) { res.status(400).json({ error }); return; }
  const [created] = await db.insert(rafflesTable).values(data).returning();
  res.status(201).json(created);
});

router.patch("/raffles/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [existing] = await db.select().from(rafflesTable).where(eq(rafflesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Sorteio não encontrado" }); return; }
  // Valida o registro FINAL (campos novos por cima dos atuais)
  const merged = { ...existing, ...(req.body ?? {}) } as Record<string, unknown>;
  const { data, error } = sanitizeRaffle(merged);
  if (!data) { res.status(400).json({ error }); return; }
  const [updated] = await db.update(rafflesTable).set(data).where(eq(rafflesTable.id, id)).returning();
  res.json(updated);
});

router.delete("/raffles/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(rafflesTable).where(eq(rafflesTable.id, id));
  res.json({ ok: true });
});

// Prévia: quantos clientes participam com os filtros atuais.
router.get("/raffles/:id/eligible", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [raffle] = await db.select().from(rafflesTable).where(eq(rafflesTable.id, id)).limit(1);
  if (!raffle) { res.status(404).json({ error: "Sorteio não encontrado" }); return; }
  const pool = await eligibleClients(raffle);
  res.json({ count: pool.length });
});

// Sortear agora (manual).
router.post("/raffles/:id/run", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const [raffle] = await db.select().from(rafflesTable).where(eq(rafflesTable.id, id)).limit(1);
  if (!raffle) { res.status(404).json({ error: "Sorteio não encontrado" }); return; }
  const pool = await eligibleClients(raffle);
  if (pool.length === 0) { res.status(400).json({ error: "Nenhum cliente elegível com esses filtros" }); return; }
  const { draw, eligible } = await runRaffleDraw(raffle, `manual-${Date.now()}`);
  res.json({ draw, eligible });
});

router.get("/raffles/:id/draws", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const rows = await db.select().from(raffleDrawsTable)
    .where(eq(raffleDrawsTable.raffleId, id)).orderBy(desc(raffleDrawsTable.id)).limit(50);
  res.json(rows);
});

export default router;
