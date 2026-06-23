/**
 * WhatsApp proxy routes — admin-only.
 * Forwards requests to the whatsapp-bridge (Baileys + Meta Cloud API fallback).
 * Persists session state to whatsapp_sessions DB so the UI always shows
 * the last known status, even after server restart.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "node:crypto";
import { requireAdmin } from "../middlewares/auth";
import { db, whatsappSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const BRIDGE_URL =
  process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";

const _sessionSeed =
  process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret";
const BRIDGE_SECRET = createHmac("sha256", _sessionSeed)
  .update("whatsapp-bridge-v1")
  .digest("hex");

const SESSION_KEY = "default";

export interface BridgeWAState {
  mode: "baileys" | "meta";
  status: "connected" | "qr" | "connecting" | "reconnecting" | "disconnected" | "unconfigured";
  phoneNumber: string | null;
  phoneId: string | null;
  qrDataUrl: string | null;
  errorMessage: string | null;
}

export interface AdminWAState extends BridgeWAState {
  lastHeartbeatAt: string | null;
  bridgeAvailable: boolean;
}

async function persistSessionState(state: BridgeWAState): Promise<void> {
  try {
    const isConnected = state.status === "connected";
    await db
      .insert(whatsappSessionsTable)
      .values({
        sessionKey: SESSION_KEY,
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

async function getCachedState(): Promise<{
  status: string;
  phoneNumber: string | null;
  phoneId: string | null;
  lastHeartbeatAt: string | null;
  errorMessage: string | null;
} | null> {
  try {
    const rows = await db
      .select()
      .from(whatsappSessionsTable)
      .where(eq(whatsappSessionsTable.sessionKey, SESSION_KEY))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      phoneNumber: row.phoneNumber,
      phoneId: row.phoneId,
      lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
      errorMessage: row.errorMessage,
    };
  } catch {
    return null;
  }
}

async function fetchFromBridge(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<{ ok: boolean; data: unknown; status: number }> {
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

router.get("/whatsapp/status", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const { ok, data } = await fetchFromBridge("/whatsapp/status");
    if (ok) {
      const bridgeState = data as BridgeWAState;
      await persistSessionState(bridgeState);
      const cached = await getCachedState();
      const result: AdminWAState = {
        ...bridgeState,
        lastHeartbeatAt: cached?.lastHeartbeatAt ?? null,
        bridgeAvailable: true,
      };
      res.json(result);
      return;
    }
    throw new Error(`Bridge returned non-OK status`);
  } catch {
    const cached = await getCachedState();
    const result: AdminWAState = {
      mode: "baileys",
      status: "reconnecting",
      phoneNumber: cached?.phoneNumber ?? null,
      phoneId: cached?.phoneId ?? null,
      qrDataUrl: null,
      errorMessage: "WhatsApp Bridge indisponível — reconectando…",
      lastHeartbeatAt: cached?.lastHeartbeatAt ?? null,
      bridgeAvailable: false,
    };
    res.json(result);
  }
});

router.post("/whatsapp/reset", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const { ok, data, status } = await fetchFromBridge("/whatsapp/reset", "POST");
    res.status(status).json(data);
    if (ok) {
      await persistSessionState({
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
