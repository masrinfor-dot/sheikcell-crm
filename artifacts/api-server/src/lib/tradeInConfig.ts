// Configuração da Avaliação de Usados que é lida de mais de um lugar (rotas
// da equipe em routes/tradeIn.ts, avaliação pública e — desde 17/09 —
// avaliação por conversa no WhatsApp em lib/bot.ts). Extraído de tradeIn.ts
// pra evitar duplicar a leitura de margem/perguntas em cada porta de
// entrada nova.
import { db, appSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { QUESTIONS_KEY, DEFAULT_QUESTIONS, sanitizeQuestions, type QuestionsConfig } from "./tradeInQuestions";

export type Margins = { t1: number; t2: number; t3: number };
export const MARGIN_DEFAULTS: Margins = { t1: 40, t2: 30, t3: 20 };
export const MARGINS_KEY = "trade_in_margins";

// Multi-loja: margens POR LOJA (app_settings tem PK composta tenant_id+key).
export async function getMargins(tenantId: number): Promise<Margins> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, MARGINS_KEY))).limit(1);
  if (!row) return { ...MARGIN_DEFAULTS };
  try {
    const p = JSON.parse(row.value) as Partial<Margins>;
    const norm = (v: unknown, d: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 90 ? n : d;
    };
    return { t1: norm(p.t1, MARGIN_DEFAULTS.t1), t2: norm(p.t2, MARGIN_DEFAULTS.t2), t3: norm(p.t3, MARGIN_DEFAULTS.t3) };
  } catch {
    return { ...MARGIN_DEFAULTS };
  }
}

// Perguntas do questionário (editáveis por loja) — Apple x Android, guardado
// em app_settings (tenant_id + key). Lógica pura de sanitização/validação em
// tradeInQuestions.ts; aqui só a leitura do banco.
export async function getQuestionsConfig(tenantId: number): Promise<QuestionsConfig> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, QUESTIONS_KEY))).limit(1);
  if (!row) return DEFAULT_QUESTIONS;
  try {
    const { config } = sanitizeQuestions(JSON.parse(row.value));
    return config ?? DEFAULT_QUESTIONS;
  } catch {
    return DEFAULT_QUESTIONS;
  }
}
