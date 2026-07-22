/**
 * WhatsApp proxy routes — admin-only. MULTI-SESSION.
 * Forwards requests to the whatsapp-bridge (Baileys + Meta Cloud API fallback).
 * Persists session state to whatsapp_sessions DB so the UI always shows
 * the last known status per connection, even after server restart.
 */
import { Router, type IRouter } from "express";
import { createHmac } from "node:crypto";
import { requireAdmin } from "../middlewares/auth";
import { db, whatsappSessionsTable, conversationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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
}

async function persistSessionState(key: string, state: BridgeWAState): Promise<void> {
  try {
    const isConnected = state.status === "connected";
    await db
      .insert(whatsappSessionsTable)
      .values({
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

async function getSessionRows(): Promise<(typeof whatsappSessionsTable.$inferSelect)[]> {
  try {
    return await db.select().from(whatsappSessionsTable).orderBy(whatsappSessionsTable.id);
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
  };
}

// ─── List all connections (DB rows merged with live bridge state) ──────────
router.get("/whatsapp/sessions", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await getSessionRows();
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

  const keys = [...new Set<string>([
    ...rows.map((r) => r.sessionKey),
    ...bridgeStates.map((s) => s.sessionKey ?? DEFAULT_SESSION_KEY),
  ])];
  if (keys.length === 0) keys.push(DEFAULT_SESSION_KEY);

  const result: AdminWAState[] = [];
  for (const key of keys) {
    const row = rowMap.get(key);
    const live = bridgeStates.find((s) => s.sessionKey === key);
    if (live) {
      await persistSessionState(key, live);
      result.push({
        ...live,
        sessionKey: key,
        displayName: row?.displayName ?? null,
        lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
        bridgeAvailable: true,
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
      });
      void fetchFromBridge("/whatsapp/sessions", "POST", { session: key }).catch(() => {});
    } else {
      result.push(offlineState(row, key));
    }
  }
  res.json(result);
});

// ─── Create a new connection ────────────────────────────────────────────────
router.post("/whatsapp/sessions", requireAdmin, async (req, res): Promise<void> => {
  const { displayName } = req.body as { displayName?: string };
  const name = (displayName ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Informe um nome para a conexão (ex.: Vendas, Suporte)" });
    return;
  }

  // Generate a key from the name: "Vendas 2" → "vendas-2"
  let key = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  if (!key || !VALID_KEY.test(key)) key = `conexao-${Date.now().toString(36)}`;

  const rows = await getSessionRows();
  if (rows.some((r) => r.sessionKey === key)) {
    res.status(409).json({ error: "Já existe uma conexão com esse nome" });
    return;
  }

  try {
    await db.insert(whatsappSessionsTable).values({
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
router.post("/whatsapp/sessions/:key/rename", requireAdmin, async (req, res): Promise<void> => {
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  const { displayName } = req.body as { displayName?: string };
  const name = (displayName ?? "").trim();
  if (!name) { res.status(400).json({ error: "Nome obrigatório" }); return; }
  await db
    .update(whatsappSessionsTable)
    .set({ displayName: name, updatedAt: new Date() })
    .where(eq(whatsappSessionsTable.sessionKey, key));
  res.json({ ok: true });
});

// ─── Remove a connection ────────────────────────────────────────────────────
router.delete("/whatsapp/sessions/:key", requireAdmin, async (req, res): Promise<void> => {
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  if (key === DEFAULT_SESSION_KEY) {
    res.status(400).json({ error: "A conexão principal não pode ser removida" });
    return;
  }
  if (!VALID_KEY.test(key)) { res.status(400).json({ error: "Conexão inválida" }); return; }

  try {
    const { ok, data, status } = await fetchFromBridge(`/whatsapp/sessions/${key}`, "DELETE");
    if (!ok) { res.status(status).json(data); return; }
  } catch {
    // Bridge offline — still remove the DB row so it won't be restarted.
    await db.delete(whatsappSessionsTable).where(eq(whatsappSessionsTable.sessionKey, key));
  }

  // Conversations from this connection keep working through the default one.
  await db
    .update(conversationsTable)
    .set({ sessionKey: DEFAULT_SESSION_KEY })
    .where(eq(conversationsTable.sessionKey, key));

  res.json({ ok: true });
});

// ─── Status (single session; ?session=key, default "default") ──────────────
router.get("/whatsapp/status", requireAdmin, async (req, res): Promise<void> => {
  const raw = req.query["session"];
  if (raw !== undefined && (typeof raw !== "string" || !VALID_KEY.test(raw))) {
    res.status(400).json({ error: "Conexão inválida" });
    return;
  }
  const key = typeof raw === "string" && raw ? raw : DEFAULT_SESSION_KEY;
  try {
    const { ok, data } = await fetchFromBridge(`/whatsapp/status?session=${encodeURIComponent(key)}`);
    if (ok) {
      const bridgeState = data as BridgeWAState;
      await persistSessionState(key, bridgeState);
      const rows = await getSessionRows();
      const row = rows.find((r) => r.sessionKey === key);
      const result: AdminWAState = {
        ...bridgeState,
        sessionKey: key,
        displayName: row?.displayName ?? null,
        lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
        bridgeAvailable: true,
      };
      res.json(result);
      return;
    }
    throw new Error(`Bridge returned non-OK status`);
  } catch {
    const rows = await getSessionRows();
    res.json(offlineState(rows.find((r) => r.sessionKey === key), key));
  }
});

// ─── Reset (new QR) ─────────────────────────────────────────────────────────
router.post("/whatsapp/reset", requireAdmin, async (req, res): Promise<void> => {
  const { session } = req.body as { session?: string };
  if (session !== undefined && (typeof session !== "string" || !VALID_KEY.test(session))) {
    res.status(400).json({ error: "Conexão inválida" });
    return;
  }
  const key = session ?? DEFAULT_SESSION_KEY;
  try {
    const { ok, data, status } = await fetchFromBridge("/whatsapp/reset", "POST", { session: key });
    res.status(status).json(data);
    if (ok) {
      await persistSessionState(key, {
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

router.post("/whatsapp/send", requireAdmin, async (req, res): Promise<void> => {
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
