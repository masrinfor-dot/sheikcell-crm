import { Router, type IRouter } from "express";
import { db, appSettingsTable, tenantAiCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin, requireAdminOrSupervisor, requireTenant } from "../middlewares/auth";
import { encryptSecret } from "../lib/aiCredentialsCrypto";

const router: IRouter = Router();

// Chaves conhecidas e seus padrões. O alerta de "sem resposta" vem LIGADO
// por padrão; admin/supervisor pode desligar. As chaves branding_* ficam
// vazias por padrão (sem customização = usa a marca Sheikcell padrão no FE).
const DEFAULTS: Record<string, string> = {
  alert_unanswered_enabled: "true",
  alert_unanswered_minutes: "5",
  branding_company_name: "",
  branding_logo: "",
  branding_primary_color: "",
  // Trava anti-disparo em massa do "Atendimento ativo" (outbound via Baileys —
  // sem API oficial da Meta, número real sob risco de ban por uso indevido).
  outbound_hourly_limit: "10",
  outbound_daily_limit: "40",
};

function brandingOf(map: Record<string, string>) {
  return {
    companyName: map.branding_company_name || null,
    logoDataUrl: map.branding_logo || null,
    primaryColor: map.branding_primary_color || null,
  };
}

// Todos os papéis leem (o vendedor precisa saber se o alerta está ativo, e
// todo mundo precisa da marca da loja para o topo/sidebar).
router.get("/settings", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.tenantId, tenantId));
  const map = { ...DEFAULTS };
  for (const r of rows) if (r.key in map) map[r.key] = r.value;
  res.json({
    alertUnansweredEnabled: map.alert_unanswered_enabled === "true",
    alertUnansweredMinutes: Math.max(1, parseInt(map.alert_unanswered_minutes, 10) || 5),
    outboundHourlyLimit: Math.max(1, parseInt(map.outbound_hourly_limit, 10) || 10),
    outboundDailyLimit: Math.max(1, parseInt(map.outbound_daily_limit, 10) || 40),
    branding: brandingOf(map),
  });
});

// Só admin/supervisor alteram.
router.patch("/settings", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { alertUnansweredEnabled, alertUnansweredMinutes, outboundHourlyLimit, outboundDailyLimit } = req.body as {
    alertUnansweredEnabled?: boolean;
    alertUnansweredMinutes?: number;
    outboundHourlyLimit?: number;
    outboundDailyLimit?: number;
  };
  const updates: [string, string][] = [];
  if (alertUnansweredEnabled !== undefined) {
    updates.push(["alert_unanswered_enabled", alertUnansweredEnabled ? "true" : "false"]);
  }
  if (alertUnansweredMinutes !== undefined) {
    const m = Math.round(Number(alertUnansweredMinutes));
    if (!Number.isFinite(m) || m < 1 || m > 120) {
      res.status(400).json({ error: "Minutos deve ser entre 1 e 120" });
      return;
    }
    updates.push(["alert_unanswered_minutes", String(m)]);
  }
  if (outboundHourlyLimit !== undefined) {
    const h = Math.round(Number(outboundHourlyLimit));
    if (!Number.isFinite(h) || h < 1 || h > 200) {
      res.status(400).json({ error: "Limite por hora deve ser entre 1 e 200" });
      return;
    }
    updates.push(["outbound_hourly_limit", String(h)]);
  }
  if (outboundDailyLimit !== undefined) {
    const d = Math.round(Number(outboundDailyLimit));
    if (!Number.isFinite(d) || d < 1 || d > 1000) {
      res.status(400).json({ error: "Limite por dia deve ser entre 1 e 1000" });
      return;
    }
    updates.push(["outbound_daily_limit", String(d)]);
  }
  if (updates.length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  for (const [key, value] of updates) {
    // app_settings agora é chaveado por (tenant_id, key) — o upsert precisa
    // considerar as duas colunas para não colidir entre lojas.
    await db.insert(appSettingsTable).values({ tenantId, key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [appSettingsTable.tenantId, appSettingsTable.key], set: { value, updatedAt: new Date() } });
  }
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.tenantId, tenantId));
  const map = { ...DEFAULTS };
  for (const r of rows) if (r.key in map) map[r.key] = r.value;
  res.json({
    alertUnansweredEnabled: map.alert_unanswered_enabled === "true",
    alertUnansweredMinutes: Math.max(1, parseInt(map.alert_unanswered_minutes, 10) || 5),
    outboundHourlyLimit: Math.max(1, parseInt(map.outbound_hourly_limit, 10) || 10),
    outboundDailyLimit: Math.max(1, parseInt(map.outbound_daily_limit, 10) || 40),
    branding: brandingOf(map),
  });
});

// ── Aparência (logo, nome da empresa, cor principal) — só admin da loja ──────
// Logo guardada como data URL direto no app_settings (mesmo padrão chave/valor
// das outras configurações); valida MIME + assinatura do arquivo como em
// documents.ts para não aceitar SVG/HTML disfarçado de imagem.
const LOGO_MAX_BASE64_CHARS = 700_000; // ~512KB de imagem antes do base64
function logoMatchesMime(buf: Buffer, mime: string): boolean {
  const startsWith = (sig: number[]) => sig.every((b, i) => buf[i] === b);
  switch (mime) {
    case "image/png": return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg": return startsWith([0xff, 0xd8, 0xff]);
    case "image/webp": return startsWith([0x52, 0x49, 0x46, 0x46]) && buf.length > 11 && buf.toString("ascii", 8, 12) === "WEBP";
    default: return false;
  }
}

