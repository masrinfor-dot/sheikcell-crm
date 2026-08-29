/**
 * WhatsApp proxy routes — admin-only. MULTI-SESSION.
 * Forwards requests to the whatsapp-bridge (Baileys + Meta Cloud API fallback).
 * Persists session state to whatsapp_sessions DB so the UI always shows
 * the last known status per connection, even after server restart.
 */
import { Router, type IRouter } from "express";
import { createHmac } from "node:crypto";
import { requireFeature, requireTenant } from "../middlewares/auth";
import { db, whatsappSessionsTable, conversationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { assertWithinLimit } from "../lib/planLimits";

const router: IRouter = Router();

const BRIDGE_URL =
  process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";

const _sessionSeed =
  process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret";
const BRIDGE_SECRET = createHmac("sha256", _sessionSeed)
  .update("whatsapp-bridge-v1")
  .digest("hex");

const DEFAULT_SESSION_KEY = "default";
const VALID_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface BridgeWAState {
  sessionKey?: string;
  mode: "baileys" | "meta";
  status: "connected" | "qr" | "connecting" | "reconnecting" | "disconnected" | "unconfigured";
  phoneNumber: string | null;
  phoneId: string | null;
  qrDataUrl: string | null;
  errorMessage: string | null;
}

export interface AdminWAState extends BridgeWAState {
  sessionKey: string;
  displayName: string | null;
  lastHeartbeatAt: string | null;
  bridgeAvailable: boolean;
  color: string;
  icon: string | null;
}

async function persistSessionState(tenantId: number, key: string, state: BridgeWAState): Promise<void> {
  try {
    const isConnected = state.status === "connected";
    await db
      .insert(whatsappSessionsTable)
      .values({
        tenantId,
        sessionKey: key,
        status: state.status,
        phoneNumber: state.phoneNumber,
        phoneId: state.phoneId,
        errorMessage: state.errorMessage,
        lastHeartbeatAt: isConnected ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: whatsappSessionsTable.sessionKey,
        set: {
          status: state.status,
          phoneNumber: state.phoneNumber,
          phoneId: state.phoneId,
          errorMessage: state.errorMessage,
          lastHeartbeatAt: isConnected ? new Date() : undefined,
          updatedAt: new Date(),
        },
      });
  } catch {
    /* non-critical */
  }
}

// Multi-loja: lista apenas as conexões (whatsapp_sessions) da loja do usuário.
async function getSessionRows(tenantId: number): Promise<(typeof whatsappSessionsTable.$inferSelect)[]> {
  try {
    return await db.select().from(whatsappSessionsTable)
      .where(eq(whatsappSessionsTable.tenantId, tenantId))
      .orderBy(whatsappSessionsTable.id);
  } catch {
    return [];
  }
}

async function fetchFromBridge(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
): Promise<{ ok: boolean; data: unknown; status: number }> {
  const url = `${BRIDGE_URL}${path}`;
  const headers: Record<string, string> = { "X-Bridge-Secret": BRIDGE_SECRET };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(8000) };
  if (method === "POST" && body) {
    init.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, data, status: res.status };
}

function offlineState(
  row: typeof whatsappSessionsTable.$inferSelect | undefined,
  key: string,
): AdminWAState {
  return {
    sessionKey: key,
    displayName: row?.displayName ?? null,
    mode: "baileys",
    status: "reconnecting",
    phoneNumber: row?.phoneNumber ?? null,
    phoneId: row?.phoneId ?? null,
    qrDataUrl: null,
    errorMessage: "WhatsApp Bridge indisponível — reconectando…",
    lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
    bridgeAvailable: false,
    color: row?.color ?? "#10b981",
    icon: row?.icon ?? null,
  };
}

