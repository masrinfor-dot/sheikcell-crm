import { useState, useEffect, useCallback } from "react";
import { api, type Task, type TaskStatus, type TaskPriority, type Sector, type TaskComment, type TaskSubtask, type TaskReportBucket } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, X, RefreshCw, Trash2, ChevronRight, ChevronLeft,
  User, Calendar, Flag, ListTodo, Pencil, AlertCircle,
  MessageSquare, CheckSquare, Send, BarChart3,
} from "lucide-react";

const COLUMNS = [
  { key: "todo"  as const, label: "A Fazer",       color: "bg-slate-400",  light: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-700"  },
  { key: "doing" as const, label: "Em Andamento",  color: "bg-blue-500",   light: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-700"   },
  { key: "done"  as const, label: "Concluído",     color: "bg-green-500",  light: "bg-green-50",  border: "border-green-200",  text: "text-green-700"  },
] as const;

const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  alta:  { label: "Alta",  color: "bg-red-100 text-red-700 border-red-200" },
  media: { label: "Média", color: "bg-amber-100 text-amber-700 border-amber-200" },
  baixa: { label: "Baixa", color: "bg-slate-100 text-slate-600 border-slate-200" },
};

type TeamUser = { id: number; name: string; role: string };

type TaskFormData = {
  title: string; description: string; status: TaskStatus; priority: TaskPriority;
  assigneeId: string; sectorId: string; dueDate: string;
};

const emptyForm: TaskFormData = {
  title: "", description: "", status: "todo", priority: "media",
  assigneeId: "", sectorId: "", dueDate: "",
};

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const m = PRIORITY_META[priority] ?? PRIORITY_META.media;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${m.color}`}>
      <Flag className="w-2.5 h-2.5" />{m.label}
    </span>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function isOverdue(iso: string, status: TaskStatus): boolean {
  if (status === "done") return false;
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

function TaskCard({
  task, onMove, onEdit, onDelete, colIdx, canComplete, onOpenDetail,
}: {
  task: Task;
  onMove: (id: number, status: TaskStatus) => void;
  onEdit: (t: Task) => void;
  onDelete: (id: number) => void;
  colIdx: number;
  canComplete: boolean;
  onOpenDetail: (t: Task) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const prev = COLUMNS[colIdx - 1];
  // Só o responsável pode mover a tarefa para "Concluído".
  const nextCol = COLUMNS[colIdx + 1];
  const next = nextCol?.key === "done" && !canComplete ? undefined : nextCol;
  const overdue = task.dueDate ? isOverdue(task.dueDate, task.status) : false;

  return (
    <div
      className="bg-white rounded-2xl border border-border shadow-sm p-4 space-y-2 hover:shadow-md transition group"
      data-testid={`task-card-${task.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground break-words">{task.title}</p>
        </div>
        <div className="relative shrink-0">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 rounded-lg text-muted-foreground hover:bg-secondary transition"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <circle cx="10" cy="4" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="10" cy="16" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-20 bg-white border border-border rounded-xl shadow-lg p-1 min-w-[170px]">
              <button onClick={() => { onEdit(task); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                <Pencil className="w-3 h-3" /> Editar
              </button>
              {prev && (
                <button onClick={() => { onMove(task.id, prev.key); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                  <ChevronLeft className="w-3 h-3" /> Mover para {prev.label}
                </button>
              )}
              {next && (
                <button onClick={() => { onMove(task.id, next.key); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                  <ChevronRight className="w-3 h-3" /> Mover para {next.label}
                </button>
              )}
              <button onClick={() => { onDelete(task.id); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg text-destructive hover:bg-destructive/10 transition">
                <Trash2 className="w-3 h-3" /> Excluir
              </button>
            </div>
          )}
        </div>
      </div>

      {task.description && (
        <p className="text-xs text-muted-foreground line-clamp-3">{task.description}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <PriorityBadge priority={task.priority} />
        {task.dueDate && (
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${overdue ? "bg-red-100 text-red-700 border-red-200" : "bg-slate-100 text-slate-600 border-slate-200"}`}>
            {overdue ? <AlertCircle className="w-2.5 h-2.5" /> : <Calendar className="w-2.5 h-2.5" />}
            {fmtDate(task.dueDate)}
          </span>
        )}
        {task.sector && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white"
            style={{ backgroundColor: task.sector.color }}
          >
            {task.sector.name}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-1 pt-1 border-t border-border">
        <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
          <User className="w-3 h-3 shrink-0" />
          <span className="truncate">{task.assignee ? task.assignee.name : "Sem responsável"}</span>
        </div>
        <button onClick={() => onOpenDetail(task)} data-testid={`button-task-detail-${task.id}`}
          className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-primary transition shrink-0">
          {(task.subtaskTotal ?? 0) > 0 && (
            <span className={`inline-flex items-center gap-0.5 font-semibold ${task.subtaskDone === task.subtaskTotal ? "text-green-600" : ""}`}>
              <CheckSquare className="w-3 h-3" />{task.subtaskDone}/{task.subtaskTotal}
            </span>
          )}
          <span className="inline-flex items-center gap-0.5 font-semibold">
            <MessageSquare className="w-3 h-3" />{task.commentCount ?? 0}
          </span>
        </button>
      </div>

      {/* Botões visíveis para mudar a tarefa de fase (sem precisar abrir o menu) */}
      {(prev || next) && (
        <div className="flex gap-1.5 pt-1">
          {prev && (
            <button onClick={() => onMove(task.id, prev.key)} data-testid={`button-task-prev-${task.id}`}
              className="flex-1 flex items-center justify-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition">
              <ChevronLeft className="w-3 h-3" /> {prev.label}
            </button>
          )}
          {next && (
            <button onClick={() => onMove(task.id, next.key)} data-testid={`button-task-next-${task.id}`}
              className={`flex-1 flex items-center justify-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg transition ${
                next.key === "done" ? "bg-green-600 text-white hover:bg-green-700" : "bg-primary text-white hover:opacity-90"
              }`}>
              {next.label} <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// `compact`: usado dentro da coluna lateral do chat interno (~300px no
// desktop) — as 3 colunas do kanban lado a lado ali ficam distorcidas, então
// empilha tudo em uma coluna só.
export default function TaskBoard({ compact = false }: { compact?: boolean } = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Task | null>(null);
  const [form, setForm] = useState<TaskFormData>(emptyForm);
  // Filtros do quadro: por setor e por responsável (vendedor).
  const [filterSector, setFilterSector] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  // Detalhe da tarefa: subtarefas (checklist) + chat de comentários.
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [subtasks, setSubtasks] = useState<TaskSubtask[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newSubtask, setNewSubtask] = useState("");
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  // Relatório por setor/vendedor.
  const [showReport, setShowReport] = useState(false);
  const [report, setReport] = useState<{ bySector: TaskReportBucket[]; byUser: TaskReportBucket[] } | null>(null);
  const isGlobal = user?.role === "admin" || user?.role === "supervisor";

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.tasks.list();
      setTasks(data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchTasks();
    api.sectors.list().then(setSectors).catch(() => {});
    api.chatUsers().then(setTeam).catch(() => {});
  }, [fetchTasks]);

  const openAdd = () => {
    setEditTarget(null);
    setForm({ ...emptyForm, sectorId: user?.sectorId ? String(user.sectorId) : "" });
    setShowForm(true);
  };

  const openEdit = (t: Task) => {
    setEditTarget(t);
    setForm({
      title: t.title,
      description: t.description ?? "",
      status: t.status,
      priority: t.priority,
      assigneeId: t.assigneeId ? String(t.assigneeId) : "",
      sectorId: t.sectorId ? String(t.sectorId) : "",
      dueDate: t.dueDate ? t.dueDate.slice(0, 10) : "",
    });
    setShowForm(true);
  };

  const openDetail = async (t: Task) => {
    setDetailTask(t);
    setSubtasks([]);
    setComments([]);
    setNewSubtask("");
    setNewComment("");
    try {
      const [subs, coms] = await Promise.all([api.tasks.subtasks(t.id), api.tasks.comments(t.id)]);
      // Ignora respostas atrasadas de outra tarefa (usuário trocou de cartão).
      setDetailTask((current) => {
        if (current?.id === t.id) { setSubtasks(subs); setComments(coms); }
        return current;
      });
    } catch { /* modal fica vazio; usuário pode reabrir */ }
  };

  // Mantém os contadores do cartão em dia após mexer em subtarefas/comentários.
  const bumpCounts = (taskId: number, delta: Partial<{ subtaskTotal: number; subtaskDone: number; commentCount: number }>) => {
    setTasks((prev) => prev.map((t) => t.id === taskId ? {
      ...t,
      subtaskTotal: (t.subtaskTotal ?? 0) + (delta.subtaskTotal ?? 0),
      subtaskDone: (t.subtaskDone ?? 0) + (delta.subtaskDone ?? 0),
      commentCount: (t.commentCount ?? 0) + (delta.commentCount ?? 0),
    } : t));
  };

  const addSubtask = async () => {
    if (!detailTask || !newSubtask.trim()) return;
    try {
      const s = await api.tasks.addSubtask(detailTask.id, newSubtask.trim());
      setSubtasks((prev) => [...prev, s]);
      setNewSubtask("");
      bumpCounts(detailTask.id, { subtaskTotal: 1 });
    } catch { toast({ title: "Erro ao adicionar subtarefa", variant: "destructive" }); }
  };

  const toggleSubtask = async (s: TaskSubtask) => {
    if (!detailTask) return;
    setSubtasks((prev) => prev.map((x) => x.id === s.id ? { ...x, isDone: !s.isDone } : x));
    bumpCounts(detailTask.id, { subtaskDone: s.isDone ? -1 : 1 });
    try {
      await api.tasks.updateSubtask(detailTask.id, s.id, { isDone: !s.isDone });
    } catch {
      setSubtasks((prev) => prev.map((x) => x.id === s.id ? { ...x, isDone: s.isDone } : x));
      bumpCounts(detailTask.id, { subtaskDone: s.isDone ? 1 : -1 });
    }
  };

  const removeSubtask = async (s: TaskSubtask) => {
    if (!detailTask) return;
    try {
      await api.tasks.removeSubtask(detailTask.id, s.id);
      setSubtasks((prev) => prev.filter((x) => x.id !== s.id));
      bumpCounts(detailTask.id, { subtaskTotal: -1, subtaskDone: s.isDone ? -1 : 0 });
    } catch { toast({ title: "Erro ao remover subtarefa", variant: "destructive" }); }
  };

  const addComment = async () => {
    if (!detailTask || !newComment.trim() || sendingComment) return;
    setSendingComment(true);
    try {
      const c = await api.tasks.addComment(detailTask.id, newComment.trim());
      setComments((prev) => [...prev, c]);
      setNewComment("");
      bumpCounts(detailTask.id, { commentCount: 1 });
    } catch { toast({ title: "Erro ao comentar", variant: "destructive" }); }
    finally { setSendingComment(false); }
  };

  const openReport = async () => {
    setShowReport(true);
    setReport(null);
    try { setReport(await api.tasks.report()); }
    catch { toast({ title: "Erro ao carregar relatório", variant: "destructive" }); }
  };

  const handleMove = async (id: number, status: TaskStatus) => {
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status } : t));
    try {
      await api.tasks.update(id, { status });
    } catch (err) {
      toast({ title: "Erro ao mover tarefa", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      fetchTasks();
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.tasks.remove(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      toast({ title: "Tarefa excluída" });
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) { toast({ title: "Título é obrigatório", variant: "destructive" }); return; }
    const payload = {
      title: form.title.trim(),
      description: form.description || undefined,
      status: form.status,
      priority: form.priority,
      assigneeId: form.assigneeId ? Number(form.assigneeId) : null,
      sectorId: form.sectorId ? Number(form.sectorId) : null,
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
    };
    try {
      if (editTarget) {
        const updated = await api.tasks.update(editTarget.id, payload);
        setTasks((prev) => prev.map((t) => t.id === editTarget.id ? updated : t));
        toast({ title: "Tarefa atualizada!" });
      } else {
        const created = await api.tasks.create(payload);
        setTasks((prev) => [created, ...prev]);
        toast({ title: "Tarefa criada!" });
      }
      setShowForm(false);
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  // Aplica os filtros de setor/responsável e ordena por prioridade
  // (Alta → Média → Baixa) e, dentro da mesma prioridade, pelo prazo mais próximo.
  const PRIORITY_ORDER: Record<string, number> = { alta: 0, media: 1, baixa: 2 };
  const visibleTasks = tasks.filter((t) =>
    (!filterSector || String(t.sectorId ?? "") === filterSector) &&
    (!filterAssignee || String(t.assigneeId ?? "") === filterAssignee));
  const byStatus = (status: TaskStatus) => visibleTasks
    .filter((t) => t.status === status)
    .sort((a, b) => {
      const pd = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
      if (pd !== 0) return pd;
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return ad - bd;
    });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-bold text-foreground flex items-center gap-2">
            <ListTodo className="w-5 h-5 text-primary" /> Quadro de Tarefas
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Organize as tarefas do atendimento entre a equipe</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={filterSector} onChange={(e) => setFilterSector(e.target.value)}
            data-testid="filter-task-sector"
            className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
            <option value="">Todos os setores</option>
            {sectors.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
          <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}
            data-testid="filter-task-assignee"
            className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
            <option value="">Todos os responsáveis</option>
            {team.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
          </select>
          <button onClick={openReport} data-testid="button-task-report"
            title="Relatório por setor e vendedor"
            className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-xl text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
            <BarChart3 className="w-3.5 h-3.5" /> Relatório
          </button>
          <button onClick={fetchTasks}
            className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={openAdd} data-testid="button-task-add"
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
            <Plus className="w-3.5 h-3.5" /> Nova Tarefa
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className={`grid gap-3 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
        {[
          { label: "Total", value: visibleTasks.length, color: "text-foreground" },
          { label: "A Fazer", value: byStatus("todo").length, color: "text-slate-600" },
          { label: "Em Andamento", value: byStatus("doing").length, color: "text-blue-600" },
          { label: "Concluídas", value: byStatus("done").length, color: "text-green-600" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-border p-3 text-center">
            <p className={`text-lg font-bold ${color}`}>{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* Kanban */}
      <div className={`grid gap-4 items-start ${compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-3"}`}>
        {COLUMNS.map((col, colIdx) => {
          const cards = byStatus(col.key);
          return (
            <div key={col.key} className={`rounded-2xl ${col.light} border ${col.border} p-4`} data-testid={`task-col-${col.key}`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${col.color}`} />
                  <span className={`text-sm font-bold ${col.text}`}>{col.label}</span>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${col.light} ${col.text} border ${col.border}`}>
                  {loading ? "…" : cards.length}
                </span>
              </div>
              <div className="space-y-3">
                {loading ? (
                  <div className="h-20 rounded-xl bg-white/60 animate-pulse" />
                ) : cards.length === 0 ? (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    <p>Nenhuma tarefa aqui</p>
                    <button onClick={openAdd} className={`mt-2 ${col.text} font-semibold underline underline-offset-2`}>
                      Adicionar
                    </button>
                  </div>
                ) : (
                  cards.map((t) => (
                    <TaskCard
                      key={t.id} task={t} onMove={handleMove}
                      onEdit={openEdit} onDelete={handleDelete}
                      colIdx={colIdx}
                      canComplete={t.assigneeId == null || t.assigneeId === user?.id}
                      onOpenDetail={openDetail}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detalhe: subtarefas + chat de comentários */}
      {detailTask && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDetailTask(null)}>
          <div className="shk-card w-full max-w-md p-5 max-h-[90vh] overflow-y-auto space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-bold text-sm break-words">{detailTask.title}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {detailTask.assignee ? `Responsável: ${detailTask.assignee.name}` : "Sem responsável"}
                  {detailTask.sector ? ` · ${detailTask.sector.name}` : ""}
                </p>
              </div>
              <button onClick={() => setDetailTask(null)}><X className="w-5 h-5 text-muted-foreground shrink-0" /></button>
            </div>

            {/* Subtarefas */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckSquare className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-bold">Subtarefas</span>
                {subtasks.length > 0 && (
                  <span className="text-[10px] text-muted-foreground font-semibold">
                    {subtasks.filter((s) => s.isDone).length}/{subtasks.length}
                  </span>
                )}
              </div>
              {subtasks.length > 0 && (
                <div className="h-1.5 bg-secondary rounded-full mb-2 overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: `${(subtasks.filter((s) => s.isDone).length / subtasks.length) * 100}%` }} />
                </div>
              )}
              <div className="space-y-1">
                {subtasks.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 group/sub px-1 py-1 rounded-lg hover:bg-secondary/40">
                    <input type="checkbox" checked={s.isDone} onChange={() => toggleSubtask(s)}
                      data-testid={`subtask-check-${s.id}`}
                      className="w-4 h-4 accent-green-600 shrink-0 cursor-pointer" />
                    <span className={`text-xs flex-1 break-words ${s.isDone ? "line-through text-muted-foreground" : ""}`}>{s.title}</span>
                    <button onClick={() => removeSubtask(s)} className="opacity-0 group-hover/sub:opacity-100 transition">
                      <Trash2 className="w-3 h-3 text-red-400" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5 mt-2">
                <input value={newSubtask} onChange={(e) => setNewSubtask(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSubtask(); } }}
                  placeholder="Nova subtarefa..." data-testid="input-new-subtask"
                  className="flex-1 px-3 py-1.5 rounded-xl border border-border text-xs" />
                <button onClick={addSubtask} disabled={!newSubtask.trim()} data-testid="button-add-subtask"
                  className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-40">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Chat de comentários */}
            <div className="border-t border-border pt-3">
              <div className="flex items-center gap-1.5 mb-2">
                <MessageSquare className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-bold">Comentários</span>
              </div>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {comments.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-3">Nenhum comentário. Tire dúvidas ou complemente a tarefa aqui.</p>
                )}
                {comments.map((c) => {
                  const mine = c.authorId === user?.id;
                  return (
                    <div key={c.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-1.5 ${mine ? "bg-primary text-white rounded-br-sm" : "bg-secondary rounded-bl-sm"}`}>
                        {!mine && <div className="text-[10px] font-bold text-primary">{c.authorName ?? "—"}</div>}
                        <div className="text-xs whitespace-pre-wrap break-words">{c.content}</div>
                        <div className={`text-[9px] mt-0.5 text-right ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                          {new Date(c.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-1.5 mt-2">
                <input value={newComment} onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addComment(); } }}
                  placeholder="Escreva um comentário..." data-testid="input-new-comment"
                  className="flex-1 px-3 py-1.5 rounded-xl border border-border text-xs" />
                <button onClick={addComment} disabled={!newComment.trim() || sendingComment} data-testid="button-add-comment"
                  className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-40">
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Relatório por setor e vendedor */}
      {showReport && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowReport(false)}>
          <div className="shk-card w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold flex items-center gap-2"><BarChart3 className="w-4 h-4 text-primary" /> Relatório de Tarefas</h3>
              <button onClick={() => setShowReport(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            {!report ? (
              <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
            ) : (
              (["bySector", "byUser"] as const).map((key) => (
                <div key={key}>
                  <p className="text-xs font-bold mb-2">{key === "bySector" ? "Por setor" : "Por vendedor"}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border">
                          <th className="text-left py-1.5 pr-2 font-semibold">{key === "bySector" ? "Setor" : "Vendedor"}</th>
                          <th className="text-center py-1.5 px-2 font-semibold">Total</th>
                          <th className="text-center py-1.5 px-2 font-semibold">A Fazer</th>
                          <th className="text-center py-1.5 px-2 font-semibold">Andamento</th>
                          <th className="text-center py-1.5 px-2 font-semibold">Concluídas</th>
                          <th className="text-center py-1.5 pl-2 font-semibold text-red-600">Atrasadas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report[key].length === 0 && (
                          <tr><td colSpan={6} className="py-3 text-center text-muted-foreground">Sem tarefas.</td></tr>
                        )}
                        {report[key].map((b) => (
                          <tr key={b.name} className="border-b border-border/50">
                            <td className="py-1.5 pr-2 font-medium">{b.name}</td>
                            <td className="text-center py-1.5 px-2 font-bold">{b.total}</td>
                            <td className="text-center py-1.5 px-2">{b.todo}</td>
                            <td className="text-center py-1.5 px-2 text-blue-600">{b.doing}</td>
                            <td className="text-center py-1.5 px-2 text-green-600">{b.done}</td>
                            <td className={`text-center py-1.5 pl-2 font-bold ${b.overdue > 0 ? "text-red-600" : "text-muted-foreground"}`}>{b.overdue}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Add/Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editTarget ? "Editar Tarefa" : "Nova Tarefa"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Título *</label>
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Ex: Retornar ligação do cliente João" data-testid="input-task-title"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Descrição</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Detalhes da tarefa..." rows={3}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Coluna</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Prioridade</label>
                  <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    {(["alta", "media", "baixa"] as const).map((p) => (
                      <option key={p} value={p}>{PRIORITY_META[p].label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Responsável</label>
                <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                  data-testid="select-task-assignee"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  <option value="">— Sem responsável —</option>
                  {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              {isGlobal && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Setor</label>
                  <select value={form.sectorId} onChange={(e) => setForm({ ...form, sectorId: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    <option value="">— Nenhum —</option>
                    {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs font-medium mb-1 block">Prazo</label>
                <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
                  Cancelar
                </button>
                <button type="submit" data-testid="button-task-save"
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition">
                  {editTarget ? "Salvar" : "Criar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
