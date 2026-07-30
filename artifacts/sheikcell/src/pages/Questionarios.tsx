import { useState, useEffect } from "react";
import { api, type Checklist, type ChecklistQuestion, type ChecklistResponse } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  ClipboardCheck, Plus, X, Trash2, Pencil, Eye, Star, CalendarDays, Users,
} from "lucide-react";

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const ROLE_LABELS: Record<string, string> = { admin: "Admin", supervisor: "Supervisor", vendedor: "Vendedor" };
const REC_LABELS: Record<string, string> = { daily: "Diário", weekly: "Semanal", once: "Uma vez" };

type FormQuestion = { label: string; type: ChecklistQuestion["type"]; optionsText: string };

const EMPTY_FORM = {
  title: "", description: "", recurrence: "weekly" as Checklist["recurrence"],
  dayOfWeek: 1, startDate: "", mandatory: true, active: true,
  targetRoles: ["vendedor"] as string[],
  questions: [{ label: "", type: "text", optionsText: "" }] as FormQuestion[],
};

// Aba "Questionários" (admin): cria e edita questionários/checklists com
// recorrência, funções-alvo e obrigatoriedade; vê as respostas da equipe.
export default function Questionarios() {
  const { toast } = useToast();
  const [lists, setLists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Checklist | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<Checklist | null>(null);
  const [responses, setResponses] = useState<ChecklistResponse[]>([]);

  const fetchLists = () => api.checklists.list().then(setLists).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { fetchLists(); }, []);

  const openForm = (c?: Checklist) => {
    setEditing(c ?? null);
    setForm(c ? {
      title: c.title, description: c.description ?? "", recurrence: c.recurrence,
      dayOfWeek: c.dayOfWeek ?? 1, startDate: c.startDate ?? "", mandatory: c.mandatory, active: c.active,
      targetRoles: c.targetRoles,
      questions: c.questions.map((q) => ({ label: q.label, type: q.type, optionsText: (q.options ?? []).join(", ") })),
    } : { ...EMPTY_FORM, questions: [{ label: "", type: "text", optionsText: "" }] });
    setShowForm(true);
  };

  const valid = form.title.trim()
    && form.targetRoles.length > 0
    && form.questions.length > 0
    && form.questions.every((q) => q.label.trim() && (q.type !== "options" || q.optionsText.split(",").filter((o) => o.trim()).length >= 2));

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    const payload = {
      title: form.title, description: form.description, recurrence: form.recurrence,
      dayOfWeek: form.dayOfWeek, startDate: form.startDate || null, mandatory: form.mandatory, active: form.active,
      targetRoles: form.targetRoles,
      questions: form.questions.map((q) => ({
        id: "", label: q.label, type: q.type,
        ...(q.type === "options" ? { options: q.optionsText.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
      })),
    } as Partial<Checklist>;
    try {
      if (editing) await api.checklists.update(editing.id, payload);
      else await api.checklists.create(payload);
      setShowForm(false);
      fetchLists();
      toast({ title: editing ? "Questionário atualizado" : "Questionário criado" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: Checklist) => {
    if (!window.confirm(`Excluir "${c.title}" e todas as respostas?`)) return;
    try {
      await api.checklists.remove(c.id);
      setLists((prev) => prev.filter((x) => x.id !== c.id));
      toast({ title: "Questionário excluído" });
    } catch {
      toast({ title: "Erro ao excluir", variant: "destructive" });
    }
  };

  const openResponses = async (c: Checklist) => {
    setViewing(c);
    setResponses([]);
    try { setResponses(await api.checklists.responses(c.id)); } catch { /* noop */ }
  };

  const setQ = (i: number, patch: Partial<FormQuestion>) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <ClipboardCheck className="w-5 h-5 text-primary" /> Questionários da Equipe
        </h2>
        <button onClick={() => openForm()} data-testid="button-add-checklist"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
          <Plus className="w-3.5 h-3.5" /> Novo questionário
        </button>
      </div>

      {loading ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : lists.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <ClipboardCheck className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhum questionário criado</p>
          <p className="text-xs mt-1">Crie checklists diários ou avaliações semanais para a equipe.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {lists.map((c) => (
            <div key={c.id} className="shk-card p-4 flex items-start gap-3" data-testid={`checklist-${c.id}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-sm">{c.title}</p>
                  {!c.active && <span className="text-[10px] font-bold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inativo</span>}
                  {c.mandatory && <span className="text-[10px] font-bold bg-red-50 text-red-600 border border-red-100 px-2 py-0.5 rounded-full">Obrigatório</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />
                    {REC_LABELS[c.recurrence]}{c.recurrence === "weekly" ? ` (${WEEKDAYS[c.dayOfWeek ?? 1]})` : ""}
                    {c.startDate ? ` · a partir de ${c.startDate.split("-").reverse().join("/")}` : ""}
                  </span>
                  <span className="flex items-center gap-1"><Users className="w-3 h-3" />{c.targetRoles.map((r) => ROLE_LABELS[r] ?? r).join(", ")}</span>
                  <span>{c.questions.length} pergunta(s)</span>
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => openResponses(c)} title="Ver respostas" data-testid={`button-responses-${c.id}`}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><Eye className="w-3.5 h-3.5" /></button>
                <button onClick={() => openForm(c)} title="Editar"
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition"><Pencil className="w-3.5 h-3.5" /></button>
                <button onClick={() => handleDelete(c)} title="Excluir"
                  className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition"><Trash2 className="w-3.5 h-3.5" /></button>
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
              <h3 className="font-bold">{editing ? "Editar questionário" : "Novo questionário"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <div>
                <label className="text-xs font-medium mb-1 block">Título</label>
                <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Ex.: Avaliação semanal da loja" data-testid="input-checklist-title"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Descrição (opcional)</label>
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Recorrência</label>
                  <select value={form.recurrence} onChange={(e) => setForm((f) => ({ ...f, recurrence: e.target.value as Checklist["recurrence"] }))}
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

              <div>
                <label className="text-xs font-medium mb-1 block">Quem responde</label>
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

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={form.mandatory} onChange={(e) => setForm((f) => ({ ...f, mandatory: e.target.checked }))} />
                  Obrigatório (trava o sistema até responder)
                </label>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
                  Ativo
                </label>
              </div>

              {/* Perguntas */}
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
            </div>

            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">Cancelar</button>
              <button onClick={handleSave} disabled={!valid || saving} data-testid="button-save-checklist"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal respostas */}
      {viewing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-2xl p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">Respostas — {viewing.title}</h3>
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
                    {viewing.questions.map((q) => (
                      <div key={q.id} className="text-xs">
                        <span className="text-muted-foreground">{q.label}: </span>
                        {q.type === "rating" ? (
                          <span className="inline-flex align-middle">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <Star key={n} className={`w-3.5 h-3.5 ${parseInt(r.answers[q.id] ?? "0", 10) >= n ? "fill-amber-400 text-amber-400" : "text-border"}`} />
                            ))}
                          </span>
                        ) : (
                          <span className="font-semibold">{r.answers[q.id] ?? "—"}</span>
                        )}
                      </div>
                    ))}
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