// ─── List all connections (DB rows merged with live bridge state) ──────────
// Multi-loja: só as conexões da loja do usuário. As chaves pertencentes à loja
// são as linhas do DB dessa loja (mais a "default" quando é a loja 1 legada);
// o estado ao vivo do bridge é mesclado só para essas chaves — nunca expomos
// conexões de outras lojas mesmo que o bridge as conheça.
router.get("/whatsapp/sessions", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await getSessionRows(tenantId);
  const rowMap = new Map(rows.map((r) => [r.sessionKey, r]));

  let bridgeStates: BridgeWAState[] = [];
  let bridgeAvailable = true;
  try {
    const { ok, data } = await fetchFromBridge("/whatsapp/sessions");
    if (!ok) throw new Error("bridge error");
    bridgeStates = data as BridgeWAState[];
  } catch {
    bridgeAvailable = false;
  }

  // Chaves visíveis a esta loja: as linhas do DB da loja + a "default" (loja 1).
  const keys = [...new Set<string>(rows.map((r) => r.sessionKey))];
  if (tenantId === 1) keys.push(DEFAULT_SESSION_KEY);
  const uniqueKeys = [...new Set(keys)];
  // Sem fallback para a "default" fora da loja 1 — loja nova sem conexões vê
  // lista vazia (fail closed), nunca a conexão de outra loja.

  const result: AdminWAState[] = [];
  for (const key of uniqueKeys) {
    const row = rowMap.get(key);
    const live = bridgeStates.find((s) => s.sessionKey === key);
    if (live) {
      await persistSessionState(tenantId, key, live);
      result.push({
        ...live,
        sessionKey: key,
        displayName: row?.displayName ?? null,
        lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
        bridgeAvailable: true,
        color: row?.color ?? "#10b981",
        icon: row?.icon ?? null,
      });
    } else if (bridgeAvailable) {
      // Bridge is up but doesn't know this session yet — ask it to start it.
      result.push({
        sessionKey: key,
        displayName: row?.displayName ?? null,
        mode: "baileys",
        status: "connecting",
        phoneNumber: row?.phoneNumber ?? null,
        phoneId: row?.phoneId ?? null,
        qrDataUrl: null,
        errorMessage: null,
        lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
        bridgeAvailable: true,
        color: row?.color ?? "#10b981",
        icon: row?.icon ?? null,
      });
      void fetchFromBridge("/whatsapp/sessions", "POST", { session: key }).catch(() => {});
    } else {
      result.push(offlineState(row, key));
    }
  }
  res.json(result);
});

// ─── Create a new connection ────────────────────────────────────────────────
router.post("/whatsapp/sessions", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { displayName } = req.body as { displayName?: string };
  const name = (displayName ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Informe um nome para a conexão (ex.: Vendas, Suporte)" });
    return;
  }
  // Limite do plano (Fase 3 — Planos & Limites): teto de WhatsApps conectados.
  const limitCheck = await assertWithinLimit(tenantId, "maxWhatsapps");
  if (!limitCheck.ok) { res.status(400).json({ error: limitCheck.error }); return; }

  // Generate a key from the name: "Vendas 2" → "vendas-2"
  let slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  if (!slug) slug = `conexao-${Date.now().toString(36)}`;
  // Multi-loja: toda chave nova é prefixada t{tenantId}- para isolar as lojas
  // (chaves legadas sem prefixo pertencem à loja 1). Mantém o padrão VALID_KEY.
  let key = `t${tenantId}-${slug}`.slice(0, 40);
  if (!VALID_KEY.test(key)) key = `t${tenantId}-conexao-${Date.now().toString(36)}`.slice(0, 40);

  const rows = await getSessionRows(tenantId);
  if (rows.some((r) => r.sessionKey === key)) {
    res.status(409).json({ error: "Já existe uma conexão com esse nome" });
    return;
  }

  try {
    await db.insert(whatsappSessionsTable).values({
      tenantId,
      sessionKey: key,
      displayName: name,
      status: "connecting",
      updatedAt: new Date(),
    });
  } catch {
    res.status(500).json({ error: "Erro ao salvar a conexão" });
    return;
  }

  try {
    await fetchFromBridge("/whatsapp/sessions", "POST", { session: key });
  } catch {
    /* bridge offline — it will pick the session up from DB on restart */
  }
  res.status(201).json({ ok: true, sessionKey: key, displayName: name });
});

