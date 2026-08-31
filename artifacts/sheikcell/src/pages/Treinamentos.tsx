import { useState, useEffect } from "react";
import { api, canEditModule, type Training, type TrainingCompletion, type TrainingAttempt, type TrainingPendingUser, type QuizQuestion, type ChecklistQuestion } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import TrainingViewer from "@/components/TrainingViewer";
import {
  GraduationCap, Plus, X, Trash2, Pencil, Eye, CheckCircle, FileText, PlayCircle, HelpCircle, History, CalendarClock, Unlock,
  ClipboardCheck, CalendarDays, Star,
} from "lucide-react";

function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}
function isOverdue(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

const ROLE_LABELS: Record<string, string> = { admin: "Admin", supervisor: "Supervisor", vendedor: "Vendedor" };
const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const REC_LABELS: Record<string, string> = { daily: "Diário", weekly: "Semanal", once: "Uma vez" };
const TYPE_META = {
  text: { label: "Texto", icon: FileText },
  video: { label: "Vídeo", icon: PlayCircle },
  quiz: { label: "Quiz", icon: HelpCircle },
  checklist: { label: "Questionário", icon: ClipboardCheck },
} as const;

type FormQuiz = { label: string; optionsText: string; correct: number };
type FormChecklistQuestion = { label: string; type: ChecklistQuestion["type"]; optionsText: string };

const EMPTY_FORM = {
  title: "", description: "", type: "text" as Training["type"], content: "",
  mandatory: true, active: true, targetRoles: ["vendedor"] as string[],
  quiz: [{ label: "", optionsText: "", correct: 0 }] as FormQuiz[],
  dueDate: "", // yyyy-mm-dd (input type=date) — "" = sem prazo
  // Exclusivos do tipo "checklist" (questionário).
  recurrence: "weekly" as NonNullable<Training["recurrence"]>,
  dayOfWeek: 1,
  startDate: "",
  questions: [{ label: "", type: "text", optionsText: "" }] as FormChecklistQuestion[],
};

// Aba "Treinamentos": admin/supervisor criam material (texto, vídeo, quiz ou
// questionário — este último com recorrência, fundido do antigo módulo
// Questionários direto no banco, ver migration 0071); a equipe consulta e
// conclui/responde. Obrigatórios travam o sistema (TrainingGate).
export default function Treinamentos() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = (user?.role === "admin" || user?.role === "supervisor") && canEditModule(user, "treinamentos");

  const [items, setItems] = useState<Training[]>([]);
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState<Training | null>(null);
  // Rascunho pra retomar ("Continuar de onde parou") — null = tentativa nova/do zero.
  const [openedInitialAnswers, setOpenedInitialAnswers] = useState<Record<string, number> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Training | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<Training | null>(null);
  const [completions, setCompletions] = useState<TrainingCompletion[]>([]);
  const [pendingUsers, setPendingUsers] = useState<TrainingPendingUser[]>([]);
  const [unlockingId, setUnlockingId] = useState<number | null>(null);
  // "Aprender esta tela": qual card tem o menu de ajuda aberto.
  const [helpMenuFor, setHelpMenuFor] = useState<number | null>(null);
  // Confirmação antes de repetir (repetir não apaga a tentativa concluída).
  const [confirmRepeat, setConfirmRepeat] = useState<Training | null>(null);
  // "Ver progresso" / "Ver resultado": histórico de tentativas do PRÓPRIO usuário.
  const [historyOf, setHistoryOf] = useState<Training | null>(null);
  const [historyRows, setHistoryRows] = useState<TrainingAttempt[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchItems = () => api.trainings.list().then(setItems).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { fetchItems(); }, []);

  const openTrainingFresh = (t: Training) => { setOpenedInitialAnswers(null); setOpened(t); };
  const openTrainingContinue = (t: Training) => { setOpenedInitialAnswers(t.draftAnswers ?? null); setOpened(t); };
  const closeOpened = () => { setOpened(null); setOpenedInitialAnswers(null); fetchItems(); };

  const openHistory = async (t: Training) => {
    setHistoryOf(t);
    setHistoryRows([]);
    setHistoryLoading(true);
    try { setHistoryRows(await api.trainings.attempts(t.id)); } catch { /* noop */ } finally { setHistoryLoading(false); }
  };

  const openForm = (t?: Training) => {
    setEditing(t ?? null);
    setForm(t ? {
      title: t.title, description: t.description ?? "", type: t.type, content: t.content ?? "",
      mandatory: t.mandatory, active: t.active !== false, targetRoles: t.targetRoles ?? ["vendedor"],
      quiz: (t.quiz ?? []).length
        ? (t.quiz ?? []).map((q) => ({ label: q.label, optionsText: q.options.join(", "), correct: q.correct ?? 0 }))
        : [{ label: "", optionsText: "", correct: 0 }],
      dueDate: t.dueDate ? t.dueDate.slice(0, 10) : "",
      recurrence: t.recurrence ?? "weekly", dayOfWeek: t.dayOfWeek ?? 1, startDate: t.startDate ?? "",
      questions: (t.questions ?? []).length
        ? (t.questions ?? []).map((q) => ({ label: q.label, type: q.type, optionsText: (q.options ?? []).join(", ") }))
        : [{ label: "", type: "text", optionsText: "" }],
    } : { ...EMPTY_FORM, quiz: [{ label: "", optionsText: "", correct: 0 }], questions: [{ label: "", type: "text", optionsText: "" }] });
    setShowForm(true);
  };

  const quizValid = form.type !== "quiz" || (form.quiz.length > 0 && form.quiz.every((q) => {
    const opts = q.optionsText.split(",").map((o) => o.trim()).filter(Boolean);
    return q.label.trim() && opts.length >= 2 && q.correct >= 0 && q.correct < opts.length;
  }));
  const checklistValid = form.type !== "checklist" || (form.questions.length > 0 && form.questions.every((q) =>
    q.label.trim() && (q.type !== "options" || q.optionsText.split(",").filter((o) => o.trim()).length >= 2)));
  const valid = form.title.trim() && form.targetRoles.length > 0 && quizValid && checklistValid
    && (form.type === "quiz" || form.type === "checklist" || form.content.trim());

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    const payload: Partial<Training> = {
      title: form.title, description: form.description, type: form.type,
      content: form.type === "checklist" ? null : form.content,
      mandatory: form.mandatory, active: form.active, targetRoles: form.targetRoles,
      dueDate: form.dueDate || null,
      ...(form.type === "quiz" ? {
        quiz: form.quiz.map((q, i): QuizQuestion => ({
          id: `q${i + 1}`, label: q.label,
          options: q.optionsText.split(",").map((o) => o.trim()).filter(Boolean),
          correct: q.correct,
        })),
      } : {}),
      ...(form.type === "checklist" ? {
        questions: form.questions.map((q, i): ChecklistQuestion => ({
          id: `q${i + 1}`, label: q.label, type: q.type,
          ...(q.type === "options" ? { options: q.optionsText.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
        })),
        recurrence: form.recurrence, dayOfWeek: form.dayOfWeek, startDate: form.startDate || null,
      } : {}),
    };
    try {
      if (editing) await api.trainings.update(editing.id, payload);
      else await api.trainings.create(payload);
      setShowForm(false);
      fetchItems();
      toast({ title: editing ? "Treinamento atualizado" : "Treinamento criado" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (t: Training) => {
    if (!window.confirm(`Excluir o treinamento "${t.title}"?`)) return;
    try {
      await api.trainings.remove(t.id);
      setItems((prev) => prev.filter((x) => x.id !== t.id));
      toast({ title: "Treinamento excluído" });
    } catch {
      toast({ title: "Erro ao excluir", variant: "destructive" });
    }
  };

  const openCompletions = async (t: Training) => {
    setViewing(t);
    setCompletions([]);
    setPendingUsers([]);
    try { setCompletions(await api.trainings.completions(t.id)); } catch { /* noop */ }
    try { setPendingUsers(await api.trainings.pendingUsers(t.id)); } catch { /* noop */ }
  };

  // "Destravar sistema": pra quando o treinamento travou alguém e não dá pra
  // esperar a conclusão de verdade (treinamento com problema, urgência etc.).
  const handleForceUnlock = async (t: Training, u: TrainingPendingUser) => {
    if (!window.confirm(`Destravar o sistema pra "${u.name}" sem ele concluir "${t.title}"? Fica registrado que foi liberado manualmente.`)) return;
    setUnlockingId(u.id);
    try {
      await api.trainings.forceUnlock(t.id, u.id);
      setPendingUsers((prev) => prev.filter((p) => p.id !== u.id));
      setCompletions(await api.trainings.completions(t.id));
      toast({ title: `Sistema destravado pra ${u.name}` });
    } catch (err) {
      toast({ title: "Erro ao destravar", description: err instanceof Error ? err.message : "Tente novamente", variant: "destructive" });
    } finally {
      setUnlockingId(null);
    }
  };

  const setQz = (i: number, patch: Partial<FormQuiz>) =>
    setForm((f) => ({ ...f, quiz: f.quiz.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  const setQ = (i: number, patch: Partial<FormChecklistQuestion>) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <GraduationCap className="w-5 h-5 text-primary" /> Treinamentos
        </h2>
        {canManage && (
          <button onClick={() => openForm()} data-testid="button-add-training"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Novo treinamento
          </button>
        )}
      </div>

      {loading ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : items.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <GraduationCap className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhum treinamento disponível</p>
          {canManage && <p className="text-xs mt-1">Crie materiais de texto, vídeo, quiz ou questionário para a equipe.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((t) => {
            const Meta = TYPE_META[t.type] ?? TYPE_META.text;
            const hasHistory = (t.attemptCount ?? 0) > 0;
            const hasDraft = !!t.draftAnswers && Object.keys(t.draftAnswers).length > 0;
            const answeredCount = hasDraft ? Object.keys(t.draftAnswers ?? {}).length : 0;
            const totalQuestions = t.quiz?.length ?? 0;
            return (
              <div key={t.id} className="shk-card p-4 flex items-start gap-3" data-testid={`training-${t.id}`}>
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Meta.icon className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-sm break-words">{t.title}</p>
                    <span className="text-[10px] font-bold bg-blue-50 text-blue-600 border border-blue-100 px-2 py-0.5 rounded-full">{Meta.label}</span>
                    {t.type === "checklist" && t.recurrence && (
                      <span className="text-[10px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <CalendarDays className="w-2.5 h-2.5" /> {REC_LABELS[t.recurrence]}{t.recurrence === "weekly" ? ` (${WEEKDAYS[t.dayOfWeek ?? 1]})` : ""}
                      </span>
                    )}
                    {t.mandatory && <span className="text-[10px] font-bold bg-red-50 text-red-600 border border-red-100 px-2 py-0.5 rounded-full">Obrigatório</span>}
                    {canManage && t.active === false && <span className="text-[10px] font-bold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inativo</span>}
                    {t.dueDate && !t.completed && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                        isOverdue(t.dueDate) ? "bg-red-50 text-red-600 border-red-100" : "bg-amber-50 text-amber-700 border-amber-100"
                      }`}>
                        <CalendarClock className="w-2.5 h-2.5" /> Prazo: {formatDueDate(t.dueDate)}{isOverdue(t.dueDate) ? " (vencido)" : ""}
                      </span>
                    )}
                    {hasHistory ? (
                      <span className="text-[10px] font-bold bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Concluído{t.myScore != null ? ` (${t.myScore}%)` : ""}
                      </span>
                    ) : hasDraft && (
                      <span className="text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">Em andamento</span>
                    )}
                  </div>
                  {t.description && <p className="text-xs text-muted-foreground mt-0.5 break-words">{t.description}</p>}
                  {canManage && t.targetRoles && (
                    <p className="text-[11px] text-muted-foreground mt-1">Para: {t.targetRoles.map((r) => ROLE_LABELS[r] ?? r).join(", ")}</p>
                  )}
                  {/* Central de Treinamentos: continua mostrando status/progresso/nota mesmo já concluído. */}
                  {hasHistory && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Status: Concluído · Progresso: 100%{t.myScore != null && ` · Nota: ${t.myScore}%`}
                      {t.attemptCount != null && t.attemptCount > 1 && ` · Tentativas: ${t.attemptCount}`}
                      {t.bestScore != null && t.myScore != null && t.bestScore !== t.myScore && ` · Melhor: ${t.bestScore}%`}
                    </p>
                  )}
                  {!hasHistory && hasDraft && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Status: Em andamento{totalQuestions > 0 ? ` · Progresso: ${answeredCount}/${totalQuestions} perguntas` : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0 relative">
                  {!hasHistory && !hasDraft && (
                    <button onClick={() => openTrainingFresh(t)} data-testid={`button-open-training-${t.id}`}
                      className="px-3 py-1.5 rounded-xl bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition">
                      Fazer
                    </button>
                  )}
                  {hasDraft && (
                    <button onClick={() => openTrainingContinue(t)} data-testid={`button-continue-training-${t.id}`}
                      className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold hover:bg-primary/90 transition">
                      Continuar
                    </button>
                  )}
                  {hasHistory && (
                    <button onClick={() => setConfirmRepeat(t)} data-testid={`button-repeat-training-${t.id}`}
                      className="px-3 py-1.5 rounded-xl bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition">
                      Repetir
                    </button>
                  )}
                  {hasHistory && (
                    <button onClick={() => openHistory(t)} data-testid={`button-history-training-${t.id}`}
                      className="px-3 py-1.5 rounded-xl border border-border text-xs font-bold hover:bg-secondary transition">
                      Ver resultado
                    </button>
                  )}
                  {(hasHistory || hasDraft) && (
                    <div className="relative">
                      <button onClick={() => setHelpMenuFor(helpMenuFor === t.id ? null : t.id)} title="Aprender esta tela"
                        data-testid={`button-help-training-${t.id}`}
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><HelpCircle className="w-3.5 h-3.5" /></button>
                      {helpMenuFor === t.id && (
                        <div className="absolute right-0 top-8 z-10 w-56 shk-card p-1.5 bg-white shadow-lg">
                          <p className="px-3 pt-1.5 pb-1 text-[10px] font-bold text-muted-foreground uppercase">Aprender esta tela</p>
                          {hasDraft && (
                            <button onClick={() => { setHelpMenuFor(null); openTrainingContinue(t); }}
                              className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                              Continuar treinamento
                            </button>
                          )}
                          {hasHistory && (
                            <button onClick={() => { setHelpMenuFor(null); setConfirmRepeat(t); }}
                              className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                              Repetir treinamento
                            </button>
                          )}
                          {hasHistory && (
                            <button onClick={() => { setHelpMenuFor(null); openHistory(t); }}
                              className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold hover:bg-secondary transition">
                              Ver progresso
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {canManage && (
                    <>
                      <button onClick={() => openCompletions(t)} title="Quem concluiu"
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><Eye className="w-3.5 h-3.5" /></button>
                      <button onClick={() => openForm(t)} title="Editar"
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleDelete(t)} title="Excluir"
                        className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition"><Trash2 className="w-3.5 h-3.5" /></button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal fazer/repetir/continuar treinamento */}
      {opened && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">{opened.title}</h3>
              <button onClick={closeOpened}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <TrainingViewer training={opened} initialAnswers={openedInitialAnswers}
              onCompleted={closeOpened} onExit={closeOpened} />
          </div>
        </div>
      )}

      {/* Confirmação antes de repetir — repetir não apaga a tentativa concluída. */}
      {confirmRepeat && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-5 bg-white">
            <p className="text-sm font-semibold mb-4">Você deseja repetir este treinamento desde o início?</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmRepeat(null)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button onClick={() => { const t = confirmRepeat; setConfirmRepeat(null); openTrainingFresh(t); }}
                data-testid="button-confirm-repeat"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white transition">
                Repetir treinamento
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ver progresso / Ver resultado — histórico de tentativas do próprio usuário */}
      {historyOf && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-md p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold flex items-center gap-2"><History className="w-4 h-4 text-primary" /> {historyOf.title}</h3>
              <button onClick={() => setHistoryOf(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {historyLoading ? (
                <div className="h-16 rounded-xl bg-secondary/40 animate-pulse" />
              ) : historyRows.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Nenhuma tentativa registrada ainda.</p>
              ) : historyRows.map((r) => (
                <div key={r.id} className="flex items-center justify-between border-b border-border/50 pb-2 last:border-0">
                  <p className="text-xs font-bold">Tentativa {r.attemptNumber}</p>
                  <div className="text-right">
                    {r.quizScore != null && <span className="text-xs font-bold text-green-700 mr-2">Nota {r.quizScore}%</span>}
                    <span className="text-[10px] text-muted-foreground">
                      Concluído em {new Date(r.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modal criar/editar */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-2xl p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editing ? "Editar treinamento" : "Novo treinamento"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <div>
                <label className="text-xs font-medium mb-1 block">Título</label>
                <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Ex.: Como atender dúvidas sobre garantia" data-testid="input-training-title"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Descrição (opcional)</label>
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>

              <div>
                <label className="text-xs font-medium mb-1 block">Tipo</label>
                <div className="flex gap-1.5">
                  {(Object.keys(TYPE_META) as (keyof typeof TYPE_META)[]).map((ty) => (
                    <button key={ty} onClick={() => setForm((f) => ({ ...f, type: ty }))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                        form.type === ty ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"
                      }`}>
                      {TYPE_META[ty].label}
                    </button>
                  ))}
                </div>
              </div>

              {form.type === "checklist" ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium mb-1 block">Recorrência</label>
                      <select value={form.recurrence} onChange={(e) => setForm((f) => ({ ...f, recurrence: e.target.value as NonNullable<Training["recurrence"]> }))}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                        <option value="daily">Diário</option>
                        <option value="weekly">Semanal</option>
                        <option value="once">Uma vez</option>
                      </select>
                    </div>
                    {form.recurrence === "weekly" && (
                      <div>
                        <label className="text-xs font-medium mb-1 block">Dia da semana</label>
                        <select value={form.dayOfWeek} onChange={(e) => setForm((f) => ({ ...f, dayOfWeek: parseInt(e.target.value, 10) }))}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                          {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="text-xs font-medium mb-1 block">Começa em (opcional)</label>
                      <input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-bold">Perguntas</p>
                    {form.questions.map((q, i) => (
                      <div key={i} className="border border-border rounded-xl p-3 space-y-2">
                        <div className="flex gap-2">
                          <input value={q.label} onChange={(e) => setQ(i, { label: e.target.value })}
                            placeholder={`Pergunta ${i + 1}`} data-testid={`input-question-${i}`}
                            className="flex-1 px-3 py-2 rounded-xl border border-border text-sm" />
                          <select value={q.type} onChange={(e) => setQ(i, { type: e.target.value as ChecklistQuestion["type"] })}
                            className="px-2 py-2 rounded-xl border border-border text-xs bg-white">
                            <option value="text">Texto</option>
                            <option value="options">Opções</option>
                            <option value="rating">Nota (1-5)</option>
                          </select>
                          <button onClick={() => setForm((f) => ({ ...f, questions: f.questions.filter((_, j) => j !== i) }))}
                            disabled={form.questions.length === 1}
                            className="p-2 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {q.type === "options" && (
                          <input value={q.optionsText} onChange={(e) => setQ(i, { optionsText: e.target.value })}
                            placeholder="Opções separadas por vírgula (ex.: Sim, Não, Parcial)"
                            className="w-full px-3 py-2 rounded-xl border border-border text-xs" />
                        )}
                      </div>
                    ))}
                    <button onClick={() => setForm((f) => ({ ...f, questions: [...f.questions, { label: "", type: "text", optionsText: "" }] }))}
                      disabled={form.questions.length >= 30}
                      className="flex items-center gap-1 text-xs font-semibold text-primary disabled:opacity-40">
                      <Plus className="w-3.5 h-3.5" /> Adicionar pergunta
                    </button>
                  </div>
                </>
              ) : form.type !== "quiz" ? (
                <div>
                  <label className="text-xs font-medium mb-1 block">{form.type === "video" ? "Link do vídeo (YouTube abre dentro do sistema)" : "Conteúdo do treinamento"}</label>
                  {form.type === "video" ? (
                    <input value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                      placeholder="https://youtube.com/watch?v=..." data-testid="input-training-content"
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                  ) : (
                    <textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                      rows={6} placeholder="Escreva aqui o material do treinamento..." data-testid="input-training-content"
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                  )}
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-medium mb-1 block">Material de apoio (opcional, aparece antes do quiz)</label>
                    <textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                      rows={3} className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-bold">Perguntas do quiz (mínimo 70% de acerto para concluir)</p>
                    {form.quiz.map((q, i) => {
                      const opts = q.optionsText.split(",").map((o) => o.trim()).filter(Boolean);
                      return (
                        <div key={i} className="border border-border rounded-xl p-3 space-y-2">
                          <div className="flex gap-2">
                            <input value={q.label} onChange={(e) => setQz(i, { label: e.target.value })}
                              placeholder={`Pergunta ${i + 1}`} data-testid={`input-quiz-q-${i}`}
                              className="flex-1 px-3 py-2 rounded-xl border border-border text-sm" />
                            <button onClick={() => setForm((f) => ({ ...f, quiz: f.quiz.filter((_, j) => j !== i) }))}
                              disabled={form.quiz.length === 1}
                              className="p-2 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                          <input value={q.optionsText} onChange={(e) => setQz(i, { optionsText: e.target.value, correct: 0 })}
                            placeholder="Opções separadas por vírgula (ex.: 30 dias, 90 dias, 1 ano)"
                            className="w-full px-3 py-2 rounded-xl border border-border text-xs" />
                          {opts.length >= 2 && (
                            <div>
                              <p className="text-[11px] text-muted-foreground mb-1">Qual é a resposta certa?</p>
                              <div className="flex gap-1.5 flex-wrap">
                                {opts.map((o, oi) => (
                                  <button key={oi} onClick={() => setQz(i, { correct: oi })}
                                    className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
                                      q.correct === oi ? "bg-green-600 text-white border-green-600" : "bg-white text-muted-foreground border-border"
                                    }`}>
                                    {o}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button onClick={() => setForm((f) => ({ ...f, quiz: [...f.quiz, { label: "", optionsText: "", correct: 0 }] }))}
                      disabled={form.quiz.length >= 30}
                      className="flex items-center gap-1 text-xs font-semibold text-primary disabled:opacity-40">
                      <Plus className="w-3.5 h-3.5" /> Adicionar pergunta
                    </button>
                  </div>
                </>
              )}

              <div>
                <label className="text-xs font-medium mb-1 block">Quem participa</label>
                <div className="flex gap-1.5 flex-wrap">
                  {Object.entries(ROLE_LABELS).map(([role, label]) => (
                    <button key={role}
                      onClick={() => setForm((f) => ({
                        ...f,
                        targetRoles: f.targetRoles.includes(role) ? f.targetRoles.filter((r) => r !== role) : [...f.targetRoles, role],
                      }))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                        form.targetRoles.includes(role) ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-4 flex-wrap">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={form.mandatory} onChange={(e) => setForm((f) => ({ ...f, mandatory: e.target.checked }))} />
                  Obrigatório (trava o sistema até concluir)
                </label>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
                  Ativo
                </label>
              </div>

              {form.type !== "checklist" && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Data para realização (opcional)</label>
                  <input type="date" value={form.dueDate} data-testid="input-training-due-date"
                    onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                    className="px-3 py-2 rounded-xl border border-border text-sm" />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Só um prazo mostrado pra equipe — vencer não libera sozinho quem não concluiu; se precisar liberar antes da conclusão, use "Destravar sistema" na lista de quem concluiu.
                  </p>
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">Cancelar</button>
              <button onClick={handleSave} disabled={!valid || saving} data-testid="button-save-training"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal quem concluiu */}
      {viewing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-md p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{viewing.type === "checklist" ? "Respostas" : "Concluíram"} — {viewing.title}</h3>
              <button onClick={() => setViewing(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {completions.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">{viewing.type === "checklist" ? "Nenhuma resposta ainda." : "Ninguém concluiu ainda."}</p>
              ) : completions.map((c) => (
                <div key={c.id} className="border-b border-border/50 pb-2 last:border-0">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold">
                      {c.userName ?? "—"}{c.attemptNumber != null && c.attemptNumber > 1 ? ` · tentativa ${c.attemptNumber}` : ""}
                      {c.forcedByAdminId != null && (
                        <span className="ml-1.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded-full">Liberado manualmente</span>
                      )}
                    </p>
                    <div className="text-right">
                      {c.quizScore != null && <span className="text-xs font-bold text-green-700 mr-2">{c.quizScore}%</span>}
                      <span className="text-[10px] text-muted-foreground">
                        {c.periodKey ? `${c.periodKey} · ` : ""}
                        {new Date(c.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  </div>
                  {viewing.type === "checklist" && c.answers && (
                    <div className="mt-1.5 space-y-1 pl-1">
                      {(viewing.questions ?? []).map((q) => {
                        const raw = (c.answers as Record<string, string> | null | undefined)?.[q.id];
                        return (
                          <div key={q.id} className="text-xs">
                            <span className="text-muted-foreground">{q.label}: </span>
                            {q.type === "rating" ? (
                              <span className="inline-flex align-middle">
                                {[1, 2, 3, 4, 5].map((n) => (
                                  <Star key={n} className={`w-3.5 h-3.5 ${parseInt(raw ?? "0", 10) >= n ? "fill-amber-400 text-amber-400" : "text-border"}`} />
                                ))}
                              </span>
                            ) : (
                              <span className="font-semibold">{raw ?? "—"}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {pendingUsers.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs font-bold mb-2">Ainda pendente ({pendingUsers.length})</p>
                <div className="space-y-2 max-h-[30vh] overflow-y-auto pr-1">
                  {pendingUsers.map((u) => (
                    <div key={u.id} className="flex items-center justify-between gap-2">
                      <span className="text-xs">{u.name} <span className="text-muted-foreground">({ROLE_LABELS[u.role] ?? u.role})</span></span>
                      <button onClick={() => handleForceUnlock(viewing, u)} disabled={unlockingId === u.id}
                        data-testid={`button-force-unlock-${u.id}`}
                        className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 hover:underline disabled:opacity-50 shrink-0">
                        <Unlock className="w-3 h-3" /> {unlockingId === u.id ? "Destravando..." : "Destravar sistema"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
