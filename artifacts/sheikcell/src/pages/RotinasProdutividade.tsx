import { useState, useEffect } from "react";
import {
  api, canEditModule,
  type RoutineChecklist, type RoutineChecklistFull, type RoutineChecklistQuestion, type RoutineChecklistScope,
  type RoutineQuestionType, type RoutineRecurrence, type RoutineScopeOptions, type RoutineResponse, type RoutineClosure,
  type RoutineAlertLevel, type RoutineAnswerValue, ROUTINE_NO_REASONS,
  type RoutineScoreWeights, type RoutineRankingRow, type RoutineDashboardRow, type RoutineDashboardStatus, type RoutineAlert,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button, Modal, Select } from "@/components/kit";
import {
  ListChecks, Plus, Trash2, Pencil, CalendarClock, Users2, Bell, Eye, FolderOpen, ChevronRight, FileText, Image as ImageIcon,
  BarChart3, Clock, Building2, Trophy, CheckCircle2, ShieldQuestion, LayoutDashboard, AlertTriangle, RefreshCw,
} from "lucide-react";

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
  const [mainTab, setMainTab] = useState<"painel" | "checklists" | "documentos" | "relatorio" | "loja" | "ranking" | "aprovacoes">("painel");

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
        {canEdit && mainTab === "checklists" && (
          <button onClick={() => openForm()} data-testid="button-add-routine"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Novo checklist
          </button>
        )}
      </div>

      <div className="flex gap-1.5 border-b border-border">
        {([
          ["painel", "Painel", LayoutDashboard],
          ["checklists", "Checklists", ListChecks], ["documentos", "Documentos", FolderOpen], ["relatorio", "Relatório Mensal", BarChart3],
          ["loja", "Relatório por Loja", Building2], ["ranking", "Ranking", Trophy], ["aprovacoes", "Aprovações", ShieldQuestion],
        ] as const).map(([v, label, Icon]) => (
          <button key={v} onClick={() => setMainTab(v)} data-testid={`tab-rotinas-${v}`}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition ${
              mainTab === v ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}>
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {mainTab === "painel" ? (
        <RotinasPainel scopeOptions={scopeOptions} jobFunctions={jobFunctions} canEdit={canEdit} />
      ) : mainTab === "documentos" ? (
        <RotinasDocumentos checklists={lists} />
      ) : mainTab === "relatorio" ? (
        <RotinasRelatorio employees={scopeOptions?.employees ?? []} canEdit={canEdit} />
      ) : mainTab === "loja" ? (
        <RotinasRelatorioLoja />
      ) : mainTab === "ranking" ? (
        <RotinasRanking scopeOptions={scopeOptions} canEdit={canEdit} />
      ) : mainTab === "aprovacoes" ? (
        <RotinasAprovacoes />
      ) : (
      <>
      {!canEdit && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Você só tem acesso de visualização a Rotinas e Produtividade — peça ao administrador para liberar edição.
        </p>
      )}

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
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? "Editar checklist" : "Novo checklist"} width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)} className="flex-1">{canEdit ? "Cancelar" : "Fechar"}</Button>
            {canEdit && (
              <Button onClick={handleSave} disabled={!valid || saving} data-testid="button-save-routine" className="flex-1">
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            )}
          </>
        }>
            <fieldset disabled={!canEdit} className="space-y-4 border-0 p-0 m-0">
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
      </Modal>

      {/* Modal respostas — funcionário vê só a própria, supervisor o setor
          dele, admin tudo (filtro já aplicado pelo backend). */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={`Respostas — ${viewing?.name ?? ""}`} width="lg">
            <div className="space-y-3">
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
                  {r.evidence.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-border">
                      {r.evidence.map((e) => (
                        <a key={e.id} href={api.rotinas.evidenceFileUrl(e.id)} target="_blank" rel="noreferrer"
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-secondary/60 hover:bg-secondary text-foreground transition">
                          {e.mimeType.startsWith("image/") ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                          {e.fileName}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
      </Modal>
      </>
      )}
    </div>
  );
}

// ── Documentos (Fase 4): Checklists → Loja → Setor → Funcionário → Ano →
// Mês, drill-down sobre a evidência já trazida por api.rotinas.responses()
// (mesmo controle de acesso 3 camadas do backend — nada novo aqui). ──
type EvidenceEntry = {
  evidenceId: number; fileName: string; mimeType: string;
  checklistName: string; storeName: string; sectorName: string; userName: string;
  year: string; month: string; questionLabel: string; createdAt: string;
};
function RotinasDocumentos({ checklists }: { checklists: RoutineChecklist[] }) {
  const [entries, setEntries] = useState<EvidenceEntry[] | null>(null);
  const [path, setPath] = useState<string[]>([]); // [checklist, loja, setor, funcionário, ano, mês]

  useEffect(() => {
    setEntries(null);
    Promise.all(checklists.map((c) => api.rotinas.responses(c.id).then((rs) => ({ c, rs })).catch(() => ({ c, rs: [] as RoutineResponse[] }))))
      .then((all) => {
        const out: EvidenceEntry[] = [];
        for (const { c, rs } of all) {
          for (const r of rs) {
            const [year, month] = r.periodKey.split("-");
            const labelByQ = new Map(r.questionsSnapshot.map((q) => [q.id, q.label]));
            for (const e of r.evidence) {
              out.push({
                evidenceId: e.id, fileName: e.fileName, mimeType: e.mimeType,
                checklistName: c.name, storeName: r.storeName ?? "Sem loja", sectorName: r.sectorName ?? "Sem setor",
                userName: r.userName ?? "—", year: year ?? "—", month: month ?? "—",
                questionLabel: labelByQ.get(e.questionId) ?? "—", createdAt: e.createdAt,
              });
            }
          }
        }
        setEntries(out);
      });
  }, [checklists]);

  const LEVELS: ("checklistName" | "storeName" | "sectorName" | "userName" | "year" | "month")[] =
    ["checklistName", "storeName", "sectorName", "userName", "year", "month"];
  const MONTH_NAMES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const filtered = (entries ?? []).filter((e) => path.every((v, i) => e[LEVELS[i]] === v));
  const depth = path.length;

  if (entries === null) return <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />;

  if (entries.length === 0) {
    return (
      <div className="shk-card p-8 text-center text-muted-foreground">
        <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm font-semibold">Nenhuma evidência anexada ainda</p>
        <p className="text-xs mt-1">Fotos e documentos anexados nas respostas dos checklists aparecem aqui, navegáveis por loja/setor/funcionário/ano/mês.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-xs flex-wrap">
        <button onClick={() => setPath([])} className={`font-semibold ${depth === 0 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
          Checklists
        </button>
        {path.map((v, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
            <button onClick={() => setPath(path.slice(0, i + 1))}
              className={`font-semibold ${i === depth - 1 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
              {LEVELS[i] === "month" ? MONTH_NAMES[parseInt(v, 10)] ?? v : v}
            </button>
          </span>
        ))}
      </div>

      {depth < LEVELS.length ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {Array.from(new Set(filtered.map((e) => e[LEVELS[depth]]))).sort().map((v) => (
            <button key={v} onClick={() => setPath([...path, v])} data-testid={`doc-drill-${v}`}
              className="shk-card p-3 flex items-center gap-2 text-left hover:bg-secondary/40 transition">
              <FolderOpen className="w-4 h-4 text-primary shrink-0" />
              <span className="text-xs font-semibold truncate">{LEVELS[depth] === "month" ? MONTH_NAMES[parseInt(v, 10)] ?? v : v}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((e) => (
            <a key={e.evidenceId} href={api.rotinas.evidenceFileUrl(e.evidenceId)} target="_blank" rel="noreferrer"
              className="shk-card p-3 flex items-center gap-2 hover:bg-secondary/40 transition">
              {e.mimeType.startsWith("image/") ? <ImageIcon className="w-4 h-4 text-primary shrink-0" /> : <FileText className="w-4 h-4 text-primary shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{e.fileName}</p>
                <p className="text-[10px] text-muted-foreground truncate">{e.questionLabel} · {new Date(e.createdAt).toLocaleDateString("pt-BR")}</p>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Relatório Mensal (Fase 5): fechamento congelado por funcionário/mês —
// leitura sobre routine_closures, mais o botão "Fechar mês" (admin) pra
// gerar manualmente sem esperar o job automático. Só leitura, sem ranking
// (isso é Fase 6) e sem nenhuma trava/penalidade — cruzamento com Ponto é
// dado cru mesmo (pontoBeforeEntry/pontoAfterEntry/pontoNoRecord).
function RotinasRelatorio({ employees, canEdit }: { employees: { id: number; name: string }[]; canEdit: boolean }) {
  const { toast } = useToast();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [closures, setClosures] = useState<RoutineClosure[]>([]);
  const [loading, setLoading] = useState(false);
  const [runMonth, setRunMonth] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (employeeId == null) { setClosures([]); return; }
    setLoading(true);
    api.rotinas.closures({ employeeId }).then(setClosures).catch(() => {}).finally(() => setLoading(false));
  }, [employeeId]);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    try {
      const r = await api.rotinas.runClosure(runMonth || undefined);
      toast({ title: `Fechamento de ${r.month} gerado`, description: `${r.created} funcionário(s) fechado(s) agora (os já fechados foram ignorados).` });
      if (employeeId != null) api.rotinas.closures({ employeeId }).then(setClosures).catch(() => {});
    } catch (err) {
      toast({ title: "Erro ao fechar mês", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const pct = (n: number, total: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);
  const monthLabel = (m: string) => {
    const [y, mo] = m.split("-");
    const names = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    return `${names[parseInt(mo ?? "0", 10)] ?? mo}/${y}`;
  };

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="shk-card p-3 flex items-center gap-2 flex-wrap">
          <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
          <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">
            Fecha automaticamente todo início de mês (mês anterior). Pra fechar um mês específico agora (ex.: testar):
          </p>
          <input type="month" value={runMonth} onChange={(e) => setRunMonth(e.target.value)}
            data-testid="input-closure-month"
            className="px-2 py-1.5 rounded-lg border border-border text-xs" />
          <button onClick={handleRun} disabled={running} data-testid="button-run-closure"
            className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold disabled:opacity-40">
            {running ? "Fechando..." : "Fechar mês"}
          </button>
        </div>
      )}

      <div>
        <label className="text-xs font-medium mb-1 block">Funcionário</label>
        <select value={employeeId ?? ""} onChange={(e) => setEmployeeId(e.target.value ? parseInt(e.target.value, 10) : null)}
          data-testid="select-closure-employee"
          className="w-full sm:w-72 px-3 py-2 rounded-xl border border-border text-sm bg-white">
          <option value="">Selecione um funcionário...</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      {employeeId == null ? (
        <p className="text-xs text-muted-foreground">Escolha um funcionário pra ver o histórico mensal.</p>
      ) : loading ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : closures.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum mês fechado ainda pra esse funcionário.</p>
      ) : (
        <div className="space-y-2">
          {closures.map((c) => (
            <div key={c.id} className="shk-card p-4" data-testid={`closure-${c.id}`}>
              <p className="text-sm font-bold mb-2">{monthLabel(c.periodMonth)}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Respondidos no prazo</p>
                  <p className="font-bold text-sm">{pct(c.totalOnTime, c.totalDue)} <span className="font-normal text-muted-foreground">({c.totalOnTime}/{c.totalDue})</span></p>
                </div>
                <div>
                  <p className="text-muted-foreground">Respondidos (total)</p>
                  <p className="font-bold text-sm">{pct(c.totalAnswered, c.totalDue)} <span className="font-normal text-muted-foreground">({c.totalAnswered}/{c.totalDue})</span></p>
                </div>
                <div>
                  <p className="text-muted-foreground">Pendências</p>
                  <p className="font-bold text-sm">{c.totalWithPendency}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Atendimentos urgentes</p>
                  <p className="font-bold text-sm">{c.totalUrgentBypass}</p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-[11px] text-muted-foreground mb-1">Cruzamento com o Ponto (checklists de horário fixo)</p>
                <div className="flex gap-3 text-xs flex-wrap">
                  <span>Antes da entrada: <span className="font-semibold">{c.pontoBeforeEntry}</span></span>
                  <span>Depois da entrada: <span className="font-semibold">{c.pontoAfterEntry}</span></span>
                  <span>Sem registro de Ponto no dia: <span className="font-semibold">{c.pontoNoRecord}</span></span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">Fechado em {new Date(c.closedAt).toLocaleString("pt-BR")}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Relatório por Loja (Fase 6): mesma hierarquia de navegação Loja → Setor
// → Funcionário de Documentos, agregando os fechamentos mensais já
// congelados (Fase 5) em vez de recalcular em cima das respostas brutas. ──
function monthLabel(m: string): string {
  const [y, mo] = m.split("-");
  const names = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${names[parseInt(mo ?? "0", 10)] ?? mo}/${y}`;
}
function defaultPeriodMonth(): string {
  const now = new Date();
  const sp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = Number(sp.find((p) => p.type === "year")!.value);
  const m = Number(sp.find((p) => p.type === "month")!.value);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

function RotinasRelatorioLoja() {
  const [periodMonth, setPeriodMonth] = useState(defaultPeriodMonth());
  const [closures, setClosures] = useState<RoutineClosure[] | null>(null);
  const [path, setPath] = useState<string[]>([]);

  useEffect(() => {
    setClosures(null);
    api.rotinas.closures({ periodMonth }).then(setClosures).catch(() => setClosures([]));
  }, [periodMonth]);

  const LEVELS: ("storeName" | "sectorName" | "employeeName")[] = ["storeName", "sectorName", "employeeName"];
  const rows = (closures ?? []).map((c) => ({ ...c, storeName: c.storeName ?? "Sem loja", sectorName: c.sectorName ?? "Sem setor" }));
  const filtered = rows.filter((r) => path.every((v, i) => r[LEVELS[i]] === v));
  const depth = path.length;

  const pct = (n: number, total: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);
  function aggregate(group: typeof rows) {
    const withDue = group.filter((r) => r.totalDue > 0);
    const avgOnTimePct = withDue.length ? Math.round(withDue.reduce((s, r) => s + (r.totalOnTime / r.totalDue) * 100, 0) / withDue.length) : null;
    const totalPendency = group.reduce((s, r) => s + r.totalWithPendency, 0);
    const totalUrgent = group.reduce((s, r) => s + r.totalUrgentBypass, 0);
    return { avgOnTimePct, totalPendency, totalUrgent, count: group.length };
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium mb-1 block">Mês</label>
        <input type="month" value={periodMonth} onChange={(e) => { setPeriodMonth(e.target.value); setPath([]); }}
          className="px-2 py-1.5 rounded-lg border border-border text-xs" />
      </div>

      <div className="flex items-center gap-1 text-xs flex-wrap">
        <button onClick={() => setPath([])} className={`font-semibold ${depth === 0 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
          Todas as lojas
        </button>
        {path.map((v, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
            <button onClick={() => setPath(path.slice(0, i + 1))}
              className={`font-semibold ${i === depth - 1 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
              {v}
            </button>
          </span>
        ))}
      </div>

      {closures === null ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum fechamento pra {monthLabel(periodMonth)} ainda.</p>
      ) : depth < LEVELS.length ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Array.from(new Set(filtered.map((r) => r[LEVELS[depth]]))).sort().map((v) => {
            const group = filtered.filter((r) => r[LEVELS[depth]] === v);
            const agg = aggregate(group);
            return (
              <button key={v} onClick={() => setPath([...path, v])} data-testid={`loja-drill-${v}`}
                className="shk-card p-3 text-left hover:bg-secondary/40 transition">
                <div className="flex items-center gap-2 mb-1.5">
                  {LEVELS[depth] === "employeeName" ? <Users2 className="w-4 h-4 text-primary shrink-0" /> : <Building2 className="w-4 h-4 text-primary shrink-0" />}
                  <span className="text-xs font-semibold truncate">{v}</span>
                </div>
                <div className="flex gap-3 text-[11px] text-muted-foreground flex-wrap">
                  <span>{agg.avgOnTimePct == null ? "—" : `${agg.avgOnTimePct}%`} no prazo (média)</span>
                  <span>{agg.totalPendency} pendência(s)</span>
                  <span>{agg.totalUrgent} urgência(s)</span>
                  {LEVELS[depth] !== "employeeName" && <span>{agg.count} func.</span>}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <div key={c.id} className="shk-card p-3 flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="text-xs font-bold">{c.employeeName}</p>
                <p className="text-[11px] text-muted-foreground">{c.storeName} · {c.sectorName}</p>
              </div>
              <div className="flex gap-3 text-xs">
                <span>{pct(c.totalOnTime, c.totalDue)} no prazo</span>
                <span>{c.totalWithPendency} pendência(s)</span>
                <span>{c.totalUrgentBypass} urgência(s)</span>
                {c.approvedAt ? <span className="text-green-600 font-semibold">Aprovado</span> : <span className="text-amber-600 font-semibold">Provisório</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Ranking (Fase 6): só role "vendedor" (gerente de loja/supervisor fica
// de fora). Score não premia só quantidade — combina % no prazo, ausência
// de pendência e não abuso de "Atendimento urgente", pesos configuráveis
// (ver computeRoutineScore no backend pra fórmula documentada). Fechamentos
// ainda não aprovados pelo supervisor aparecem marcados "provisório". ──
function RotinasRanking({ scopeOptions, canEdit }: { scopeOptions: RoutineScopeOptions | null; canEdit: boolean }) {
  const { toast } = useToast();
  const [periodMonth, setPeriodMonth] = useState(defaultPeriodMonth());
  const [storeId, setStoreId] = useState<number | null>(null);
  const [ranking, setRanking] = useState<{ weights: RoutineScoreWeights; ranking: RoutineRankingRow[] } | null>(null);
  const [weightsForm, setWeightsForm] = useState<RoutineScoreWeights | null>(null);
  const [savingWeights, setSavingWeights] = useState(false);

  const load = () => {
    setRanking(null);
    api.rotinas.ranking({ periodMonth, storeId: storeId ?? undefined }).then((r) => {
      setRanking(r);
      setWeightsForm((prev) => prev ?? r.weights);
    }).catch(() => setRanking({ weights: { weightOnTime: 50, weightNoPendency: 30, weightNoUrgentAbuse: 20 }, ranking: [] }));
  };
  useEffect(load, [periodMonth, storeId]);

  const handleSaveWeights = async () => {
    if (!weightsForm || savingWeights) return;
    setSavingWeights(true);
    try {
      const saved = await api.rotinas.updateScoreWeights(weightsForm);
      setWeightsForm(saved);
      toast({ title: "Pesos atualizados" });
      load();
    } catch (err) {
      toast({ title: "Erro ao salvar pesos", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingWeights(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-xs font-medium mb-1 block">Mês</label>
          <input type="month" value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}
            className="px-2 py-1.5 rounded-lg border border-border text-xs" />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block">Loja</label>
          <select value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value ? parseInt(e.target.value, 10) : null)}
            className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
            <option value="">Todas as lojas</option>
            {scopeOptions?.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {canEdit && weightsForm && (
        <div className="shk-card p-3">
          <p className="text-xs font-bold mb-2">Pesos do score (soma não precisa ser 100 — só a proporção entre eles importa)</p>
          <div className="flex gap-3 flex-wrap items-end">
            {([["weightOnTime", "No prazo"], ["weightNoPendency", "Sem pendência"], ["weightNoUrgentAbuse", "Sem abuso de urgência"]] as const).map(([k, label]) => (
              <div key={k}>
                <label className="text-[11px] text-muted-foreground mb-1 block">{label}</label>
                <input type="number" min={0} max={100} value={weightsForm[k]}
                  onChange={(e) => setWeightsForm((f) => f && ({ ...f, [k]: parseInt(e.target.value, 10) || 0 }))}
                  data-testid={`input-weight-${k}`}
                  className="w-20 px-2 py-1.5 rounded-lg border border-border text-xs" />
              </div>
            ))}
            <button onClick={handleSaveWeights} disabled={savingWeights} data-testid="button-save-weights"
              className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold disabled:opacity-40">
              {savingWeights ? "Salvando..." : "Salvar pesos"}
            </button>
          </div>
        </div>
      )}

      {ranking === null ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : ranking.ranking.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum funcionário (função vendedor) com checklist devido em {monthLabel(periodMonth)}.</p>
      ) : (
        <div className="space-y-1.5">
          {ranking.ranking.map((r, i) => (
            <div key={r.employeeId} className="shk-card p-3 flex items-center gap-3" data-testid={`ranking-${r.employeeId}`}>
              <span className="text-lg font-black text-muted-foreground w-6 text-center shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs font-bold">{r.employeeName}</p>
                  {!r.approved && <span className="text-[10px] font-bold bg-amber-50 text-amber-600 border border-amber-100 px-1.5 py-0.5 rounded-full">Provisório</span>}
                </div>
                <p className="text-[11px] text-muted-foreground">{r.storeName ?? "—"} · {r.sectorName ?? "—"}{r.jobFunction ? ` · ${r.jobFunction}` : ""}</p>
                <div className="flex gap-3 text-[11px] text-muted-foreground mt-1 flex-wrap">
                  <span>No prazo: {r.onTimeRate}%</span>
                  <span>Sem pendência: {r.noPendencyRate}%</span>
                  <span>Sem abuso de urgência: {r.noUrgentAbuseRate}%</span>
                </div>
              </div>
              <span className="text-xl font-black text-primary shrink-0">{r.score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Aprovações (Fase 6): revisão do supervisor/admin sobre pendência e
// "Atendimento urgente" antes do fechamento contar de verdade no ranking —
// mesmo espírito de POST /rh-dp/time-clock-entries/:id/review (rhDp.ts),
// reaproveitado em vez de um fluxo de aprovação novo do zero. ──
function RotinasAprovacoes() {
  const { toast } = useToast();
  const [periodMonth, setPeriodMonth] = useState(defaultPeriodMonth());
  const [pending, setPending] = useState<Awaited<ReturnType<typeof api.rotinas.reviewPending>> | null>(null);
  const [closures, setClosures] = useState<RoutineClosure[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = () => {
    setPending(null);
    api.rotinas.reviewPending(periodMonth).then(setPending).catch(() => {});
    api.rotinas.closures({ periodMonth }).then(setClosures).catch(() => {});
  };
  useEffect(load, [periodMonth]);

  const reviewResponse = async (id: number, status: "approved" | "contested") => {
    setBusy(id);
    try { await api.rotinas.reviewResponse(id, status); toast({ title: status === "approved" ? "Pendência confirmada como resolvida" : "Pendência contestada" }); load(); }
    catch (err) { toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" }); }
    finally { setBusy(null); }
  };
  const reviewBypass = async (id: number, status: "approved" | "contested") => {
    setBusy(id);
    try { await api.rotinas.reviewUrgentBypass(id, status); toast({ title: status === "approved" ? "Urgência confirmada" : "Urgência contestada" }); load(); }
    catch (err) { toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" }); }
    finally { setBusy(null); }
  };
  const approveClosure = async (id: number) => {
    setBusy(id);
    try { await api.rotinas.approveClosure(id); toast({ title: "Fechamento aprovado — entra no ranking" }); load(); }
    catch (err) { toast({ title: "Não foi possível aprovar", description: err instanceof Error ? err.message : "Ainda há itens pra revisar", variant: "destructive" }); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-medium mb-1 block">Mês</label>
        <input type="month" value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}
          className="px-2 py-1.5 rounded-lg border border-border text-xs" />
      </div>

      <div>
        <p className="text-xs font-bold mb-2">Pendências marcadas ({pending?.pendencies.length ?? 0})</p>
        {pending && pending.pendencies.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma pendência pra revisar.</p>}
        <div className="space-y-1.5">
          {pending?.pendencies.map((p) => (
            <div key={p.id} className="shk-card p-3 flex items-center justify-between gap-2 flex-wrap" data-testid={`review-pendency-${p.id}`}>
              <div>
                <p className="text-xs font-bold">{p.userName ?? "—"}</p>
                <p className="text-[11px] text-muted-foreground">{p.periodKey}</p>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => reviewResponse(p.id, "approved")} disabled={busy === p.id}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green-50 text-green-700 border border-green-200 text-[11px] font-semibold disabled:opacity-40">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Resolvida
                </button>
                <button onClick={() => reviewResponse(p.id, "contested")} disabled={busy === p.id}
                  className="px-2.5 py-1 rounded-lg bg-red-50 text-red-600 border border-red-200 text-[11px] font-semibold disabled:opacity-40">
                  Contestar
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-bold mb-2">Atendimentos urgentes usados ({pending?.urgentBypasses.length ?? 0})</p>
        {pending && pending.urgentBypasses.length === 0 && <p className="text-xs text-muted-foreground">Nenhum atendimento urgente pra revisar.</p>}
        <div className="space-y-1.5">
          {pending?.urgentBypasses.map((b) => (
            <div key={b.id} className="shk-card p-3 flex items-center justify-between gap-2 flex-wrap" data-testid={`review-bypass-${b.id}`}>
              <div>
                <p className="text-xs font-bold">{b.userName ?? "—"}</p>
                <p className="text-[11px] text-muted-foreground">{new Date(b.createdAt).toLocaleString("pt-BR")}</p>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => reviewBypass(b.id, "approved")} disabled={busy === b.id}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green-50 text-green-700 border border-green-200 text-[11px] font-semibold disabled:opacity-40">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Justificado
                </button>
                <button onClick={() => reviewBypass(b.id, "contested")} disabled={busy === b.id}
                  className="px-2.5 py-1 rounded-lg bg-red-50 text-red-600 border border-red-200 text-[11px] font-semibold disabled:opacity-40">
                  Mal registrado
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-bold mb-2">Aprovar fechamento do mês</p>
        <div className="space-y-1.5">
          {closures.map((c) => (
            <div key={c.id} className="shk-card p-3 flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs font-bold">{c.employeeName} <span className="font-normal text-muted-foreground">— {c.storeName ?? "—"}</span></p>
              {c.approvedAt ? (
                <span className="text-[11px] font-semibold text-green-600">Aprovado</span>
              ) : (
                <button onClick={() => approveClosure(c.id)} disabled={busy === c.id}
                  data-testid={`button-approve-closure-${c.id}`}
                  className="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-semibold disabled:opacity-40">
                  Aprovar mês
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Painel consolidado (Fase 7) — reúne o que já foi construído nas fases
// anteriores (checklists, respostas/pendências, documentos, relatório
// mensal, relatório por loja/ranking) sob um filtro comum de loja/setor/
// função/período/status. Não recalcula nada — só junta o que já existe
// (GET /rotinas/dashboard, ver rotinas.ts). Também mostra os alertas
// automáticos (Fase 7) pro gestor logado, com botão de teste (admin) pra
// não precisar esperar o job periódico de 15 min. ──
const STATUS_LABELS: Record<RoutineDashboardStatus, string> = {
  pendente: "Pendente", em_dia: "Em dia", pendencia_nao_justificada: "Pendência não justificada",
};
const STATUS_COLORS: Record<RoutineDashboardStatus, string> = {
  pendente: "bg-gray-100 text-gray-600 border-gray-200",
  em_dia: "bg-green-50 text-green-700 border-green-200",
  pendencia_nao_justificada: "bg-red-50 text-red-600 border-red-200",
};

function RotinasPainel({ scopeOptions, jobFunctions, canEdit }: { scopeOptions: RoutineScopeOptions | null; jobFunctions: string[]; canEdit: boolean }) {
  const { toast } = useToast();
  const [periodMonth, setPeriodMonth] = useState(defaultPeriodMonth());
  const [storeId, setStoreId] = useState<number | null>(null);
  const [sectorId, setSectorId] = useState<number | null>(null);
  const [jobFunction, setJobFunction] = useState("");
  const [status, setStatus] = useState<RoutineDashboardStatus | "">("");
  const [rows, setRows] = useState<RoutineDashboardRow[] | null>(null);
  const [alerts, setAlerts] = useState<RoutineAlert[] | null>(null);
  const [runningAlerts, setRunningAlerts] = useState(false);

  const loadRows = () => {
    setRows(null);
    api.rotinas.dashboard({
      periodMonth, storeId: storeId ?? undefined, sectorId: sectorId ?? undefined,
      jobFunction: jobFunction || undefined, status: status || undefined,
    }).then((r) => setRows(r.rows)).catch(() => setRows([]));
  };
  const loadAlerts = () => api.rotinas.alerts().then(setAlerts).catch(() => {});

  useEffect(loadRows, [periodMonth, storeId, sectorId, jobFunction, status]);
  useEffect(() => { loadAlerts(); }, []);

  const markRead = async (id: number) => {
    try { await api.rotinas.markAlertRead(id); loadAlerts(); } catch { /* noop */ }
  };
  const handleRunAlerts = async () => {
    if (runningAlerts) return;
    setRunningAlerts(true);
    try {
      const r = await api.rotinas.runAlerts();
      toast({ title: `${r.created} alerta(s) novo(s) gerado(s)` });
      loadAlerts();
    } catch (err) {
      toast({ title: "Erro ao rodar alertas", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setRunningAlerts(false);
    }
  };

  const unread = (alerts ?? []).filter((a) => !a.read);
  const pct = (n: number, total: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);

  return (
    <div className="space-y-4">
      {/* Alertas automáticos */}
      <div className="shk-card p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold flex items-center gap-1.5">
            <Bell className="w-3.5 h-3.5" /> Alertas ({unread.length} não lido{unread.length === 1 ? "" : "s"})
          </p>
          {canEdit && (
            <button onClick={handleRunAlerts} disabled={runningAlerts} data-testid="button-run-alerts"
              className="flex items-center gap-1 text-[11px] font-semibold text-primary disabled:opacity-40">
              <RefreshCw className={`w-3 h-3 ${runningAlerts ? "animate-spin" : ""}`} /> Checar agora
            </button>
          )}
        </div>
        {alerts === null ? (
          <div className="h-10 rounded-lg bg-secondary/40 animate-pulse" />
        ) : alerts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhum alerta ainda.</p>
        ) : (
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {alerts.map((a) => (
              <div key={a.id} className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs ${a.read ? "bg-secondary/30" : "bg-amber-50 border border-amber-200"}`}>
                <div className="flex items-center gap-1.5 min-w-0">
                  <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${a.kind === "critico" ? "text-red-500" : "text-amber-500"}`} />
                  <span className="truncate">{a.message}</span>
                </div>
                {!a.read && (
                  <button onClick={() => markRead(a.id)} className="text-[11px] font-semibold text-primary shrink-0">Marcar lida</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-xs font-medium mb-1 block">Mês</label>
          <input type="month" value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)}
            className="px-2 py-1.5 rounded-lg border border-border text-xs" />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block">Loja</label>
          <Select value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value ? parseInt(e.target.value, 10) : null)}>
            <option value="">Todas</option>
            {scopeOptions?.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block">Setor</label>
          <Select value={sectorId ?? ""} onChange={(e) => setSectorId(e.target.value ? parseInt(e.target.value, 10) : null)}>
            <option value="">Todos</option>
            {scopeOptions?.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block">Função</label>
          <Select value={jobFunction} onChange={(e) => setJobFunction(e.target.value)}>
            <option value="">Todas</option>
            {jobFunctions.map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block">Status</label>
          <Select value={status} onChange={(e) => setStatus(e.target.value as RoutineDashboardStatus | "")}>
            <option value="">Todos</option>
            {(Object.entries(STATUS_LABELS) as [RoutineDashboardStatus, string][]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
      </div>

      {/* Resultado */}
      {rows === null ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum funcionário bate com esses filtros em {monthLabel(periodMonth)}.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.employeeId} className="shk-card p-3 flex items-center gap-3 flex-wrap" data-testid={`painel-row-${r.employeeId}`}>
              <div className="flex-1 min-w-[160px]">
                <p className="text-xs font-bold">{r.employeeName}</p>
                <p className="text-[11px] text-muted-foreground">{r.storeName ?? "—"} · {r.sectorName ?? "—"}{r.jobFunction ? ` · ${r.jobFunction}` : ""}</p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS_COLORS[r.status]}`}>{STATUS_LABELS[r.status]}</span>
              <div className="flex gap-3 text-[11px] text-muted-foreground">
                <span>{pct(r.totalOnTime, r.totalDue)} no prazo</span>
                <span>{r.totalWithPendency} pendência(s)</span>
                <span>{r.totalUrgentBypass} urgência(s)</span>
                {r.score != null && <span className="font-bold text-primary">Score {r.score}</span>}
              </div>
              {!r.approved && <span className="text-[10px] font-bold bg-amber-50 text-amber-600 border border-amber-100 px-1.5 py-0.5 rounded-full shrink-0">Provisório</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
