import { useState, useEffect, useRef } from "react";
import { api, type Training } from "@/lib/api";
import { youtubeEmbedUrl } from "@/lib/video";
import { useToast } from "@/hooks/use-toast";
import { PlayCircle, CheckCircle, ExternalLink, MoreVertical, PartyPopper, Star } from "lucide-react";

// Exibe um treinamento (texto, vídeo, quiz ou checklist/questionário) e
// permite concluir/responder — quantas vezes o usuário quiser (repetir NUNCA
// apaga tentativa anterior, ver trainings.ts no backend; um checklist só
// aceita uma resposta por período — dia/semana/único — o backend rejeita a
// 2ª tentativa no mesmo período com 409). Usado tanto na aba Treinamentos
// quanto na trava de uso obrigatório (TrainingGate, que não recebe `onExit` —
// treinamento obrigatório não pode ser "saído" sem concluir/responder).
export default function TrainingViewer({
  training, onCompleted, onExit, initialAnswers, skipToQuiz,
}: {
  training: Training;
  onCompleted: () => void;
  onExit?: () => void;
  // Rascunho pra "Continuar de onde parou" — pré-preenche as respostas do quiz.
  initialAnswers?: Record<string, number> | null;
  // "Refazer prova": pula o material de apoio e vai direto pras perguntas.
  skipToQuiz?: boolean;
}) {
  const { toast } = useToast();
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>(initialAnswers ?? {});
  const [checklistAnswers, setChecklistAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [showContent, setShowContent] = useState(!skipToQuiz);
  // Resultado desta tentativa (tela "Treinamento concluído 🎉"). null = ainda
  // não enviou; presente = mostra a tela de fim em vez do conteúdo.
  const [result, setResult] = useState<{ score: number | null } | null>(null);
  const savingProgress = useRef(false);
  // Ponto salvo ao abrir a tela — "Continuar de onde parou" volta pra cá,
  // descartando qualquer resposta trocada nesta sessão que ainda não salvou.
  const draftSnapshot = useRef(initialAnswers ?? {});

  const quiz = training.quiz ?? [];
  const isQuiz = training.type === "quiz";
  const isChecklist = training.type === "checklist";
  const checklistQuestions = training.questions ?? [];
  const allAnswered = isChecklist
    ? checklistQuestions.every((q) => (checklistAnswers[q.id] ?? "").trim())
    : !isQuiz || quiz.every((q) => quizAnswers[q.id] !== undefined);
  const embed = training.type === "video" && training.content ? youtubeEmbedUrl(training.content) : null;

  // Autosalva o rascunho a cada resposta escolhida — é isso que sustenta
  // "Continuar de onde parou". Silencioso: falha aqui não deve travar o quiz.
  useEffect(() => {
    if (!isQuiz || Object.keys(quizAnswers).length === 0 || result) return;
    savingProgress.current = true;
    api.trainings.saveProgress(training.id, quizAnswers).catch(() => {}).finally(() => { savingProgress.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizAnswers]);

  const handleComplete = async () => {
    if (!allAnswered || saving) return;
    setSaving(true);
    try {
      const r = await api.trainings.complete(training.id, isQuiz ? quizAnswers : isChecklist ? checklistAnswers : undefined);
      toast({ title: isQuiz ? `Aprovado! Você acertou ${r.score}%` : isChecklist ? "Respostas enviadas. Obrigado!" : "Treinamento concluído!" });
      setResult({ score: r.score });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      const m = msg.match(/acertou (\d+)%/);
      if (m) { setLastScore(parseInt(m[1], 10)); setQuizAnswers({}); }
      toast({ title: isQuiz ? "Ainda não foi dessa vez" : "Erro", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // "Recomeçar do início": descarta rascunho + respostas locais e mostra o
  // material desde o começo de novo.
  const doRestart = () => {
    setConfirmRestart(false);
    setShowOptions(false);
    api.trainings.clearProgress(training.id).catch(() => {});
    draftSnapshot.current = {};
    setQuizAnswers({});
    setLastScore(null);
    setShowContent(true);
    setResult(null);
  };

  // Tela de fim: "Repetir treinamento" / "Refazer treinamento" — do zero,
  // material + quiz. "Refazer prova" — pula direto pras perguntas.
  const restartFresh = () => { draftSnapshot.current = {}; setQuizAnswers({}); setLastScore(null); setShowContent(true); setResult(null); };
  const restartQuizOnly = () => { draftSnapshot.current = {}; setQuizAnswers({}); setLastScore(null); setShowContent(false); setResult(null); };

  // ── Tela "Treinamento concluído 🎉" ────────────────────────────────────
  if (result) {
    // Checklist não tem "repetir": só aceita nova resposta no próximo período
    // (dia/semana), o backend rejeita uma 2ª resposta no mesmo período.
    if (isChecklist) {
      return (
        <div className="space-y-4 text-center py-2">
          <PartyPopper className="w-10 h-10 text-primary mx-auto" />
          <p className="font-bold text-base">Respostas enviadas 🎉</p>
          <button onClick={onCompleted} data-testid="button-training-finish"
            className="w-full px-3 py-2.5 rounded-xl text-xs font-semibold bg-primary text-white transition">
            Concluir
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-4 text-center py-2">
        <PartyPopper className="w-10 h-10 text-primary mx-auto" />
        <div>
          <p className="font-bold text-base">Treinamento concluído 🎉</p>
          {result.score != null && <p className="text-xs text-muted-foreground mt-1">Você acertou {result.score}% do quiz.</p>}
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button onClick={restartFresh} data-testid="button-training-repeat"
            className="px-3 py-2.5 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
            Repetir treinamento
          </button>
          <button onClick={onCompleted} data-testid="button-training-finish"
            className="px-3 py-2.5 rounded-xl text-xs font-semibold bg-primary text-white transition">
            Concluir
          </button>
          {isQuiz && (
            <>
              <button onClick={restartFresh} data-testid="button-training-redo"
                className="px-3 py-2.5 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Refazer treinamento
              </button>
              <button onClick={restartQuizOnly} data-testid="button-training-redo-quiz"
                className="px-3 py-2.5 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Refazer prova
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Opções: Recomeçar do início / Continuar de onde parou / Sair do treinamento */}
      {(isQuiz || onExit) && (
        <div className="flex justify-end relative -mt-1 -mb-2">
          <button onClick={() => setShowOptions((v) => !v)} data-testid="button-training-options"
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition">
            <MoreVertical className="w-4 h-4" />
          </button>
          {showOptions && (
            <div className="absolute right-0 top-8 z-10 w-56 shk-card p-1.5 bg-white shadow-lg">
              {isQuiz && (
                <button onClick={() => { setShowOptions(false); setConfirmRestart(true); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                  Recomeçar do início
                </button>
              )}
              {isQuiz && Object.keys(draftSnapshot.current).length > 0 && (
                <button onClick={() => { setQuizAnswers(draftSnapshot.current); setShowContent(true); setShowOptions(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                  Continuar de onde parou
                </button>
              )}
              {onExit && (
                <button onClick={() => { setShowOptions(false); onExit(); }} data-testid="button-training-exit"
                  className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50 transition">
                  Sair do treinamento
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Confirmação antes de recomeçar do início */}
      {confirmRestart && (
        <div className="fixed inset-0 bg-black/40 z-[110] flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-5 bg-white">
            <p className="text-sm font-semibold mb-4">Você deseja repetir este treinamento desde o início?</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmRestart(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button onClick={doRestart} data-testid="button-confirm-restart"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white transition">
                Repetir treinamento
              </button>
            </div>
          </div>
        </div>
      )}

      {showContent && training.description && <p className="text-xs text-muted-foreground">{training.description}</p>}

      {showContent && training.type === "video" && training.content && (
        embed ? (
          <div className="aspect-video rounded-xl overflow-hidden border border-border bg-black">
            <iframe src={embed} title={training.title} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
          </div>
        ) : (
          <a href={training.content} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-3 rounded-xl border border-border text-sm font-semibold text-primary hover:bg-secondary transition">
            <PlayCircle className="w-5 h-5" /> Assistir ao vídeo <ExternalLink className="w-3.5 h-3.5 ml-auto" />
          </a>
        )
      )}

      {showContent && training.content && training.type !== "video" && (
        <div className="text-sm whitespace-pre-wrap bg-secondary/40 rounded-xl p-4 max-h-72 overflow-y-auto">{training.content}</div>
      )}

      {isQuiz && (
        <div className="space-y-4">
          {lastScore !== null && (
            <p className="text-xs font-semibold text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
              Você acertou {lastScore}%. Revise o material e tente novamente — é preciso pelo menos 70%.
            </p>
          )}
          {quiz.map((q, idx) => (
            <div key={q.id}>
              <p className="text-xs font-bold mb-1.5">{idx + 1}. {q.label}</p>
              <div className="space-y-1">
                {q.options.map((opt, oi) => (
                  <button key={oi} onClick={() => setQuizAnswers((a) => ({ ...a, [q.id]: oi }))}
                    data-testid={`quiz-${q.id}-${oi}`}
                    className={`w-full text-left px-3 py-2 rounded-xl text-xs font-medium border transition ${
                      quizAnswers[q.id] === oi ? "bg-primary text-white border-primary" : "bg-white text-foreground border-border hover:bg-secondary"
                    }`}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {isChecklist && (
        <div className="space-y-4">
          {checklistQuestions.map((q, idx) => (
            <div key={q.id}>
              <p className="text-xs font-bold mb-1.5">{idx + 1}. {q.label}</p>
              {q.type === "text" && (
                <textarea rows={2} value={checklistAnswers[q.id] ?? ""}
                  onChange={(e) => setChecklistAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  data-testid={`checklist-q-${q.id}`}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
              )}
              {q.type === "options" && (
                <div className="flex gap-1.5 flex-wrap">
                  {(q.options ?? []).map((opt) => (
                    <button key={opt} onClick={() => setChecklistAnswers((a) => ({ ...a, [q.id]: opt }))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                        checklistAnswers[q.id] === opt ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border hover:bg-secondary"
                      }`}>
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {q.type === "rating" && (
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => setChecklistAnswers((a) => ({ ...a, [q.id]: String(n) }))} title={`${n} estrela(s)`}>
                      <Star className={`w-7 h-7 transition ${parseInt(checklistAnswers[q.id] ?? "0", 10) >= n ? "fill-amber-400 text-amber-400" : "text-border"}`} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button onClick={handleComplete} disabled={!allAnswered || saving} data-testid="button-complete-training"
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
        <CheckCircle className="w-4 h-4" />
        {saving ? "Enviando..." : training.type === "quiz" ? "Enviar respostas" : isChecklist ? "Enviar respostas" : "Marcar como concluído"}
      </button>
      {!allAnswered && (
        <p className="text-[11px] text-muted-foreground text-center">
          {isChecklist ? "Responda todas as perguntas para enviar." : "Responda todas as perguntas do quiz para enviar."}
        </p>
      )}
    </div>
  );
}
