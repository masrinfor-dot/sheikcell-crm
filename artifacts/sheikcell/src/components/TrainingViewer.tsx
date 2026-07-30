import { useState } from "react";
import { api, type Training } from "@/lib/api";
import { youtubeEmbedUrl } from "@/lib/video";
import { useToast } from "@/hooks/use-toast";
import { PlayCircle, CheckCircle, ExternalLink } from "lucide-react";

// Exibe um treinamento (texto, vídeo ou quiz) e permite concluir.
// Usado tanto na aba Treinamentos quanto na trava de uso obrigatório.
export default function TrainingViewer({ training, onCompleted }: { training: Training; onCompleted: () => void }) {
  const { toast } = useToast();
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [lastScore, setLastScore] = useState<number | null>(null);

  const quiz = training.quiz ?? [];
  const allAnswered = training.type !== "quiz" || quiz.every((q) => quizAnswers[q.id] !== undefined);
  const embed = training.type === "video" && training.content ? youtubeEmbedUrl(training.content) : null;

  const handleComplete = async () => {
    if (!allAnswered || saving) return;
    setSaving(true);
    try {
      const r = await api.trainings.complete(training.id, training.type === "quiz" ? quizAnswers : undefined);
      toast({ title: training.type === "quiz" ? `Aprovado! Você acertou ${r.score}%` : "Treinamento concluído!" });
      onCompleted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      const m = msg.match(/acertou (\d+)%/);
      if (m) { setLastScore(parseInt(m[1], 10)); setQuizAnswers({}); }
      toast({ title: training.type === "quiz" ? "Ainda não foi dessa vez" : "Erro", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {training.description && <p className="text-xs text-muted-foreground">{training.description}</p>}

      {training.type === "video" && training.content && (
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

      {training.content && training.type !== "video" && (
        <div className="text-sm whitespace-pre-wrap bg-secondary/40 rounded-xl p-4 max-h-72 overflow-y-auto">{training.content}</div>
      )}

      {training.type === "quiz" && (
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

      <button onClick={handleComplete} disabled={!allAnswered || saving} data-testid="button-complete-training"
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
        <CheckCircle className="w-4 h-4" />
        {saving ? "Enviando..." : training.type === "quiz" ? "Enviar respostas" : "Marcar como concluído"}
      </button>
      {!allAnswered && <p className="text-[11px] text-muted-foreground text-center">Responda todas as perguntas do quiz para enviar.</p>}
    </div>
  );
}
