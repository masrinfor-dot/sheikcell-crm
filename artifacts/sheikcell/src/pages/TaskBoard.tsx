import { useState, useEffect, useCallback } from "react";
import { api, type Task, type TaskStatus, type TaskPriority, type Sector } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, X, RefreshCw, Trash2, ChevronRight, ChevronLeft,
  User, Calendar, Flag, ListTodo, Pencil, AlertCircle,
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
  task, onMove, onEdit, onDelete, colIdx,
}: {
  task: Task;
  onMove: (id: number, status: TaskStatus) => void;
  onEdit: (t: Task) => void;
  onDelete: (id: number) => void;
  colIdx: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const prev = COLUMNS[colIdx - 1];
  const next = COLUMNS[colIdx + 1];
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
      </div>
    </div>
  );
}

export default function TaskBoard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Task | null>(null);
  const [form, setForm] = useState<TaskFormData>(emptyForm);
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

  const handleMove = async (id: number, status: TaskStatus) => {
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, status } : t));
    try {
      await api.tasks.update(id, { status });
    } catch {
      toast({ title: "Erro ao mover tarefa", variant: "destructive" });
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

  const byStatus = (status: TaskStatus) => tasks.filter((t) => t.status === status);

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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total", value: tasks.length, color: "text-foreground" },
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
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
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

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
