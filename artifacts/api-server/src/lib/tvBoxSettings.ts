import { db, appSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// Configuração das mensagens automáticas da TV Box (lembrete + cobrança),
// guardada em app_settings como JSON — mesmo padrão de surveySettings.ts.
// Editável por quem tem acesso de edição ao módulo "tvbox".
export type TvBoxSettings = {
  enabled: boolean;
  // Dias ANTES do vencimento pra mandar o lembrete único. 1-27.
  reminderDaysBefore: number;
  // Intervalo (em dias) entre cobranças enquanto a fatura seguir pendente
  // após o vencimento. 1-30.
  overdueMessageIntervalDays: number;
  // Aceita {nome}, {valor}, {vencimento}, {dias}.
  reminderMessageTemplate: string;
  chargeMessageTemplate: string;
};

const KEY = "tv_box_settings";

export const TV_BOX_DEFAULT_REMINDER =
  "Olá {nome}! 📺 Sua mensalidade da TV Box vence em {dias} dia(s), no dia {vencimento} (R$ {valor}). " +
  "Para evitar interrupção do serviço, garanta o pagamento até lá. Qualquer dúvida, estamos à disposição!";

export const TV_BOX_DEFAULT_CHARGE =
  "Olá {nome}! 📺 A mensalidade da TV Box venceu em {vencimento} (R$ {valor}) e está em aberto há {dias} dia(s). " +
  "Por favor, regularize o pagamento para evitar a suspensão do serviço. Qualquer dúvida, estamos à disposição!";

export const TV_BOX_SETTINGS_DEFAULTS: TvBoxSettings = {
  enabled: true,
  reminderDaysBefore: 3,
  overdueMessageIntervalDays: 3,
  reminderMessageTemplate: TV_BOX_DEFAULT_REMINDER,
  chargeMessageTemplate: TV_BOX_DEFAULT_CHARGE,
};

// Multi-loja: configuração POR LOJA (app_settings tem PK composta tenant_id+key).
export async function getTvBoxSettings(tenantId: number): Promise<TvBoxSettings> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, KEY))).limit(1);
  if (!row) return { ...TV_BOX_SETTINGS_DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<TvBoxSettings>;
    return sanitizeTvBoxSettings(parsed);
  } catch {
    return { ...TV_BOX_SETTINGS_DEFAULTS };
  }
}

// Normaliza qualquer entrada (banco ou request) para valores válidos.
export function sanitizeTvBoxSettings(input: Partial<TvBoxSettings>): TvBoxSettings {
  const reminderDays = Math.round(Number(input.reminderDaysBefore));
  const intervalDays = Math.round(Number(input.overdueMessageIntervalDays));
  return {
    enabled: input.enabled !== false,
    reminderDaysBefore: Number.isFinite(reminderDays) ? Math.min(27, Math.max(1, reminderDays)) : TV_BOX_SETTINGS_DEFAULTS.reminderDaysBefore,
    overdueMessageIntervalDays: Number.isFinite(intervalDays) ? Math.min(30, Math.max(1, intervalDays)) : TV_BOX_SETTINGS_DEFAULTS.overdueMessageIntervalDays,
    reminderMessageTemplate: typeof input.reminderMessageTemplate === "string" && input.reminderMessageTemplate.trim()
      ? input.reminderMessageTemplate.slice(0, 1000) : TV_BOX_DEFAULT_REMINDER,
    chargeMessageTemplate: typeof input.chargeMessageTemplate === "string" && input.chargeMessageTemplate.trim()
      ? input.chargeMessageTemplate.slice(0, 1000) : TV_BOX_DEFAULT_CHARGE,
  };
}

export async function saveTvBoxSettings(tenantId: number, input: Partial<TvBoxSettings>): Promise<TvBoxSettings> {
  const clean = sanitizeTvBoxSettings({ ...(await getTvBoxSettings(tenantId)), ...input });
  await db.insert(appSettingsTable)
    .values({ tenantId, key: KEY, value: JSON.stringify(clean), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appSettingsTable.tenantId, appSettingsTable.key],
      set: { value: JSON.stringify(clean), updatedAt: new Date() },
    });
  return clean;
}

// Substitui os placeholders {nome}/{valor}/{vencimento}/{dias} do template.
export function renderTvBoxMessage(template: string, vars: { nome: string; valorCents: number; vencimento: string; dias: number }): string {
  const valor = (vars.valorCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const vencimento = new Date(`${vars.vencimento}T00:00:00`).toLocaleDateString("pt-BR");
  return template
    .replaceAll("{nome}", vars.nome)
    .replaceAll("{valor}", valor)
    .replaceAll("{vencimento}", vencimento)
    .replaceAll("{dias}", String(vars.dias));
}