// ─── Rename a connection ────────────────────────────────────────────────────
router.post("/whatsapp/sessions/:key/rename", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  const { displayName } = req.body as { displayName?: string };
  const name = (displayName ?? "").trim();
  if (!name) { res.status(400).json({ error: "Nome obrigatório" }); return; }
  // Só renomeia se a conexão for da loja do usuário (fail closed).
  const [updated] = await db
    .update(whatsappSessionsTable)
    .set({ displayName: name, updatedAt: new Date() })
    .where(and(eq(whatsappSessionsTable.sessionKey, key), eq(whatsappSessionsTable.tenantId, tenantId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Conexão não encontrada" }); return; }
  res.json({ ok: true });
});

// ─── Change appearance (color/icon) ────────────────────────────────────────
// Identidade visual da conexão na Central — cor de fundo da etiqueta
// "via <número>" e um emoji opcional, pra distinguir de qual número vem
// cada atendimento sem depender só do nome.
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
router.post("/whatsapp/sessions/:key/appearance", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  const b = (req.body ?? {}) as { color?: string; icon?: string | null };
  const update: { color?: string; icon?: string | null; updatedAt: Date } = { updatedAt: new Date() };
  if ("color" in b) {
    if (typeof b.color !== "string" || !HEX_COLOR.test(b.color)) {
      res.status(400).json({ error: "Cor inválida (use #rrggbb)" }); return;
    }
    update.color = b.color;
  }
  if ("icon" in b) {
    update.icon = typeof b.icon === "string" && b.icon.trim() ? b.icon.trim().slice(0, 8) : null;
  }
  // Só muda a aparência se a conexão for da loja do usuário (fail closed).
  const [updated] = await db
    .update(whatsappSessionsTable)
    .set(update)
    .where(and(eq(whatsappSessionsTable.sessionKey, key), eq(whatsappSessionsTable.tenantId, tenantId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Conexão não encontrada" }); return; }
  res.json({ ok: true, color: updated.color, icon: updated.icon });
});

// ─── Remove a connection ────────────────────────────────────────────────────
router.delete("/whatsapp/sessions/:key", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  if (!VALID_KEY.test(key)) { res.status(400).json({ error: "Conexão inválida" }); return; }

  // Conexão principal (default = loja 1): o bridge apaga tudo (logout +
  // credenciais) e volta zerada aguardando um novo QR. Não mexer nas conversas
  // nem na linha do DB. Só a loja 1 pode operar a conexão legada.
  if (key === DEFAULT_SESSION_KEY) {
    if (tenantId !== 1) { res.status(404).json({ error: "Conexão não encontrada" }); return; }
    try {
      const { ok, data, status } = await fetchFromBridge(`/whatsapp/sessions/${key}`, "DELETE");
      if (!ok) { res.status(status).json(data); return; }
      res.json(data);
    } catch {
      res.status(503).json({ error: "WhatsApp Bridge está fora do ar — tente novamente em instantes" });
    }
    return;
  }

  // Fail closed: só apaga uma conexão que pertença à loja do usuário.
  const [owned] = await db.select({ id: whatsappSessionsTable.id }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.sessionKey, key), eq(whatsappSessionsTable.tenantId, tenantId)))
    .limit(1);
  if (!owned) { res.status(404).json({ error: "Conexão não encontrada" }); return; }

  try {
    const { ok, data, status } = await fetchFromBridge(`/whatsapp/sessions/${key}`, "DELETE");
    if (!ok) { res.status(status).json(data); return; }
  } catch {
    // Bridge offline — still remove the DB row so it won't be restarted.
    await db.delete(whatsappSessionsTable)
      .where(and(eq(whatsappSessionsTable.sessionKey, key), eq(whatsappSessionsTable.tenantId, tenantId)));
  }

  // Reatribuição de conversas: SÓ a loja 1 (legado) pode voltar para a conexão
  // "default" — para as demais lojas, `default` pertence à loja 1 e reatribuir
  // enviaria mensagens pelo WhatsApp de outra loja. Nessas, as conversas mantêm
  // a sessionKey antiga (envios passam a falhar explicitamente até o lojista
  // conectar outra sessão — nunca vazam por conexão alheia).
  if (tenantId === 1) {
    await db
      .update(conversationsTable)
      .set({ sessionKey: DEFAULT_SESSION_KEY })
      .where(and(eq(conversationsTable.sessionKey, key), eq(conversationsTable.tenantId, tenantId)));
  }

  res.json({ ok: true });
});

// ─── Status (single session; ?session=key, default "default") ──────────────
router.get("/whatsapp/status", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const raw = req.query["session"];
  if (raw !== undefined && (typeof raw !== "string" || !VALID_KEY.test(raw))) {
    res.status(400).json({ error: "Conexão inválida" });
    return;
  }
  const key = typeof raw === "string" && raw ? raw : DEFAULT_SESSION_KEY;
  // Fail closed: só consulta conexões da própria loja (default = loja 1).
  const rows = await getSessionRows(tenantId);
  const ownsKey = rows.some((r) => r.sessionKey === key) || (key === DEFAULT_SESSION_KEY && tenantId === 1);
  if (!ownsKey) { res.status(404).json({ error: "Conexão não encontrada" }); return; }
  try {
    const { ok, data } = await fetchFromBridge(`/whatsapp/status?session=${encodeURIComponent(key)}`);
    if (ok) {
      const bridgeState = data as BridgeWAState;
      await persistSessionState(tenantId, key, bridgeState);
      const row = rows.find((r) => r.sessionKey === key);
      const result: AdminWAState = {
        ...bridgeState,
        sessionKey: key,
        displayName: row?.displayName ?? null,
        lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
        bridgeAvailable: true,
        color: row?.color ?? "#10b981",
        icon: row?.icon ?? null,
      };
      res.json(result);
      return;
    }
    throw new Error(`Bridge returned non-OK status`);
  } catch {
    res.json(offlineState(rows.find((r) => r.sessionKey === key), key));
  }
});

