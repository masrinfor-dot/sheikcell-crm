import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import QRCode from "qrcode";
import { getWAState, sendWAMessage, disconnectWA, getRawQR } from "../lib/whatsapp";

const router: IRouter = Router();

// Shared secret between api-server and bridge.
// Must be the same value in both services (WHATSAPP_BRIDGE_SECRET env var).
const BRIDGE_SECRET = process.env["WHATSAPP_BRIDGE_SECRET"] ?? "";

function requireBridgeSecret(req: Request, res: Response, next: NextFunction): void {
  if (!BRIDGE_SECRET) {
    // Secret not configured — reject all requests for safety
    res.status(503).json({ error: "Bridge secret not configured" });
    return;
  }
  const provided = req.headers["x-bridge-secret"];
  if (!provided || provided !== BRIDGE_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Health check is public (used by production startup probe)
router.get("/whatsapp/healthz", (_req, res): void => {
  res.json({ ok: true });
});

router.get("/whatsapp/", requireBridgeSecret, (_req, res): void => {
  const st = getWAState();
  const qrImg = st.qr
    ? `<img src="${st.qr}" alt="QR Code" style="width:220px;height:220px;border-radius:12px;border:1px solid #e5e7eb;" />`
    : "";
  const statusLabel =
    st.status === "connected" ? `🟢 Conectado — +${st.phoneNumber ?? ""}` :
    st.status === "qr" ? "⏳ Aguardando scan do QR code" :
    st.status === "connecting" ? "🔵 Conectando..." :
    "🔴 Desconectado";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>WhatsApp Bridge</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;}
.card{background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:320px;}
h2{margin:0 0 8px}p{color:#6b7280;font-size:14px}</style></head>
<body><div class="card">
<h2>WhatsApp Bridge</h2>
<p style="font-weight:600;color:#111">${statusLabel}</p>
${qrImg ? `<p>Abra WhatsApp → Dispositivos Conectados → Conectar dispositivo</p>${qrImg}` : ""}
<p style="font-size:12px;color:#9ca3af;margin-top:16px">Atualiza a cada 3s</p>
</div></body></html>`);
});

router.get("/whatsapp/status", requireBridgeSecret, (_req, res): void => {
  res.json(getWAState());
});

router.get("/whatsapp/qr", requireBridgeSecret, async (_req, res): Promise<void> => {
  const { status } = getWAState();
  if (status !== "qr") {
    res.status(404).json({ error: "QR code não disponível" });
    return;
  }
  try {
    const raw = getRawQR();
    if (!raw) { res.status(404).json({ error: "QR não disponível" }); return; }
    const buffer = await QRCode.toBuffer(raw, { type: "png", width: 300, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch {
    res.status(500).json({ error: "Erro ao gerar QR" });
  }
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

router.post("/whatsapp/disconnect", requireBridgeSecret, async (_req, res): Promise<void> => {
  await disconnectWA(true);
  res.json({ ok: true });
});

export default router;
