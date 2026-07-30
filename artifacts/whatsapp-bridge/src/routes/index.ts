import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHmac } from "node:crypto";
import { getWAState, sendWAMessage, sendWAMedia } from "../lib/whatsapp";
import {
  disconnectAndReset,
  startSession,
  removeSession,
  getAllSessionStates,
  DEFAULT_SESSION_KEY,
} from "../lib/waConnection";

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

const VALID_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function sessionKeyFrom(raw: unknown): string | null {
  if (raw == null || raw === "") return DEFAULT_SESSION_KEY;
  if (typeof raw !== "string" || !VALID_KEY.test(raw)) return null;
  return raw;
}

router.get("/whatsapp/healthz", (_req, res): void => {
  res.json({ ok: true });
});

// Status of one session (?session=key; default "default")
router.get("/whatsapp/status", requireBridgeSecret, async (req, res): Promise<void> => {
  const key = sessionKeyFrom(req.query["session"]);
  if (!key) { res.status(400).json({ error: "session inválida" }); return; }
  res.json(await getWAState(key));
});

// All sessions with live state
router.get("/whatsapp/sessions", requireBridgeSecret, async (_req, res): Promise<void> => {
  const states = getAllSessionStates();
  const detailed = await Promise.all(states.map((s) => getWAState(s.sessionKey)));
  res.json(detailed);
});

// Start (create) a session
router.post("/whatsapp/sessions", requireBridgeSecret, async (req, res): Promise<void> => {
  const key = sessionKeyFrom((req.body as { session?: string })?.session);
  if (!key) { res.status(400).json({ error: "session inválida (use letras minúsculas, números, - e _)" }); return; }
  await startSession(key);
  res.json({ ok: true, sessionKey: key });
});

// Remove a session permanently
router.delete("/whatsapp/sessions/:key", requireBridgeSecret, async (req, res): Promise<void> => {
  const key = sessionKeyFrom(req.params.key);
  if (!key) { res.status(400).json({ error: "session inválida" }); return; }
  if (key === DEFAULT_SESSION_KEY) {
    // A conexão principal não pode sumir do sistema, mas pode ser "excluída":
    // apaga tudo (logout + credenciais) e volta zerada aguardando novo QR.
    await removeSession(key);
    await startSession(key);
    res.json({ ok: true, restarted: true, message: "Conexão apagada — aguarde o novo QR code" });
    return;
  }
  await removeSession(key);
  res.json({ ok: true });
});

router.post("/whatsapp/reset", requireBridgeSecret, async (req, res): Promise<void> => {
  const key = sessionKeyFrom((req.body as { session?: string })?.session);
  if (!key) { res.status(400).json({ error: "session inválida" }); return; }
  await disconnectAndReset(key);
  res.json({ ok: true, message: "Sessão reiniciada — aguarde o QR code" });
});

router.post("/whatsapp/send", requireBridgeSecret, async (req, res): Promise<void> => {
  const { to, text, session } = req.body as { to?: string; text?: string; session?: string };
  const key = sessionKeyFrom(session);
  if (!key) { res.status(400).json({ error: "session inválida" }); return; }
  if (!to || !text) {
    res.status(400).json({ error: "to e text são obrigatórios" });
    return;
  }
  try {
    await sendWAMessage(key, to, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Erro ao enviar" });
  }
});

router.post("/whatsapp/send-media", requireBridgeSecret, async (req, res): Promise<void> => {
  const { to, type, base64, mimetype, filename, caption, ptt, session } = req.body as {
    to?: string;
    type?: string;
    base64?: string;
    mimetype?: string;
    filename?: string;
    caption?: string;
    ptt?: boolean;
    session?: string;
  };
  const key = sessionKeyFrom(session);
  if (!key) { res.status(400).json({ error: "session inválida" }); return; }
  if (!to || !type || !base64 || !mimetype) {
    res.status(400).json({ error: "to, type, base64 e mimetype são obrigatórios" });
    return;
  }
  if (type !== "image" && type !== "video" && type !== "audio" && type !== "document") {
    res.status(400).json({ error: "type deve ser 'image', 'video', 'audio' ou 'document'" });
    return;
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    await sendWAMedia(key, to, type, buffer, mimetype, filename, caption, ptt);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Erro ao enviar mídia" });
  }
});

export default router;
