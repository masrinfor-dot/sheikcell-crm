// Máquina de estados do robô de pré-atendimento (pura, sem banco) —
// usada tanto nas conversas reais quanto no modo teste do admin.

export type BotQuestion = { question: string; options?: string[] };

export type BotSettingsShape = {
  botName: string;
  greeting: string;
  questions: BotQuestion[];
  knowledgeBase: string;
  doneMessage: string;
  handoffMessage: string;
  urgencyWords: string;
  maxPerConversation: number;
};

export type BotStateShape = {
  stage: number;       // 0 = nada enviado; 1..N = aguardando resposta da pergunta N; N+1 = triagem feita
  answers: string[];
  aiReplies: number;
  active: boolean;
};

export type BotStep =
  | { kind: "silent" }                                     // robô não age
  | { kind: "handoff"; replies: string[] }                 // desativa e passa para humano
  | { kind: "reply"; replies: string[] }                   // segue o fluxo de perguntas
  | { kind: "triage_done"; replies: string[]; answers: string[] } // acabou a triagem → classificar com IA
  | { kind: "ai_question"; question: string };             // dúvida livre → responder com IA (se houver limite)

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function wantsHuman(text: string): boolean {
  const t = norm(text);
  return /\b(atendente|humano|pessoa de verdade|falar com alguem|falar com um vendedor|vendedor)\b/.test(t);
}

function isUrgent(text: string, urgencyWords: string): boolean {
  const t = norm(text);
  return urgencyWords.split(",").map((w) => norm(w.trim())).filter(Boolean)
    .some((w) => t.includes(w));
}

function formatQuestion(q: BotQuestion): string {
  if (!q.options || q.options.length === 0) return q.question;
  const opts = q.options.map((o, i) => `${i + 1} - ${o}`).join("\n");
  return `${q.question}\n${opts}\n\n(Responda com o número ou escreva)`;
}

/** Traduz "2" para o texto da opção 2, quando a pergunta tem opções. */
function resolveAnswer(q: BotQuestion | undefined, text: string): string {
  const t = text.trim();
  if (q?.options?.length) {
    const n = parseInt(t, 10);
    if (Number.isFinite(n) && n >= 1 && n <= q.options.length) return q.options[n - 1]!;
  }
  return t.slice(0, 500);
}

/**
 * Processa UMA mensagem do cliente e devolve o próximo passo + estado novo.
 * Não envia nada nem toca no banco — quem chama decide como entregar.
 */
export function botStep(settings: BotSettingsShape, state: BotStateShape, text: string): { step: BotStep; state: BotStateShape } {
  if (!state.active) return { step: { kind: "silent" }, state };

  // Urgência ou pedido de humano: para o robô na hora.
  if (isUrgent(text, settings.urgencyWords) || wantsHuman(text)) {
    return {
      step: { kind: "handoff", replies: [settings.handoffMessage] },
      state: { ...state, active: false },
    };
  }

  const qs = settings.questions;

  // Primeiro contato: saudação + primeira pergunta (ou já cai no modo dúvidas).
  if (state.stage === 0) {
    if (qs.length === 0) {
      return { step: { kind: "reply", replies: [settings.greeting] }, state: { ...state, stage: 1 } };
    }
    return {
      step: { kind: "reply", replies: [settings.greeting, formatQuestion(qs[0]!)] },
      state: { ...state, stage: 1 },
    };
  }

  // Respondendo às perguntas de filtragem.
  if (qs.length > 0 && state.stage <= qs.length) {
    const answers = [...state.answers, resolveAnswer(qs[state.stage - 1], text)];
    if (state.stage < qs.length) {
      return {
        step: { kind: "reply", replies: [formatQuestion(qs[state.stage]!)] },
        state: { ...state, stage: state.stage + 1, answers },
      };
    }
    // Última pergunta respondida: triagem concluída.
    return {
      step: { kind: "triage_done", replies: [settings.doneMessage], answers },
      state: { ...state, stage: qs.length + 1, answers },
    };
  }

  // Pós-triagem: dúvidas livres respondidas pela IA (com limite por conversa).
  if (state.aiReplies >= settings.maxPerConversation) {
    return { step: { kind: "silent" }, state };
  }
  return { step: { kind: "ai_question", question: text.slice(0, 1000) }, state };
}
