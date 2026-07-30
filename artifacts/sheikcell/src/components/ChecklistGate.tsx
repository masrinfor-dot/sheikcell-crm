import { useState, useEffect, useCallback } from "react";
import { api, type PendingChecklist } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { ClipboardCheck, Star } from "lucide-react";

// Bloqueia o uso do sistema enquanto houver questionário OBRIGATÓRIO
// pendente para o usuário. Pendências não-obrigatórias não travam.
export default function ChecklistGate() {
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingChecklist[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    api.checklists.pending()
      .then((all) => setPending(all.filter((p) => p.mandatory)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000); // reavalia a cada 5 min (virada de dia)
    return () => clearInterval(t);
  }, [refresh]);

  const current = pending[0];
  if (!current) return null;

  const allAnswered = current.questions.every((q) => (answers[q.id] ?? "").trim());

  const handleSubmit = async () => {
    if (!allAnswered || saving) return;
    setSaving(true);
    try {
      await api.checklists.respond(current.id, answers);
      toast({ title: "Questionário enviado. Obrigado!" });
      setAnswers({});
      setPending((prev) => prev.slice(1));
    } catch (err) {
      toast({ title: "Erro ao enviar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
      refresh(); // pode já ter sido respondido em outra aba
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 overflow-y-auto">
      <div className="shk-card w-full max-w-lg p-6 my-8 bg-white">
        <div className="flex items-center gap-2 mb-1">
          <ClipboardCheck className="w-5 h-5 text-primary" />
          <h3 className="font-bold">{current.title}</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          {current.description || "Preenchimento obrigatório para liberar o uso do sistema."}
          {pending.length > 1 && ` (${pending.length} pendentes)`}
        </p>

        <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
          {current.questions.map((q, idx) => (
            <div key={q.id}>
              <p className="text-xs font-bold mb-1.5">{idx + 1}. {q.label}</p>
              {q.type === "text" && (
                <textarea rows={2} value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  data-testid={`gate-q-${q.id}`}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
              )}
              {q.type === "options" && (
                <div className="flex gap-1.5 flex-wrap">
                  {(q.options ?? []).map((opt) => (
                    <button key={opt} onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                        answers[q.id] === opt ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border hover:bg-secondary"
                      }`}>
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              {q.type === "rating" && (
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => setAnswers((a) => ({ ...a, [q.id]: String(n) }))} title={`${n} estrela(s)`}>
                      <Star className={`w-7 h-7 transition ${parseInt(answers[q.id] ?? "0", 10) >= n ? "fill-amber-400 text-amber-400" : "text-border"}`} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <button onClick={handleSubmit} disabled={!allAnswered || saving}
          data-testid="button-submit-checklist"
          className="w-full mt-5 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
          {saving ? "Enviando..." : "Enviar e liberar o sistema"}
        </button>
        {!allAnswered && <p className="text-[11px] text-muted-foreground text-center mt-2">Responda todas as perguntas para continuar.</p>}
      </div>
    </div>
  );
}
