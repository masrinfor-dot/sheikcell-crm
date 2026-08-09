import { db, appSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// Configuração da pesquisa de satisfação (guardada em app_settings como JSON).
// Editável por admin/supervisor na tela de Resultados.
export type SurveySettings = {
  enabled: boolean;
  // Escala da nota: 5 => 1 a 5 | 10 => 0 a 10
  scaleMax: 5 | 10;
  // Mensagem personalizada. Vazia = mensagem padrão gerada a partir da escala.
  message: string;
  // Agradecimento após a nota. Vazio = padrão. Aceita {nota} como placeholder.
  thankYouMessage: string;
  // Janela (em horas) para a resposta valer como nota. 1–168.
  responseWindowHours: number;
  // Recompensa enviada a quem responde (cupom/voucher). Texto livre.
  rewardEnabled: boolean;
  rewardText: string;
  // Acrescenta na pesquisa o aviso de que quem responder participa do sorteio.
  raffleInvite: boolean;
  // Lembrete único quando o cliente não respondeu a pesquisa.
  reminderEnabled: boolean;
  // Horas após o envio da pesquisa para mandar o lembrete. 1–167.
  reminderHours: number;
};

const KEY = "survey_settings";

export const SURVEY_DEFAULTS: SurveySettings = {
  enabled: true,
  scaleMax: 5,
  message: "",
  thankYouMessage: "",
  responseWindowHours: 48,
  rewardEnabled: false,
  rewardText: "",
  raffleInvite: false,
  reminderEnabled: true,
  reminderHours: 24,
};

export function surveyScaleMin(s: SurveySettings): number {
  return s.scaleMax === 10 ? 0 : 1;
}

// Mensagem final enviada ao cliente (usa a personalizada quando existir).
// `protocol` reforça o número do atendimento (id do attendance_log) — o
// cliente pode citar esse número se precisar falar de novo sobre o mesmo caso.
export function buildSurveyMessage(s: SurveySettings, protocol?: number): string {
  const min = surveyScaleMin(s);
  const base = s.message.trim()
    ? s.message.trim()
    : `Seu atendimento foi finalizado. ✅\n\nDe ${min} a ${s.scaleMax}, que nota você dá para este atendimento? (${s.scaleMax} = excelente)\n\nResponda apenas com o número. Obrigado! 🙏`;
  const withRaffle = s.raffleInvite
    ? `${base}\n\n🎁 Respondendo, você participa do nosso sorteio!`
    : base;
  return protocol != null
    ? `📋 Protocolo do atendimento: #${protocol}\n\n${withRaffle}`
    : withRaffle;
}

// Agradecimento após a nota (usa o personalizado quando existir; {nota} vira a nota).
export function buildThankYouMessage(custom: string | null | undefined, rating: number): string {
  const t = (custom ?? "").trim();
  if (!t) return `Obrigado pela sua avaliação! Nota ${rating} registrada. 🙏`;
  return t.replace(/\{nota\}/gi, String(rating));
}

// Multi-loja: configuração POR LOJA (app_settings tem PK composta tenant_id+key).
export async function getSurveySettings(tenantId: number): Promise<SurveySettings> {
  const [row] = await db.select().from(appSettingsTable)
    .where(and(eq(appSettingsTable.tenantId, tenantId), eq(appSettingsTable.key, KEY))).limit(1);
  if (!row) return { ...SURVEY_DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<SurveySettings>;
    return sanitizeSurveySettings(parsed);
  } catch {
    return { ...SURVEY_DEFAULTS };
  }
}

// Normaliza qualquer entrada (banco ou request) para valores válidos.
export function sanitizeSurveySettings(input: Partial<SurveySettings>): SurveySettings {
  const hours = Math.round(Number(input.responseWindowHours));
  const reminderH = Math.round(Number(input.reminderHours));
  return {
    enabled: input.enabled !== false,
    scaleMax: input.scaleMax === 10 ? 10 : 5,
    message: typeof input.message === "string" ? input.message.slice(0, 1000) : "",
    thankYouMessage: typeof input.thankYouMessage === "string" ? input.thankYouMessage.slice(0, 1000) : "",
    responseWindowHours: Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : SURVEY_DEFAULTS.responseWindowHours,
    rewardEnabled: input.rewardEnabled === true,
    rewardText: typeof input.rewardText === "string" ? input.rewardText.slice(0, 1000) : "",
    raffleInvite: input.raffleInvite === true,
    reminderEnabled: input.reminderEnabled !== false,
    reminderHours: Number.isFinite(reminderH) ? Math.min(167, Math.max(1, reminderH)) : SURVEY_DEFAULTS.reminderHours,
  };
}

export async function saveSurveySettings(tenantId: number, input: Partial<SurveySettings>): Promise<SurveySettings> {
  const clean = sanitizeSurveySettings({ ...(await getSurveySettings(tenantId)), ...input });
  await db.insert(appSettingsTable)
    .values({ tenantId, key: KEY, value: JSON.stringify(clean), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appSettingsTable.tenantId, appSettingsTable.key],
      set: { value: JSON.stringify(clean), updatedAt: new Date() },
    });
  return clean;
}
