import { useState, useEffect } from "react";
import {
  api, canEditModule,
  type RoutineChecklist, type RoutineChecklistFull, type RoutineChecklistQuestion, type RoutineChecklistScope,
  type RoutineQuestionType, type RoutineRecurrence, type RoutineScopeOptions, type RoutineResponse,
  type RoutineAlertLevel, type RoutineAnswerValue, ROUTINE_NO_REASONS,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ListChecks, Plus, X, Trash2, Pencil, CalendarClock, Users2, Bell, Eye } from "lucide-react";

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const RECURRENCE_LABELS: Record<RoutineRecurrence, string> = {
  daily: "Diário", weekdays: "Segunda a sexta", specific_days: "Dias específicos",
  weekly: "Semanal", monthly: "Mensal", specific_date: "Data específica",
  continuous: "Contínuo (o expediente inteiro, sem horário fixo)",
};
const QUESTION_TYPE_LABELS: Record<RoutineQuestionType, string> = {
  yes_no: "Sim/Não", done_not_done: "Executado/Não executado", text: "Texto", number: "Número",
  value: "Valor (R$)", photo: "Foto", document: "Documento", observation: "Observação",
};
const TOLERANCE_OPTIONS = [
  { value: 0, label: "Responder imediatamente" },
  { value: 5, label: "Até 5 minutos" },
  { value: 15, label: "Até 15 minutos" },
  { value: 30, label: "Até 30 minutos" },
];
const ALERT_LEVEL_LABELS: Record<RoutineAlertLevel, string> = { critico: "🔴 Crítico", atencao: "🟠 Atenção" };
// Só pergunta Sim/Não e Executado/Não executado tem "resposta negativa" pra
// disparar a justificativa estruturada (Fase 3.5).
const NEGATIVE_CAPABLE_TYPES: RoutineQuestionType[] = ["yes_no", "done_not_done"];

type FormQuestion = {
  label: string; type: RoutineQuestionType; required: boolean; requiresEvidence: boolean; evidenceType: "photo" | "document";
  requiresJustificationOnNo: boolean; alertLevel: RoutineAlertLevel | null;
};
type FormScope = { storeId: number | null; sectorId: number | null; jobFunction: string; userId: number | null };

const EMPTY_QUESTION: FormQuestion = {
  label: "", type: "yes_no", required: true, requiresEvidence: false, evidenceType: "photo",
  requiresJustificationOnNo: false, alertLevel: null,
};
const EMPTY_SCOPE: FormScope = { storeId: null, sectorId: null, jobFunction: "", userId: null };
const EMPTY_FORM = {
  name: "", message: "", scheduledTime: "08:00",
  recurrence: "daily" as RoutineRecurrence, recurrenceDays: [] as number[], specificDate: "",
  toleranceMinutes: 0, mandatory: true, active: true,
  questions: [{ ...EMPTY_QUESTION }] as FormQuestion[],
  scopes: [{ ...EMPTY_SCOPE }] as FormScope[],
};

