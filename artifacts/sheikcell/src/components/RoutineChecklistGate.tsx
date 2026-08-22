import { useState, useEffect, useCallback } from "react";
import { api, ApiError, type PendingRoutine } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { ListChecks, KeyRound, X } from "lucide-react";

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

// Fase 2 (Rotinas e Produtividade): checklist "devido agora" pro usuário
// logado — senha → perguntas → envia. AINDA SOFT (dá pra fechar e responder
// depois) — a trava de verdade (não fechável, guard de operação crítica,
// atendimento urgente) é a Fase 3. Mesmo esqueleto de polling/fila do
// ChecklistGate.tsx (Questionários), mas com o passo de senha na frente.
export default function RoutineChecklistGate() {
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingRoutine[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [step, setStep] = useState<"password" | "questions">("password");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    api.rotinas.pending().then(setPending).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000); // reavalia a cada 5 min
    return () => clearInterval(t);
  }, [refresh]);

  const current = pending.find((p) => !dismissed.has(p.id));
  useEffect(() => {
    // Cada checklist novo começa pedindo senha de novo — uma confirmação
    // não vale pra vários (mesma regra do backend, ver clearPasswordVerified).
    setStep("password");
    setPassword("");
    setPasswordError("");
    setAnswers({});
  }, [current?.id]);

  if (!current) return null;

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifying || !password) return;
    setVerifying(true);
    setPasswordError("");
    try {
      await api.auth.verifyPassword(password);
      setStep("questions");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Senha incorreta");
    } finally {
      setVerifying(false);
    }
  };

  const allAnswered = current.questions.every((q) => !q.required || (answers[q.id] ?? "").trim());

  const handleSubmit = async () => {
    if (!allAnswered || saving) return;
    setSaving(true);
    try {
      await api.rotinas.respond(current.id, answers);
      toast({ title: "Checklist enviado. Obrigado!" });
      setPending((prev) => prev.filter((p) => p.id !== current.id));
    } catch (err) {
      if (err instanceof ApiError && err.code === "REAUTH_REQUIRED") {
        // Confirmação expirou (passaram os 5 min) — pede a senha de novo.
        setStep("password");
        setPasswordError("Sua confirmação expirou — confirme a senha de novo.");
      } else {
        toast({ title: "Erro ao enviar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
        refresh(); // pode já ter sido respondido em outro dispositivo
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDismiss = () => setDismissed((prev) => new Set(prev).add(current.id));

  return (
    <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 overflow-y-auto">
      <div className="shk-card w-full max-w-lg p-6 my-8 bg-white relative">
        <button onClick={handleDismiss} title="Responder depois" data-testid="button-dismiss-routine"
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition">
          <X className="w-5 h-5" />
        </button>

        {step === "password" ? (
          <>
            <div className="flex items-center gap-2 mb-1">
              <KeyRound className="w-5 h-5 text-primary" />
              <h3 className="font-bold">{current.name}</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              {current.message || "Confirme sua senha pra responder este checklist."}
            </p>
            <form onSubmit={handleVerifyPassword} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Sua senha</label>
                <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-routine-password" className={INPUT} />
              </div>
              {passwordError && <p className="text-xs text-destructive font-medium">{passwordError}</p>}
              <button type="submit" disabled={verifying || !password} data-testid="button-verify-routine-password"
                className="w-full px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
                {verifying ? "Confirmando..." : "Confirmar senha"}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1">
              <ListChecks className="w-5 h-5 text-primary" />
              <h3 className="font-bold">{current.name}</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              {pending.length - dismissed.size > 1 ? `${pending.length - dismissed.size} pendentes` : "Preencha o checklist abaixo."}
            </p>
            <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
              {current.questions.map((q, idx) => (
                <div key={q.id}>
                  <p className="text-xs font-bold mb-1.5">{idx + 1}. {q.label}{!q.required && <span className="font-normal text-muted-foreground"> (opcional)</span>}</p>
                  {(q.type === "yes_no" || q.type === "done_not_done") && (
                    <div className="flex gap-1.5">
                      {(q.type === "yes_no" ? ["Sim", "Não"] : ["Executado", "Não executado"]).map((opt) => (
                        <button key={opt} type="button" onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                            answers[q.id] === opt ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border hover:bg-secondary"
                          }`}>
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  {(q.type === "text" || q.type === "observation") && (
                    <textarea rows={2} value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      data-testid={`routine-q-${q.id}`}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                  )}
                  {(q.type === "number" || q.type === "value") && (
                    <input type={q.type === "number" ? "number" : "text"} value={answers[q.id] ?? ""}
                      placeholder={q.type === "value" ? "Ex.: 1500,00" : undefined}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      data-testid={`routine-q-${q.id}`} className={INPUT} />
                  )}
                  {(q.type === "photo" || q.type === "document") && (
                    <div>
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-1.5">
                        Anexo de {q.type === "photo" ? "foto" : "documento"} chega numa fase futura — por enquanto, descreva por texto.
                      </p>
                      <textarea rows={2} value={answers[q.id] ?? ""}
                        onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                        data-testid={`routine-q-${q.id}`}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button onClick={handleSubmit} disabled={!allAnswered || saving} data-testid="button-submit-routine"
              className="w-full mt-5 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
              {saving ? "Enviando..." : "Enviar checklist"}
            </button>
            {!allAnswered && <p className="text-[11px] text-muted-foreground text-center mt-2">Responda as perguntas obrigatórias para enviar.</p>}
          </>
        )}
      </div>
    </div>
  );
}
