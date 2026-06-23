/**
 * WhatsApp proxy routes — all management endpoints are admin-only.
 * Requests are forwarded to the whatsapp-bridge internal service at BRIDGE_URL.
 * The bridge handles Baileys session, QR generation, and inbound forwarding.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

const BRIDGE_URL =
  process.env["WHATSAPP_BRIDGE_URL"] ?? "http://localhost:3002";
const BRIDGE_SECRET =
  process.env["WHATSAPP_BRIDGE_SECRET"] ?? "";

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
    const contentType = upstream.headers.get("content-type") ?? "";

    res.status(upstream.status);
    if (contentType.includes("image/")) {
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } else if (contentType.includes("text/html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(await upstream.text());
    } else {
      res.setHeader("Content-Type", "application/json");
      res.send(await upstream.text());
    }
  } catch (err) {
    res.status(503).json({
      error: "WhatsApp Bridge indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── All endpoints require admin role ─────────────────────────────────────
router.get("/whatsapp/", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/"),
);

router.get("/whatsapp/status", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/status"),
);

router.get("/whatsapp/qr", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/qr"),
);

router.post("/whatsapp/send", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/send", "POST"),
);

router.post("/whatsapp/disconnect", requireAdmin, (req, res) =>
  void proxyToBridge(req, res, "/whatsapp/disconnect", "POST"),
);

export default router;