// Aba "Rotinas e Produtividade" (Gestão, admin): Fase 1 — só o CRUD do
// checklist (nome, mensagem, horário/recorrência/tolerância, perguntas,
// escopo). Sem trava, sem agendamento disparando ainda (fases seguintes).
export default function RotinasProdutividade() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = canEditModule(user, "rotinas");
  const [lists, setLists] = useState<RoutineChecklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeOptions, setScopeOptions] = useState<RoutineScopeOptions | null>(null);
  const [jobFunctions, setJobFunctions] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RoutineChecklistFull | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<RoutineChecklist | null>(null);
  const [responses, setResponses] = useState<RoutineResponse[]>([]);

  const fetchLists = () => api.rotinas.list().then(setLists).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => {
    fetchLists();
    api.rotinas.scopeOptions().then(setScopeOptions).catch(() => {});
    api.rotinas.jobFunctions().then(setJobFunctions).catch(() => {});
  }, []);

  const openForm = async (c?: RoutineChecklist) => {
    if (!c) {
      setEditing(null);
      setForm({ ...EMPTY_FORM, questions: [{ ...EMPTY_QUESTION }], scopes: [{ ...EMPTY_SCOPE }] });
      setShowForm(true);
      return;
    }
    try {
      const full = await api.rotinas.get(c.id);
      setEditing(full);
      setForm({
        name: full.name, message: full.message ?? "", scheduledTime: full.scheduledTime ?? "08:00",
        recurrence: full.recurrence, recurrenceDays: full.recurrenceDays ?? [], specificDate: full.specificDate ?? "",
        toleranceMinutes: full.toleranceMinutes, mandatory: full.mandatory, active: full.active,
        questions: full.questions.length
          ? full.questions.map((q: RoutineChecklistQuestion) => ({
              label: q.label, type: q.type, required: q.required,
              requiresEvidence: q.requiresEvidence, evidenceType: q.evidenceType ?? "photo",
              requiresJustificationOnNo: q.requiresJustificationOnNo, alertLevel: q.alertLevel,
            }))
          : [{ ...EMPTY_QUESTION }],
        scopes: full.scopes.length
          ? full.scopes.map((s: RoutineChecklistScope) => ({
              storeId: s.storeId, sectorId: s.sectorId, jobFunction: s.jobFunction ?? "", userId: s.userId,
            }))
          : [{ ...EMPTY_SCOPE }],
      });
      setShowForm(true);
    } catch {
      toast({ title: "Erro ao carregar checklist", variant: "destructive" });
    }
  };

  const valid = form.name.trim()
    && (form.recurrence === "continuous" || /^\d{2}:\d{2}$/.test(form.scheduledTime))
    && (form.recurrence !== "specific_date" || form.specificDate)
    && form.questions.length > 0
    && form.questions.every((q) => q.label.trim());

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    const payload: Partial<RoutineChecklistFull> = {
      name: form.name, message: form.message || null,
      scheduledTime: form.recurrence === "continuous" ? null : form.scheduledTime,
      recurrence: form.recurrence,
      recurrenceDays: ["specific_days", "weekly", "monthly"].includes(form.recurrence) ? form.recurrenceDays : null,
      specificDate: form.recurrence === "specific_date" ? form.specificDate : null,
      toleranceMinutes: form.toleranceMinutes, mandatory: form.mandatory, active: form.active,
      questions: form.questions.map((q) => ({
        label: q.label, type: q.type, required: q.required,
        requiresEvidence: q.requiresEvidence, evidenceType: q.requiresEvidence ? q.evidenceType : null,
        requiresJustificationOnNo: NEGATIVE_CAPABLE_TYPES.includes(q.type) && q.requiresJustificationOnNo,
        alertLevel: q.alertLevel,
      })) as unknown as RoutineChecklistQuestion[],
      scopes: form.scopes
        .filter((s) => s.storeId != null || s.sectorId != null || s.jobFunction.trim() || s.userId != null)
        .map((s) => ({ storeId: s.storeId, sectorId: s.sectorId, jobFunction: s.jobFunction.trim() || null, userId: s.userId })) as unknown as RoutineChecklistScope[],
    };
    try {
      if (editing) await api.rotinas.update(editing.id, payload);
      else await api.rotinas.create(payload);
      setShowForm(false);
      fetchLists();
      toast({ title: editing ? "Checklist atualizado" : "Checklist criado" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const openResponses = async (c: RoutineChecklist) => {
    setViewing(c);
    setResponses([]);
    try { setResponses(await api.rotinas.responses(c.id)); } catch { /* noop */ }
  };

  const handleDelete = async (c: RoutineChecklist) => {
    if (!window.confirm(`Excluir "${c.name}"?`)) return;
    try {
      await api.rotinas.remove(c.id);
      setLists((prev) => prev.filter((x) => x.id !== c.id));
      toast({ title: "Checklist excluído" });
    } catch {
      toast({ title: "Erro ao excluir", variant: "destructive" });
    }
  };

  const setQ = (i: number, patch: Partial<FormQuestion>) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));
  const setS = (i: number, patch: Partial<FormScope>) =>
    setForm((f) => ({ ...f, scopes: f.scopes.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const recurrenceNeedsDays = form.recurrence === "specific_days" || form.recurrence === "weekly";
  const recurrenceNeedsMonthDay = form.recurrence === "monthly";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-primary" /> Rotinas e Produtividade
        </h2>
        {canEdit && (
          <button onClick={() => openForm()} data-testid="button-add-routine"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Novo checklist
          </button>
        )}
      </div>
      {!canEdit && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Você só tem acesso de visualização a Rotinas e Produtividade — peça ao administrador para liberar edição.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground bg-secondary/40 rounded-lg px-3 py-1.5">
        Fase 1: cadastro dos checklists. Ainda não trava o sistema nem dispara alertas — isso vem nas próximas etapas.
      </p>

      {loading ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : lists.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <ListChecks className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhum checklist criado</p>
          <p className="text-xs mt-1">Crie o checklist de abertura, fechamento, conferência de caixa etc.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {lists.map((c) => (
            <div key={c.id} className="shk-card p-4 flex items-start gap-3" data-testid={`routine-${c.id}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-sm">{c.name}</p>
                  {!c.active && <span className="text-[10px] font-bold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inativo</span>}
                  {c.mandatory && <span className="text-[10px] font-bold bg-red-50 text-red-600 border border-red-100 px-2 py-0.5 rounded-full">Obrigatório</span>}
                  <span className="text-[10px] text-muted-foreground">v{c.version}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <CalendarClock className="w-3 h-3" /> {c.scheduledTime ? `${c.scheduledTime} · ` : ""}{RECURRENCE_LABELS[c.recurrence]}
                  </span>
                  <span className="flex items-center gap-1"><Bell className="w-3 h-3" />{TOLERANCE_OPTIONS.find((t) => t.value === c.toleranceMinutes)?.label}</span>
                  <span className="flex items-center gap-1"><Users2 className="w-3 h-3" />{c.scopeCount ?? 0} regra(s) de escopo</span>
                  <span>{c.questionCount ?? 0} pergunta(s)</span>
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => openResponses(c)} title="Ver respostas" data-testid={`button-responses-routine-${c.id}`}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><Eye className="w-3.5 h-3.5" /></button>
                <button onClick={() => openForm(c)} title={canEdit ? "Editar" : "Ver"} data-testid={`button-edit-routine-${c.id}`}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><Pencil className="w-3.5 h-3.5" /></button>
                {canEdit && (
                  <button onClick={() => handleDelete(c)} title="Excluir" data-testid={`button-delete-routine-${c.id}`}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition"><Trash2 className="w-3.5 h-3.5" /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal criar/editar */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-2xl p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editing ? "Editar checklist" : "Novo checklist"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>

            <fieldset disabled={!canEdit} className="space-y-4 max-h-[65vh] overflow-y-auto pr-1 border-0 p-0 m-0">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ex.: Checklist de abertura" data-testid="input-routine-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Mensagem exibida ao usuário (opcional)</label>
                <textarea value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} rows={2}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {form.recurrence !== "continuous" && (
                  <div>
                    <label className="text-xs font-medium mb-1 block">Horário</label>
                    <input type="time" value={form.scheduledTime} onChange={(e) => setForm((f) => ({ ...f, scheduledTime: e.target.value }))}
                      data-testid="input-routine-time"
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium mb-1 block">Tolerância</label>
                  <select value={form.toleranceMinutes} onChange={(e) => setForm((f) => ({ ...f, toleranceMinutes: parseInt(e.target.value, 10) }))}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                    {TOLERANCE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Recorrência</label>
                  <select value={form.recurrence} onChange={(e) => setForm((f) => ({ ...f, recurrence: e.target.value as RoutineRecurrence, recurrenceDays: [] }))}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                    {(Object.entries(RECURRENCE_LABELS) as [RoutineRecurrence, string][]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                {form.recurrence === "specific_date" && (
                  <div>
                    <label className="text-xs font-medium mb-1 block">Data</label>
                    <input type="date" value={form.specificDate} onChange={(e) => setForm((f) => ({ ...f, specificDate: e.target.value }))}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                  </div>
                )}
              </div>

              {recurrenceNeedsDays && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Dias da semana</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {WEEKDAYS.map((d, i) => (
                      <button key={i} type="button"
                        onClick={() => setForm((f) => ({
                          ...f, recurrenceDays: f.recurrenceDays.includes(i) ? f.recurrenceDays.filter((x) => x !== i) : [...f.recurrenceDays, i],
                        }))}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                          form.recurrenceDays.includes(i) ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"
                        }`}>
                        {d.slice(0, 3)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {recurrenceNeedsMonthDay && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Dia do mês</label>
                  <select value={form.recurrenceDays[0] ?? 1} onChange={(e) => setForm((f) => ({ ...f, recurrenceDays: [parseInt(e.target.value, 10)] }))}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Dia {d}</option>)}
                  </select>
                </div>
              )}

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={form.mandatory} onChange={(e) => setForm((f) => ({ ...f, mandatory: e.target.checked }))} />
                  Obrigatório (vai travar o sistema — Fase 3)
                </label>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
                  Ativo
                </label>
              </div>

              {/* Escopo */}
              <div className="space-y-2">
                <p className="text-xs font-bold">Quem responde (escopo)</p>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Combine loja/setor/função/usuário por regra. Deixe tudo em branco numa regra pra aplicar a todo mundo. Várias regras = várias combinações.
                </p>
                {form.scopes.map((s, i) => (
                  <div key={i} className="border border-border rounded-xl p-3 grid grid-cols-2 gap-2">
                    <select value={s.storeId ?? ""} onChange={(e) => setS(i, { storeId: e.target.value ? parseInt(e.target.value, 10) : null })}
                      className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                      <option value="">Todas as lojas</option>
                      {scopeOptions?.stores.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                    <select value={s.sectorId ?? ""} onChange={(e) => setS(i, { sectorId: e.target.value ? parseInt(e.target.value, 10) : null })}
                      className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                      <option value="">Todos os setores</option>
                      {scopeOptions?.sectors.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                    <input value={s.jobFunction} onChange={(e) => setS(i, { jobFunction: e.target.value })} list="routine-job-functions"
                      placeholder="Função (opcional, ex.: Vendedor)"
                      className="px-2 py-1.5 rounded-lg border border-border text-xs" />
                    <div className="flex gap-1">
                      <select value={s.userId ?? ""} onChange={(e) => setS(i, { userId: e.target.value ? parseInt(e.target.value, 10) : null })}
                        className="flex-1 px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                        <option value="">Todos os usuários</option>
                        {scopeOptions?.users.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                      <button type="button" onClick={() => setForm((f) => ({ ...f, scopes: f.scopes.filter((_, j) => j !== i) }))}
                        disabled={form.scopes.length === 1}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30 shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                <datalist id="routine-job-functions">
                  {jobFunctions.map((f) => <option key={f} value={f} />)}
                </datalist>
                <button type="button" onClick={() => setForm((f) => ({ ...f, scopes: [...f.scopes, { ...EMPTY_SCOPE }] }))}
                  className="flex items-center gap-1 text-xs font-semibold text-primary">
                  <Plus className="w-3.5 h-3.5" /> Adicionar regra de escopo
                </button>
              </div>

              {/* Perguntas */}
              <div className="space-y-2">
                <p className="text-xs font-bold">Perguntas</p>
                {form.questions.map((q, i) => (
                  <div key={i} className="border border-border rounded-xl p-3 space-y-2">
                    <div className="flex gap-2">
                      <input value={q.label} onChange={(e) => setQ(i, { label: e.target.value })}
                        placeholder={`Pergunta ${i + 1}`} data-testid={`input-routine-question-${i}`}
                        className="flex-1 px-3 py-2 rounded-xl border border-border text-sm" />
                      <select value={q.type} onChange={(e) => setQ(i, { type: e.target.value as RoutineQuestionType })}
                        className="px-2 py-2 rounded-xl border border-border text-xs bg-white">
                        {(Object.entries(QUESTION_TYPE_LABELS) as [RoutineQuestionType, string][]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <button type="button" onClick={() => setForm((f) => ({ ...f, questions: f.questions.filter((_, j) => j !== i) }))}
                        disabled={form.questions.length === 1}
                        className="p-2 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-1.5 text-[11px] font-medium">
                        <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> Obrigatória
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] font-medium">
                        <input type="checkbox" checked={q.requiresEvidence} onChange={(e) => setQ(i, { requiresEvidence: e.target.checked })} /> Exige evidência
                      </label>
                      {q.requiresEvidence && (
                        <select value={q.evidenceType} onChange={(e) => setQ(i, { evidenceType: e.target.value as "photo" | "document" })}
                          className="px-2 py-1 rounded-lg border border-border text-[11px] bg-white">
                          <option value="photo">Foto</option>
                          <option value="document">Documento</option>
                        </select>
                      )}
                    </div>
                    <div className="flex items-center gap-4 flex-wrap">
                      {NEGATIVE_CAPABLE_TYPES.includes(q.type) && (
                        <label className="flex items-center gap-1.5 text-[11px] font-medium">
                          <input type="checkbox" checked={q.requiresJustificationOnNo}
                            onChange={(e) => setQ(i, { requiresJustificationOnNo: e.target.checked })} />
                          Exige motivo se a resposta for negativa
                        </label>
                      )}
                      <label className="flex items-center gap-1.5 text-[11px] font-medium">
                        Nível de alerta:
                        <select value={q.alertLevel ?? ""} onChange={(e) => setQ(i, { alertLevel: e.target.value ? e.target.value as RoutineAlertLevel : null })}
                          className="px-2 py-1 rounded-lg border border-border text-[11px] bg-white">
                          <option value="">Nenhum</option>
                          {(Object.entries(ALERT_LEVEL_LABELS) as [RoutineAlertLevel, string][]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={() => setForm((f) => ({ ...f, questions: [...f.questions, { ...EMPTY_QUESTION }] }))}
                  disabled={form.questions.length >= 50}
                  className="flex items-center gap-1 text-xs font-semibold text-primary disabled:opacity-40">
                  <Plus className="w-3.5 h-3.5" /> Adicionar pergunta
                </button>
              </div>
            </fieldset>

            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                {canEdit ? "Cancelar" : "Fechar"}
              </button>
              {canEdit && (
                <button onClick={handleSave} disabled={!valid || saving} data-testid="button-save-routine"
                  className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                  {saving ? "Salvando..." : "Salvar"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal respostas — funcionário vê só a própria, supervisor o setor
          dele, admin tudo (filtro já aplicado pelo backend). */}
      {viewing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-2xl p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">Respostas — {viewing.name}</h3>
              <button onClick={() => setViewing(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
              {responses.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Nenhuma resposta ainda.</p>
              ) : responses.map((r) => (
                <div key={r.id} className="border border-border rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold">{r.userName ?? "—"}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {r.periodKey} · {new Date(r.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    {r.questionsSnapshot.map((q) => {
                      const a: RoutineAnswerValue | undefined = r.answers[q.id];
                      const isJustified = a && typeof a === "object";
                      return (
                        <div key={q.id} className="text-xs">
                          <span className="text-muted-foreground">{q.label}: </span>
                          <span className="font-semibold">{isJustified ? a.value : (a ?? "—")}</span>
                          {isJustified && (
                            <div className="mt-0.5 ml-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 inline-block">
                              Motivo: {ROUTINE_NO_REASONS.find((r2) => r2.value === a.motivo)?.label ?? a.motivo}
                              {a.pendencia && <> · Pendência: {a.pendencia}</>}
                              {a.comunicarA && <> · Comunicar: {a.comunicarA}</>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
