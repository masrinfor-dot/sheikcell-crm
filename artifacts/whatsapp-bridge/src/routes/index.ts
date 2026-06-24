import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHmac } from "node:crypto";
import { getWAState, sendWAMessage, sendWAMedia } from "../lib/whatsapp";
import { disconnectAndReset } from "../lib/waConnection";

const router: IRouter = Router();

const SESSION_SECRET_SEED =
  process.env["SESSION_SECRET"] ??
  (process.env["NODE_ENV"] === "production"
    ? (() => { throw new Error("SESSION_SECRET env var is required in production"); })()
    : "sheikcell-dev-only-secret");
const BRIDGE_SECRET = createHmac("sha256", SESSION_SECRET_SEED)
  .update("whatsapp-bridge-v1")
  .digest("hex");

function requireBridgeSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-bridge-secret"];
  if (!provided || provided !== BRIDGE_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.get("/whatsapp/healthz", (_req, res): void => {
  res.json({ ok: true });
});

router.get("/whatsapp/status", requireBridgeSecret, async (_req, res): Promise<void> => {
  res.json(await getWAState());
});

router.post("/whatsapp/reset", requireBridgeSecret, async (_req, res): Promise<void> => {
  await disconnectAndReset();
  res.json({ ok: true, message: "Sessão reiniciada — aguarde o QR code" });
});

router.post("/whatsapp/send", requireBridgeSecret, async (req, res): Promise<void> => {
  const { to, text } = req.body as { to?: string; text?: string };
  if (!to || !text) {
    res.status(400).json({ error: "to e text são obrigatórios" });
    return;
  }
  try {
    await sendWAMessage(to, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Erro ao enviar" });
  }
});

router.post("/whatsapp/send-media", requireBridgeSecret, async (req, res): Promise<void> => {
  const { to, type, base64, mimetype, filename } = req.body as {
    to?: string;
    type?: string;
    base64?: string;
    mimetype?: string;
    filename?: string;
  };
  if (!to || !type || !base64 || !mimetype) {
    res.status(400).json({ error: "to, type, base64 e mimetype são obrigatórios" });
    return;
  }
  if (type !== "image" && type !== "document") {
    res.status(400).json({ error: "type deve ser 'image' ou 'document'" });
    return;
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    await sendWAMedia(to, type, buffer, mimetype, filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Erro ao enviar mídia" });
  }
});

export default router;
