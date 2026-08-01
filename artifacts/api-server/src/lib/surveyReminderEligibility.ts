// Elegibilidade do lembrete único da pesquisa de satisfação. Função PURA
// (sem banco/rede) para ser testável: o agendador passa o retrato da conversa
// e a configuração da loja, e recebe a decisão.
//
// Regras (o prazo gravado NO ENVIO é a autoridade — mudar a configuração
// depois nunca reabre uma pesquisa já vencida):
// - só com pesquisa pendente (cliente ainda não respondeu);
// - nunca dois lembretes (surveyReminderSentAt já marcado = fora);
// - só dentro da janela de resposta do RETRATO (surveyWindowHours); pesquisas
//   antigas sem retrato ficam de fora — sem prazo confiável, não lembramos;
// - só depois de reminderHours desde o envio;
// - só WhatsApp 1:1 (nunca grupos);
// - desligável por loja (enabled/reminderEnabled).
export type SurveyReminderConv = {
  pendingSurveyLogId: number | null;
  surveySentAt: Date | null;
  surveyReminderSentAt: Date | null;
  surveyWindowHours: number | null;
  channel: string | null;
  phone: string | null;
};

export type SurveyReminderCfg = {
  enabled: boolean;
  reminderEnabled: boolean;
  reminderHours: number;
};

export function isSurveyReminderDue(conv: SurveyReminderConv, cfg: SurveyReminderCfg, now: number): boolean {
  if (!cfg.enabled || !cfg.reminderEnabled) return false;
  if (conv.pendingSurveyLogId == null) return false; // já respondeu (ou nunca houve pesquisa)
  if (conv.surveyReminderSentAt != null) return false; // lembrete já saiu — nunca um segundo
  if (conv.surveySentAt == null) return false;
  // Prazo autoritativo: o retrato gravado no envio. Sem retrato, não lembramos.
  if (conv.surveyWindowHours == null || conv.surveyWindowHours <= 0) return false;
  const elapsed = now - conv.surveySentAt.getTime();
  if (elapsed < cfg.reminderHours * 3_600_000) return false; // cedo demais
  if (elapsed >= conv.surveyWindowHours * 3_600_000) return false; // janela fechou
  if (conv.channel !== "whatsapp" || !conv.phone || conv.phone.includes("@g.us")) return false;
  return true;
}
