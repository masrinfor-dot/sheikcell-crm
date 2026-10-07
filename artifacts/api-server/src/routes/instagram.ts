// Instagram Direct (07/10/2026) — configuração (admin) + webhook e mídia
// públicos (a Meta chama sem login). Lógica em lib/instagram.ts.
import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { existsSync } from "fs";
import { and, eq } from "drizzle-orm";
import { db, sectorsTable, tenantInstagramIntegrationsTable } from "@workspace/db";
import { requireAdmin, requireTenant } from "../middlewares/auth";
import {
  decryptAppSecret, decryptToken, encryptForColumns, fetchInstagramMe, integrationByAccount,
  integrationByTenant, newVerifyToken, parseInstagramWebhook, processInstagramEvents,
  subscribeInstagramWebhook, verifyInstagramSignature, verifyMediaSignature,
} from "../lib/instagram";
import { MEDIA_DIR } from "../lib/whatsappInbound";
import { logger } from "../lib/logger";

const router: IRouter = Router();
export const instagramPublicRouter: IRouter = Router();

function webhookUrl(req: Request): string {
  const configured = process.env["PUBLIC_API_URL"]?.trim();
  if (configured) return `${configured.replace(/\/+$/, "")}/instagram/webhook`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}/api/instagram/webhook`;
}

async function status(req: Request, tenantId: number) {
  const row = await integrationByTenant(tenantId);
  return {
    configured: !!row,
    enabled: row?.enabled ?? false,
    igUserId: row?.igUserId ?? null,
    username: row?.username ?? null,
    tokenLast4: row?.tokenLast4 ?? null,
    tokenExpiresAt: row?.tokenExpiresAt ?? null,
    hasAppSecret: !!row?.encryptedAppSecret,
    sectorId: row?.sectorId ?? null,
    lastWebhookAt: row?.lastWebhookAt ?? null,
    lastError: row?.lastError ?? null,
    // O que colar no painel da Meta (Webhooks do app).
    webhookUrl: webhookUrl(req),
    verifyToken: row?.verifyToken ?? null,
  };
}

router.get("/settings/instagram", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await status(req, tenantId));
});

router.patch("/settings/instagram", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { accessToken, appSecret, sectorId, enabled } = req.body as {
    accessToken?: string; appSecret?: string; sectorId?: number | null; enabled?: boolean;
  };
  const existing = await integrationByTenant(tenantId);

  if (sectorId !== undefined && sectorId !== null) {
    const [s] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
      .where(and(eq(sectorsTable.id, Number(sectorId)), eq(sectorsTable.tenantId, tenantId))).limit(1);
    if (!s) { res.status(400).json({ error: "Setor inválido" }); return; }
  }

  const patch: Partial<typeof tenantInstagramIntegrationsTable.$inferInsert> = {};
  if (accessToken !== undefined) {
    const t = typeof accessToken === "string" ? accessToken.trim() : "";
    if (t.length < 40 || /\s/.test(t)) { res.status(400).json({ error: "Token inválido — copie o token completo gerado no painel da Meta" }); return; }
    const enc = encryptForColumns(t);
    Object.assign(patch, {
      encryptedToken: enc.ciphertext, tokenIv: enc.iv, tokenAuthTag: enc.authTag, tokenKeyVersion: enc.keyVersion,
      tokenLast4: t.slice(-4), tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600_000), lastError: null,
      // Token novo pode ser de outra conta: confirma de novo no "Testar".
      igUserId: null, username: null, enabled: false,
    });
  }
  if (appSecret !== undefined) {
    const s = typeof appSecret === "string" ? appSecret.trim() : "";
    if (!/^[0-9a-f]{32}$/i.test(s)) { res.status(400).json({ error: "Chave secreta do app inválida (32 caracteres, em Configurações do app › Básico › Chave secreta)" }); return; }
    const enc = encryptForColumns(s);
    Object.assign(patch, { encryptedAppSecret: enc.ciphertext, appSecretIv: enc.iv, appSecretAuthTag: enc.authTag, appSecretKeyVersion: enc.keyVersion });
  }
  if (sectorId !== undefined) patch.sectorId = sectorId === null ? null : Number(sectorId);

  if (!existing) {
    if (!patch.encryptedToken) { res.status(400).json({ error: "Cole o token do Instagram primeiro" }); return; }
    await db.insert(tenantInstagramIntegrationsTable).values({
      ...(patch as typeof tenantInstagramIntegrationsTable.$inferInsert),
      tenantId, verifyToken: newVerifyToken(),
    });
  } else if (Object.keys(patch).length > 0) {
    await db.update(tenantInstagramIntegrationsTable).set({ ...patch, updatedAt: new Date() })
      .where(eq(tenantInstagramIntegrationsTable.tenantId, tenantId));
  }

  if (enabled !== undefined) {
    const row = await integrationByTenant(tenantId);
    if (enabled && (!row?.igUserId || !row.encryptedAppSecret)) {
      res.status(400).json({ error: "Antes de ligar: cole a chave secreta do app e clique em Testar conexão" });
      return;
    }
    await db.update(tenantInstagramIntegrationsTable).set({ enabled: !!enabled, updatedAt: new Date() })
      .where(eq(tenantInstagramIntegrationsTable.tenantId, tenantId));
  }
  res.json(await status(req, tenantId));
});

router.post("/settings/instagram/test", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const row = await integrationByTenant(tenantId);
  if (!row) { res.status(400).json({ error: "Cole o token do Instagram primeiro" }); return; }
  const me = await fetchInstagramMe(decryptToken(row));
  if (!me.ok) {
    const msg = (me.error as { error?: { message?: string } })?.error?.message ?? "Token recusado pela Meta";
    await db.update(tenantInstagramIntegrationsTable).set({ lastError: msg }).where(eq(tenantInstagramIntegrationsTable.tenantId, tenantId));
    res.status(502).json({ error: `Não conectou no Instagram: ${msg}` });
    return;
  }
  const igUserId = me.data.user_id ?? me.data.id ?? null;
  if (!igUserId) { res.status(502).json({ error: "A Meta não devolveu o id da conta" }); return; }
  const other = await integrationByAccount(igUserId);
  if (other && other.tenantId !== tenantId) {
    res.status(409).json({ error: "Essa conta do Instagram já está ligada a outra loja" });
    return;
  }
  const sub = await subscribeInstagramWebhook(igUserId, decryptToken(row));
  await db.update(tenantInstagramIntegrationsTable).set({
    igUserId, username: me.data.username ?? null,
    lastError: sub.ok ? null : `Inscrição do webhook: ${sub.error}`,
    updatedAt: new Date(),
  }).where(eq(tenantInstagramIntegrationsTable.tenantId, tenantId));
  res.json({ ok: true, username: me.data.username ?? null, igUserId, webhookSubscribed: sub.ok, webhookError: sub.ok ? null : sub.error });
});

router.delete("/settings/instagram", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  await db.delete(tenantInstagramIntegrationsTable).where(eq(tenantInstagramIntegrationsTable.tenantId, tenantId));
  res.json(await status(req, tenantId));
});

// ─── Público ───────────────────────────────────────────────────────────────

// Verificação do webhook (a Meta manda o "Verify token" que a loja colou lá).
instagramPublicRouter.get("/instagram/webhook", async (req: Request, res: Response): Promise<void> => {
  const mode = req.query["hub.mode"];
  const token = typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : "";
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token) {
    const [row] = await db.select({ tenantId: tenantInstagramIntegrationsTable.tenantId })
      .from(tenantInstagramIntegrationsTable).where(eq(tenantInstagramIntegrationsTable.verifyToken, token)).limit(1);
    if (row) { res.status(200).send(String(challenge ?? "")); return; }
  }
  res.status(403).json({ error: "Forbidden" });
});

instagramPublicRouter.post("/instagram/webhook", async (req: Request, res: Response): Promise<void> => {
  const events = parseInstagramWebhook(req.body);
  if (events.length === 0) { res.sendStatus(200); return; }
  // Assinatura: cada conta é conferida com a chave secreta do app da SUA loja.
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  const accepted: typeof events = [];
  for (const acc of [...new Set(events.map((e) => e.accountId))]) {
    const integ = await integrationByAccount(acc);
    const secret = integ ? decryptAppSecret(integ) : null;
    if (!integ || !secret) continue;
    if (!verifyInstagramSignature(req.rawBody, sig, secret)) {
      logger.warn({ account: acc }, "Instagram: assinatura do webhook inválida");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    accepted.push(...events.filter((e) => e.accountId === acc));
  }
  // A Meta pede resposta rápida — processa depois de responder.
  res.sendStatus(200);
  if (accepted.length > 0) {
    void processInstagramEvents(accepted).catch((err) => logger.error({ err }, "Instagram: falha ao processar webhook"));
  }
});

// Arquivo de mídia por link temporário assinado (só pra Meta baixar o que o
// vendedor enviou). Sem assinatura válida e dentro do prazo, 404.
instagramPublicRouter.get("/instagram/media/:filename", (req: Request, res: Response): void => {
  const filename = path.basename(String(req.params.filename ?? ""));
  const exp = Number(req.query["exp"]);
  const sig = typeof req.query["sig"] === "string" ? req.query["sig"] : "";
  if (!verifyMediaSignature(filename, exp, sig)) { res.status(404).end(); return; }
  const filepath = path.join(MEDIA_DIR, filename);
  if (!existsSync(filepath)) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=600");
  res.sendFile(filepath);
});

export default router;
