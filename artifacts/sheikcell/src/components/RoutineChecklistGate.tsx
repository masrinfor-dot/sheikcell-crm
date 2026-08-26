import { useState, useEffect, useCallback } from "react";
import { api, ApiError, ROUTINE_NO_REASONS, type PendingRoutine, type RoutineAnswerValue, type RoutineEvidenceUpload } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useActivityGuard } from "@/lib/activityGuard";
import { ListChecks, KeyRound, X, ShieldAlert, Paperclip } from "lucide-react";

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

// Fase 3.5: valor que conta como "resposta negativa" por tipo — só esses
// disparam a justificativa estruturada (motivo/pendência/quem comunicar).
const NEGATIVE_ANSWER: Record<string, string> = { yes_no: "Não", done_not_done: "Não executado" };
type Justification = { motivo: string; pendencia: string; comunicarA: string };
// Fase 4: pergunta pede anexo quando o TIPO dela é a própria evidência
// (foto/documento) ou quando requiresEvidence marca um anexo extra junto
// com o valor normal.
const wantsEvidence = (q: PendingRoutine["questions"][number]) =>
  q.requiresEvidence || q.type === "photo" || q.type === "document";

// Rotinas com mais de um horário por dia: um mesmo checklist pode aparecer
// mais de uma vez em `pending` (uma por ocorrência ainda não respondida no
// dia) — chave composta id+occurrenceTime em vez de só id, senão dispensar
// ou responder uma ocorrência afetaria as outras do mesmo checklist.
const occKey = (p: Pick<PendingRoutine, "id" | "occurrenceTime">) => `${p.id}:${p.occurrenceTime}`;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Fase 3 (Rotinas e Produtividade): checklist "devido agora" pro usuário
// logado — senha → perguntas → envia. Checklist NÃO obrigatório continua
// soft (fechável, "Responder depois"). Checklist OBRIGATÓRIO trava de
// verdade: não fechável, só aparece quando não há operação crítica em
// andamento (ActivityGuard — envio de mensagem, gravação de áudio), e tem
// "Atendimento urgente" como válvula de escape (libera sem marcar como
// respondido, backend registra o uso). Mesmo esqueleto de polling/fila do
// ChecklistGate.tsx (Questionários), mas com o passo de senha na frente.
export default function RoutineChecklistGate() {
  const { toast } = useToast();
  const guard = useActivityGuard();
  const [pending, setPending] = useState<PendingRoutine[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [urgentUntil, setUrgentUntil] = useState<Record<number, number>>({});
  const [step, setStep] = useState<"password" | "questions">("password");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [justifications, setJustifications] = useState<Record<string, Justification>>({});
  const [evidenceFiles, setEvidenceFiles] = useState<Record<string, RoutineEvidenceUpload>>({});
  const [evidenceError, setEvidenceError] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [bypassing, setBypassing] = useState(false);
  // Só existe pra forçar reavaliação de guard.isBusy() (ref, não é reativo
  // sozinho) enquanto um checklist obrigatório espera a operação crítica terminar.
  const [, forceRecheck] = useState(0);

  const refresh = useCallback(() => {
    api.rotinas.pending().then(setPending).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000); // reavalia a cada 5 min
    return () => clearInterval(t);
  }, [refresh]);

  const now = Date.now();
  const current = pending.find((p) => !dismissed.has(occKey(p)) && !(urgentUntil[p.id] > now));
  const waitingOnGuard = !!current?.mandatory && guard.isBusy();

  useEffect(() => {
    // Cada checklist novo começa pedindo senha de novo — uma confirmação
    // não vale pra vários (mesma regra do backend, ver clearPasswordVerified).
    setStep("password");
    setPassword("");
    setPasswordError("");
    setAnswers({});
    setJustifications({});
    setEvidenceFiles({});
    setEvidenceError({});
  }, [current && occKey(current)]);

  useEffect(() => {
    // Checklist obrigatório com operação crítica em andamento: não trava
    // ainda — reavalia a cada poucos segundos até o guard ficar livre.
    if (!waitingOnGuard) return;
    const t = setInterval(() => forceRecheck((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [waitingOnGuard]);

  if (!current || waitingOnGuard) return null;

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

  const needsJustification = (q: PendingRoutine["questions"][number]) =>
    q.requiresJustificationOnNo && answers[q.id] === NEGATIVE_ANSWER[q.type];

  const allAnswered = current.questions.every((q) => {
    // Foto/documento: a evidência É a resposta, não pede o valor de texto.
    if (q.required && !(q.type === "photo" || q.type === "document") && !(answers[q.id] ?? "").trim()) return false;
    if (needsJustification(q) && !(justifications[q.id]?.motivo ?? "").trim()) return false;
    if (q.required && wantsEvidence(q) && !evidenceFiles[q.id]) return false;
    return true;
  });

  const MAX_EVIDENCE_MB = 10;
  const handleEvidenceChange = async (q: PendingRoutine["questions"][number], file: File | null) => {
    if (!file) { setEvidenceFiles((f) => { const n = { ...f }; delete n[q.id]; return n; }); return; }
    if (file.size > MAX_EVIDENCE_MB * 1024 * 1024) {
      setEvidenceError((e) => ({ ...e, [q.id]: `Arquivo muito grande (máx. ${MAX_EVIDENCE_MB}MB)` }));
      return;
    }
    setEvidenceError((e) => { const n = { ...e }; delete n[q.id]; return n; });
    const data = await fileToBase64(file);
    setEvidenceFiles((f) => ({ ...f, [q.id]: { fileName: file.name, mimeType: file.type, data } }));
  };

  const handleSubmit = async () => {
    if (!allAnswered || saving) return;
    setSaving(true);
    try {
      const payload: Record<string, RoutineAnswerValue> = {};
      for (const q of current.questions) {
        const value = answers[q.id];
        if (!value) continue;
        payload[q.id] = needsJustification(q)
          ? { value, motivo: justifications[q.id]?.motivo ?? "", pendencia: justifications[q.id]?.pendencia || null, comunicarA: justifications[q.id]?.comunicarA || null }
          : value;
      }
      await api.rotinas.respond(current.id, payload, evidenceFiles, current.occurrenceTime);
      toast({ title: "Checklist enviado. Obrigado!" });
      // Só remove a ocorrência respondida — checklist com múltiplos
      // horários pode ter outra ocorrência ainda pendente no mesmo dia.
      setPending((prev) => prev.filter((p) => occKey(p) !== occKey(current)));
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

  const handleDismiss = () => setDismissed((prev) => new Set(prev).add(occKey(current)));

  const handleUrgentBypass = async () => {
    if (bypassing) return;
    setBypassing(true);
    try {
      const r = await api.rotinas.urgentBypass(current.id);
      const until = new Date(r.bypassUntil).getTime();
      setUrgentUntil((prev) => ({ ...prev, [current.id]: until }));
      toast({ title: "Atendimento liberado por 20 minutos", description: "O checklist continua pendente — vai aparecer de novo depois." });
    } catch (err) {
      toast({ title: "Erro ao liberar atendimento urgente", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setBypassing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 overflow-y-auto">
      <div className="shk-card w-full max-w-lg p-6 my-8 bg-white relative">
        {current.mandatory ? (
          <button onClick={handleUrgentBypass} disabled={bypassing} title="Libera o sistema por 20 min sem responder — o checklist continua pendente"
            data-testid="button-urgent-bypass"
            className="absolute top-4 right-4 flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 hover:bg-amber-100 transition disabled:opacity-50">
            <ShieldAlert className="w-3.5 h-3.5" /> {bypassing ? "Liberando..." : "Atendimento urgente"}
          </button>
        ) : (
          <button onClick={handleDismiss} title="Responder depois" data-testid="button-dismiss-routine"
            className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition">
            <X className="w-5 h-5" />
          </button>
        )}

        {step === "password" ? (
          <>
            <div className="flex items-center gap-2 mb-1">
              <KeyRound className="w-5 h-5 text-primary" />
              <h3 className="font-bold">{current.name}</h3>
              {current.occurrenceTime && (
                <span className="text-[11px] font-semibold text-primary bg-primary/10 rounded-full px-2 py-0.5">{current.occurrenceTime}</span>
              )}
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
              {current.occurrenceTime && (
                <span className="text-[11px] font-semibold text-primary bg-primary/10 rounded-full px-2 py-0.5">{current.occurrenceTime}</span>
              )}
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
                  {needsJustification(q) && (
                    <div className="mt-2 space-y-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                      <div>
                        <label className="text-[11px] font-semibold text-amber-800 mb-1 block">Motivo</label>
                        <select value={justifications[q.id]?.motivo ?? ""}
                          onChange={(e) => setJustifications((j) => ({ ...j, [q.id]: { motivo: e.target.value, pendencia: j[q.id]?.pendencia ?? "", comunicarA: j[q.id]?.comunicarA ?? "" } }))}
                          data-testid={`routine-q-${q.id}-motivo`}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-amber-300 text-xs bg-white">
                          <option value="">Selecione...</option>
                          {ROUTINE_NO_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-semibold text-amber-800 mb-1 block">Existe alguma pendência? (opcional)</label>
                        <input value={justifications[q.id]?.pendencia ?? ""}
                          onChange={(e) => setJustifications((j) => ({ ...j, [q.id]: { motivo: j[q.id]?.motivo ?? "", pendencia: e.target.value, comunicarA: j[q.id]?.comunicarA ?? "" } }))}
                          data-testid={`routine-q-${q.id}-pendencia`}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-amber-300 text-xs bg-white" />
                      </div>
                      <div>
                        <label className="text-[11px] font-semibold text-amber-800 mb-1 block">Quem precisa ser comunicado? (opcional)</label>
                        <input value={justifications[q.id]?.comunicarA ?? ""}
                          onChange={(e) => setJustifications((j) => ({ ...j, [q.id]: { motivo: j[q.id]?.motivo ?? "", pendencia: j[q.id]?.pendencia ?? "", comunicarA: e.target.value } }))}
                          data-testid={`routine-q-${q.id}-comunicar`}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-amber-300 text-xs bg-white" />
                      </div>
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
                      <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-border text-xs cursor-pointer hover:bg-secondary/40 transition"
                        data-testid={`routine-q-${q.id}-file`}>
                        <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{evidenceFiles[q.id]?.fileName ?? `Selecionar ${q.type === "photo" ? "foto" : "documento"}...`}</span>
                        <input type="file" className="hidden"
                          accept={q.type === "photo" ? "image/jpeg,image/png,image/webp" : "application/pdf,image/jpeg,image/png,image/webp"}
                          onChange={(e) => handleEvidenceChange(q, e.target.files?.[0] ?? null)} />
                      </label>
                      {evidenceError[q.id] && <p className="text-[11px] text-destructive font-medium mt-1">{evidenceError[q.id]}</p>}
                    </div>
                  )}
                  {q.requiresEvidence && q.type !== "photo" && q.type !== "document" && (
                    <div className="mt-1.5">
                      <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-border text-xs cursor-pointer hover:bg-secondary/40 transition"
                        data-testid={`routine-q-${q.id}-file`}>
                        <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{evidenceFiles[q.id]?.fileName ?? `Anexar ${q.evidenceType === "document" ? "documento" : "foto"} de evidência...`}</span>
                        <input type="file" className="hidden"
                          accept={q.evidenceType === "document" ? "application/pdf,image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp"}
                          onChange={(e) => handleEvidenceChange(q, e.target.files?.[0] ?? null)} />
                      </label>
                      {evidenceError[q.id] && <p className="text-[11px] text-destructive font-medium mt-1">{evidenceError[q.id]}</p>}
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
