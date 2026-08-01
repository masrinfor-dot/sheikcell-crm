// Perguntas do questionário de avaliação de usados (editáveis por loja).
// Lógica pura (sem DB) para poder testar: sanitização da config do admin e
// validação estrita das respostas contra o questionário configurado.

export type QOption = { label: string; blocks: boolean };
export type QuestionCfg = { key: string; label: string; options: QOption[] };
export type QuestionsConfig = { apple: QuestionCfg[]; android: QuestionCfg[] };

export const QUESTIONS_KEY = "trade_in_questions";

const COMMON_QUESTIONS: QuestionCfg[] = [
  { key: "Liga", label: "O aparelho liga? (tela acende, sistema inicia e o toque na tela funciona)", options: [{ label: "Sim", blocks: false }, { label: "Não liga", blocks: true }] },
  { key: "Ligações", label: "Faz e recebe ligações pela rede móvel? (chip/operadora — não vale WhatsApp)", options: [{ label: "Sim", blocks: false }, { label: "Não faz ligações", blocks: true }] },
  { key: "Wi-Fi e Bluetooth", label: "Wi-Fi e Bluetooth funcionam normalmente? (conecta, navega e recebe arquivos)", options: [{ label: "Sim", blocks: false }, { label: "Não funciona", blocks: true }] },
  { key: "Marcas de uso", label: "Tem marcas de uso?", options: [{ label: "Sem marcas de uso", blocks: false }, { label: "Quase imperceptíveis", blocks: false }, { label: "Marcas visíveis", blocks: false }] },
  { key: "Carcaça / traseira", label: "Traseira ou laterais trincadas, rachadas, descascando, com peças faltando ou riscos?", options: [{ label: "Não", blocks: false }, { label: "Sim, com avarias", blocks: false }] },
  { key: "Tela", label: "Tela quebrada, trincada, riscada ou com mancha/burn-in (tela fantasma, pixel queimado, LCD vazando)?", options: [{ label: "Não", blocks: false }, { label: "Sim, com avarias", blocks: false }] },
  { key: "Câmeras", label: "As câmeras (frontal e traseira) abrem e registram fotos normalmente?", options: [{ label: "Sem problemas", blocks: false }, { label: "Com problema", blocks: true }] },
  { key: "Acessórios", label: "Acompanha acessórios?", options: [{ label: "Caixa e carregador originais", blocks: false }, { label: "Só carregador", blocks: false }, { label: "Sem acessórios", blocks: false }] },
];

export const DEFAULT_QUESTIONS: QuestionsConfig = {
  apple: [
    ...COMMON_QUESTIONS.slice(0, 6),
    { key: "Biometria", label: "Face ID / Touch ID funciona e cadastra nova biometria?", options: [{ label: "Funciona", blocks: false }, { label: "Não funciona", blocks: true }, { label: "Não tem", blocks: false }] },
    COMMON_QUESTIONS[6]!,
    { key: "Saúde da bateria", label: "Qual o nível de saúde da bateria (Ajustes → Bateria)?", options: [{ label: "Superior a 90%", blocks: false }, { label: "Entre 80% e 90%", blocks: false }, { label: "Inferior a 80%", blocks: false }] },
    { key: "Peça não genuína", label: "Aparece mensagem de \"peça não genuína ou desconhecida\" (Ajustes → Bateria)?", options: [{ label: "Não", blocks: false }, { label: "Sim, aparece", blocks: false }] },
    COMMON_QUESTIONS[7]!,
    { key: "Conta desvinculada", label: "iCloud (Buscar iPhone) já desvinculado?", options: [{ label: "Sim", blocks: false }, { label: "Ainda não", blocks: false }] },
  ],
  android: [
    ...COMMON_QUESTIONS.slice(0, 6),
    { key: "Biometria", label: "Leitor de digital / desbloqueio facial funciona e cadastra nova biometria?", options: [{ label: "Funciona", blocks: false }, { label: "Não funciona", blocks: true }, { label: "Não tem", blocks: false }] },
    COMMON_QUESTIONS[6]!,
    { key: "Bateria", label: "Como está a bateria?", options: [{ label: "Segura bem a carga", blocks: false }, { label: "Descarrega rápido", blocks: false }, { label: "Ruim / estufada", blocks: false }] },
    COMMON_QUESTIONS[7]!,
    { key: "Conta desvinculada", label: "Conta Google já desvinculada?", options: [{ label: "Sim", blocks: false }, { label: "Ainda não", blocks: false }] },
  ],
};

