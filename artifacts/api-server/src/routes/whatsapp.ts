import { Router, type IRouter } from "express";
import { requireAdmin } from "../middlewares/auth";
import { getWAState, sendWAMessage, disconnectWA } from "../lib/whatsapp";
import QRCode from "qrcode";

const router: IRouter = Router();

// All WhatsApp management endpoints are admin-only:
// - status/QR expose sensitive connection info
// - disconnect/send can disrupt the shared channel or send arbitrary messages

// ─── Simple HTML status page (admin-only) ─────────────────────────────────
router.get("/whatsapp/", requireAdmin, (_req, res): void => {
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
<p style="font-size:12px;color:#9ca3af;margin-top:16px">Página atualiza automaticamente a cada 3s</p>
</div></body></html>`);
});

// ─── Status JSON ─────────────────────────────────────────────────────────
router.get("/whatsapp/status", requireAdmin, (_req, res): void => {
  res.json(getWAState());
});

// ─── QR code as PNG ──────────────────────────────────────────────────────
router.get("/whatsapp/qr", requireAdmin, async (_req, res): Promise<void> => {
  const { status } = getWAState();
  if (status !== "qr") {
    res.status(404).json({ error: "QR code não disponível — verifique /whatsapp/status" });
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

// ─── Send message (admin direct-send, not used by ChatCenter agents) ──────
router.post("/whatsapp/send", requireAdmin, async (req, res): Promise<void> => {
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

// ─── Disconnect + start new QR session ───────────────────────────────────
router.post("/whatsapp/disconnect", requireAdmin, async (_req, res): Promise<void> => {
  await disconnectWA(true);
  res.json({ ok: true });
});

export default router;

// Import after export to avoid circular dependency
import { getRawQR } from "../lib/whatsapp";
