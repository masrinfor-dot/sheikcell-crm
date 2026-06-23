/**
 * WhatsApp proxy routes — all management endpoints are admin-only.
 * Requests are forwarded to the whatsapp-bridge internal service at BRIDGE_URL.
 * The bridge uses the Meta Cloud API for sending messages.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "node:crypto";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

const BRIDGE_URL =
  process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";

const _sessionSeed =
  process.env["SESSION_SECRET"] ?? "sheikcell-dev-only-secret";
const BRIDGE_SECRET = createHmac("sha256", _sessionSeed)
  .update("whatsapp-bridge-v1")
  .digest("hex");

async function proxyToBridge(
  req: Request,
  res: Response,
  bridgePath: string,
  method: "GET" | "POST" = "GET",
): Promise<void> {
  try {
    const url = `${BRIDGE_URL}${bridgePath}`;
    const headers: Record<string, string> = {
      "X-Bridge-Secret": BRIDGE_SECRET,
    };
    const init: RequestInit = { method, headers };
    if (method === "POST" && req.body && Object.keys(req.body as object).length > 0) {
      init.body = JSON.stringify(req.body);
      headers["Content-Type"] = "application/json";
    }
    const upstream = await fetch(url, init);
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(await upstream.text());
  } catch (err) {
    res.status(503).json({
      error: "WhatsApp Bridge indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

router.get("/whatsapp/status", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/status"),
);

router.post("/whatsapp/send", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/send", "POST"),
);

export default router;