// ─── Reset (new QR) ─────────────────────────────────────────────────────────
router.post("/whatsapp/reset", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { session } = req.body as { session?: string };
  if (session !== undefined && (typeof session !== "string" || !VALID_KEY.test(session))) {
    res.status(400).json({ error: "Conexão inválida" });
    return;
  }
  const key = session ?? DEFAULT_SESSION_KEY;
  // Fail closed: só reseta conexões da própria loja (default = loja 1).
  const rows = await getSessionRows(tenantId);
  const ownsKey = rows.some((r) => r.sessionKey === key) || (key === DEFAULT_SESSION_KEY && tenantId === 1);
  if (!ownsKey) { res.status(404).json({ error: "Conexão não encontrada" }); return; }
  try {
    const { ok, data, status } = await fetchFromBridge("/whatsapp/reset", "POST", { session: key });
    res.status(status).json(data);
    if (ok) {
      await persistSessionState(tenantId, key, {
        mode: "baileys",
        status: "connecting",
        phoneNumber: null,
        phoneId: null,
        qrDataUrl: null,
        errorMessage: null,
      });
    }
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Bridge indisponível" });
  }
});

router.post("/whatsapp/send", requireFeature("whatsapp"), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  // Fail closed: só permite enviar por uma conexão da própria loja. Sem session
  // informada, assume a conexão padrão (default = loja 1).
  const session = typeof (req.body as { session?: unknown })?.session === "string"
    ? (req.body as { session: string }).session
    : DEFAULT_SESSION_KEY;
  const rows = await getSessionRows(tenantId);
  const ownsKey = rows.some((r) => r.sessionKey === session) || (session === DEFAULT_SESSION_KEY && tenantId === 1);
  if (!ownsKey) { res.status(404).json({ error: "Conexão não encontrada" }); return; }
  try {
    const { ok, data, status } = await fetchFromBridge("/whatsapp/send", "POST", req.body);
    res.status(status).json(data);
  } catch (err) {
    res.status(503).json({
      error: "WhatsApp Bridge indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
