import { Router, type IRouter } from "express";
import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor } from "../middlewares/auth";

const router: IRouter = Router();

// Chaves conhecidas e seus padrões. O alerta de "sem resposta" vem LIGADO
// por padrão; admin/supervisor pode desligar.
const DEFAULTS: Record<string, string> = {
  alert_unanswered_enabled: "true",
  alert_unanswered_minutes: "5",
};

// Todos os papéis leem (o vendedor precisa saber se o alerta está ativo).
router.get("/settings", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(appSettingsTable);
  const map = { ...DEFAULTS };
  for (const r of rows) if (r.key in map) map[r.key] = r.value;
  res.json({
    alertUnansweredEnabled: map.alert_unanswered_enabled === "true",
    alertUnansweredMinutes: Math.max(1, parseInt(map.alert_unanswered_minutes, 10) || 5),
  });
});

// Só admin/supervisor alteram.
router.patch("/settings", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const { alertUnansweredEnabled, alertUnansweredMinutes } = req.body as {
    alertUnansweredEnabled?: boolean;
    alertUnansweredMinutes?: number;
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
  if (updates.length === 0) { res.status(400).json({ error: "Nada para atualizar" }); return; }
  for (const [key, value] of updates) {
    await db.insert(appSettingsTable).values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  }
  const rows = await db.select().from(appSettingsTable);
  const map = { ...DEFAULTS };
  for (const r of rows) if (r.key in map) map[r.key] = r.value;
  res.json({
    alertUnansweredEnabled: map.alert_unanswered_enabled === "true",
    alertUnansweredMinutes: Math.max(1, parseInt(map.alert_unanswered_minutes, 10) || 5),
  });
});

// ── Pesquisa de satisfação: configuração (escala, mensagem, prazo, recompensa) ──
import { getSurveySettings, saveSurveySettings } from "../lib/surveySettings";

router.get("/settings/survey", requireAdminOrSupervisor, async (_req, res): Promise<void> => {
  res.json(await getSurveySettings());
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
  res.json(await saveSurveySettings(body));
});

export default router;