router.patch("/settings/branding", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { companyName, primaryColor, logoDataUrl } = req.body as {
    companyName?: string | null;
    primaryColor?: string | null;
    logoDataUrl?: string | null;
  };

  const updates: [string, string][] = [];

  if (companyName !== undefined) {
    const name = typeof companyName === "string" ? companyName.trim().slice(0, 80) : "";
    updates.push(["branding_company_name", name]);
  }

  if (primaryColor !== undefined) {
    const color = typeof primaryColor === "string" ? primaryColor.trim() : "";
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      res.status(400).json({ error: "Cor inválida. Use um código hexadecimal, ex.: #1a2e6e" });
      return;
    }
    updates.push(["branding_primary_color", color]);
  }

  if (logoDataUrl !== undefined) {
    if (logoDataUrl === null || logoDataUrl === "") {
      updates.push(["branding_logo", ""]);
    } else if (typeof logoDataUrl === "string") {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(logoDataUrl);
      if (!m) { res.status(400).json({ error: "Formato de logo inválido. Use PNG, JPG ou WEBP." }); return; }
      const [, mime, b64] = m;
      if (b64.length > LOGO_MAX_BASE64_CHARS) { res.status(400).json({ error: "Logo muito grande (máximo 500KB)" }); return; }
      const buf = Buffer.from(b64, "base64");
      if (buf.length === 0 || !logoMatchesMime(buf, mime)) {
        res.status(400).json({ error: "O conteúdo da imagem não corresponde ao tipo informado" });
        return;
      }
      updates.push(["branding_logo", logoDataUrl]);
    } else {
      res.status(400).json({ error: "Logo inválida" });
      return;
    }
  }

  if (updates.length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  for (const [key, value] of updates) {
    await db.insert(appSettingsTable).values({ tenantId, key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [appSettingsTable.tenantId, appSettingsTable.key], set: { value, updatedAt: new Date() } });
  }
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.tenantId, tenantId));
  const map = { ...DEFAULTS };
  for (const r of rows) if (r.key in map) map[r.key] = r.value;
  res.json(brandingOf(map));
});

// ── Pesquisa de satisfação: configuração (escala, mensagem, prazo, recompensa) ──
import { getSurveySettings, saveSurveySettings } from "../lib/surveySettings";

router.get("/settings/survey", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await getSurveySettings(tenantId));
});

router.patch("/settings/survey", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body["scaleMax"] !== undefined && body["scaleMax"] !== 5 && body["scaleMax"] !== 10) {
    res.status(400).json({ error: "Escala deve ser 5 (1 a 5) ou 10 (0 a 10)" });
    return;
  }
  if (body["responseWindowHours"] !== undefined) {
    const h = Math.round(Number(body["responseWindowHours"]));
    if (!Number.isFinite(h) || h < 1 || h > 168) {
      res.status(400).json({ error: "Prazo de resposta deve ser entre 1 e 168 horas" });
      return;
    }
  }
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await saveSurveySettings(tenantId, body));
});

// ── Chave de IA (OpenAI) própria da loja — só admin, é uma credencial sensível ──
// GET nunca devolve a chave em si, só se existe uma configurada, os últimos
// 4 caracteres (pra loja reconhecer qual chave é) e se está em uso.
async function aiCredentialsStatus(tenantId: number) {
  const [cred] = await db.select({ last4: tenantAiCredentialsTable.last4, useOwnKey: tenantAiCredentialsTable.useOwnKey })
    .from(tenantAiCredentialsTable).where(eq(tenantAiCredentialsTable.tenantId, tenantId)).limit(1);
  return { hasKey: !!cred, last4: cred?.last4 ?? null, useOwnKey: cred?.useOwnKey ?? false };
}

router.get("/settings/ai", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await aiCredentialsStatus(tenantId));
});

router.patch("/settings/ai", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { apiKey, useOwnKey } = req.body as { apiKey?: string; useOwnKey?: boolean };

  if (apiKey !== undefined) {
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    // Só valida o formato (prefixo "sk-" das chaves da OpenAI) — a chave só é
    // confirmada de verdade na primeira chamada de IA que a loja fizer.
    if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
      res.status(400).json({ error: "Chave inválida — chaves da OpenAI começam com \"sk-\"" });
      return;
    }
    const enc = encryptSecret(key);
    const last4 = key.slice(-4);
    await db.insert(tenantAiCredentialsTable).values({
      tenantId, encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, keyVersion: enc.keyVersion,
      last4, useOwnKey: true,
    }).onConflictDoUpdate({
      target: tenantAiCredentialsTable.tenantId,
      set: { encryptedApiKey: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, keyVersion: enc.keyVersion, last4, useOwnKey: true, updatedAt: new Date() },
    });
  } else if (useOwnKey !== undefined) {
    const [existing] = await db.select({ tenantId: tenantAiCredentialsTable.tenantId }).from(tenantAiCredentialsTable)
      .where(eq(tenantAiCredentialsTable.tenantId, tenantId)).limit(1);
    if (!existing) { res.status(400).json({ error: "Nenhuma chave configurada ainda" }); return; }
    await db.update(tenantAiCredentialsTable).set({ useOwnKey: !!useOwnKey, updatedAt: new Date() })
      .where(eq(tenantAiCredentialsTable.tenantId, tenantId));
  } else {
    res.status(400).json({ error: "Nada para atualizar" });
    return;
  }

  res.json(await aiCredentialsStatus(tenantId));
});

router.delete("/settings/ai", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  await db.delete(tenantAiCredentialsTable).where(eq(tenantAiCredentialsTable.tenantId, tenantId));
  res.json(await aiCredentialsStatus(tenantId));
});

export default router;
