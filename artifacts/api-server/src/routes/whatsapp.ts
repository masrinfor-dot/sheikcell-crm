import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { getWAState, sendWAMessage, disconnectWA, startSession } from "../lib/whatsapp";

const router: IRouter = Router();

router.get("/whatsapp/status", requireAuth, (_req, res): void => {
  res.json(getWAState());
});

router.post("/whatsapp/send", requireAuth, async (req, res): Promise<void> => {
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

router.post("/whatsapp/disconnect", requireAuth, async (_req, res): Promise<void> => {
  await disconnectWA();
  res.json({ ok: true });
});

router.post("/whatsapp/reconnect", requireAuth, async (_req, res): Promise<void> => {
  await disconnectWA();
  setTimeout(() => void startSession(), 500);
  res.json({ ok: true });
});

export default router;