// Sanitiza/valida a config vinda do admin. Retorna erro legível ou a config.
export function sanitizeQuestions(input: unknown): { config?: QuestionsConfig; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Configuração inválida" };
  const out: QuestionsConfig = { apple: [], android: [] };
  for (const group of ["apple", "android"] as const) {
    const list = (input as Record<string, unknown>)[group];
    if (!Array.isArray(list)) return { error: `Lista de perguntas inválida (${group})` };
    if (list.length === 0) return { error: `Inclua pelo menos 1 pergunta (${group === "apple" ? "Apple" : "Android"})` };
    if (list.length > 30) return { error: "Máximo de 30 perguntas por marca" };
    const seenKeys = new Set<string>();
    for (const raw of list) {
      if (!raw || typeof raw !== "object") return { error: "Pergunta inválida" };
      const q = raw as Record<string, unknown>;
      const key = typeof q.key === "string" ? q.key.trim().slice(0, 60) : "";
      const label = typeof q.label === "string" ? q.label.trim().slice(0, 200) : "";
      if (!key || !label) return { error: "Toda pergunta precisa de título curto e texto" };
      if (seenKeys.has(key)) return { error: `Título curto repetido: "${key}"` };
      seenKeys.add(key);
      if (!Array.isArray(q.options) || q.options.length < 2) return { error: `A pergunta "${key}" precisa de pelo menos 2 opções` };
      if (q.options.length > 8) return { error: `Máximo de 8 opções por pergunta ("${key}")` };
      const options: QOption[] = [];
      const seenOpts = new Set<string>();
      for (const rawOpt of q.options) {
        const o = rawOpt as Record<string, unknown> | null;
        const oLabel = o && typeof o.label === "string" ? o.label.trim().slice(0, 80) : "";
        if (!oLabel) return { error: `Opção sem texto na pergunta "${key}"` };
        if (seenOpts.has(oLabel)) return { error: `Opção repetida na pergunta "${key}": "${oLabel}"` };
        seenOpts.add(oLabel);
        options.push({ label: oLabel, blocks: Boolean(o?.blocks) });
      }
      if (options.every((o) => o.blocks)) return { error: `A pergunta "${key}" não pode ter todas as opções bloqueando` };
      out[group].push({ key, label, options });
    }
  }
  return { config: out };
}

// Validação ESTRITA das respostas contra o questionário configurado:
// - nenhuma chave desconhecida
// - toda pergunta configurada respondida
// - cada valor precisa ser uma opção configurada da pergunta
// - opção marcada como "bloqueia" → 422 (loja não avalia)
// Sem isso, dá para burlar o bloqueio chamando a API direto.
export type AnswersValidation =
  | { ok: true }
  | { ok: false; status: 400 | 422; error: string };

export function validateTradeInAnswers(
  questionList: QuestionCfg[],
  answers: Record<string, string>,
): AnswersValidation {
  const byKey = new Map(questionList.map((q) => [q.key, q]));
  for (const key of Object.keys(answers)) {
    if (!byKey.has(key)) {
      return { ok: false, status: 400, error: `Pergunta desconhecida no questionário: "${key}". Recarregue a página e tente novamente.` };
    }
  }
  for (const q of questionList) {
    const val = answers[q.key];
    if (!val) return { ok: false, status: 400, error: `Responda a pergunta "${q.key}" para avaliar.` };
    const opt = q.options.find((o) => o.label === val);
    if (!opt) return { ok: false, status: 400, error: `Resposta inválida para "${q.key}". Recarregue a página e tente novamente.` };
    if (opt.blocks) {
      return { ok: false, status: 422, error: `Não avaliamos aparelho com parte sem funcionar (${q.key.toLowerCase()}: "${val}").` };
    }
  }
  return { ok: true };
}
