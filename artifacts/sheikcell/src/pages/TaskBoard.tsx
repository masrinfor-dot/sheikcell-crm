import { useState, useEffect, useCallback, useRef } from "react";
import { api, canEditModule, type Task, type TaskStatus, type TaskPriority, type Sector, type TaskComment, type TaskSubtask, type TaskReportBucket, type TaskReminder, type CrmContact } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { acquireSharedEventSource, releaseSharedEventSource } from "@/lib/sharedEventSource";
import {
  Plus, X, RefreshCw, Trash2, ChevronRight, ChevronLeft,
  User, Calendar, Flag, ListTodo, Pencil, AlertCircle,
  MessageSquare, CheckSquare, Send, BarChart3,
  ChevronUp, ChevronDown, Paperclip, FileText, Clock,
  Bell, Search, Users2,
} from "lucide-react";

const EVENTS_URL = "/api/chat/events";

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
  assigneeIds: number[]; sectorId: string; dueDate: string;
  // Agenda: cliente vinculado (id + rótulo pra mostrar no campo de busca),
  // duração em minutos e alerta prévio em minutos (string vazia = sem alerta).
  contactId: string; contactLabel: string; durationMinutes: string; alertMinutesBefore: string;
};

const emptyForm: TaskFormData = {
  title: "", description: "", status: "todo", priority: "media",
  assigneeIds: [], sectorId: "", dueDate: "",
  contactId: "", contactLabel: "", durationMinutes: "", alertMinutesBefore: "15",
};

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120] as const;
const ALERT_OPTIONS = [
  { value: "", label: "Sem alerta" },
  { value: "5", label: "5 min antes" },
  { value: "15", label: "15 min antes" },
  { value: "30", label: "30 min antes" },
  { value: "60", label: "1 hora antes" },
  { value: "1440", label: "1 dia antes" },
] as const;

// dueDate vem do banco em ISO (UTC); <input type="datetime-local"> precisa
// de "YYYY-MM-DDTHH:mm" no fuso LOCAL do navegador — sem isso o horário
// mostrado no formulário fica errado (deslocado pelo fuso).
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Rótulo amigável do dia: Hoje / Amanhã / Ontem, senão dia da semana + data.
function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const target = new Date(y!, m! - 1, d!);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Amanhã";
  if (diffDays === -1) return "Ontem";
  const weekday = target.toLocaleDateString("pt-BR", { weekday: "long" });
  const date = target.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${date}`;
}

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

// Agora que a Agenda expõe horário de verdade (não só data), compara com o
// instante atual em vez de "meia-noite de hoje" — um compromisso às 9h fica
// atrasado às 9h01, não só no dia seguinte.
function isOverdue(iso: string, status: TaskStatus): boolean {
  if (status === "done") return false;
  return new Date(iso) < new Date();
}

function TaskCard({
  task, onMove, onEdit, onDelete, canComplete, onOpenDetail, hasUnread, canEdit,
}: {
  task: Task;
  onMove: (id: number, status: TaskStatus) => void;
  onEdit: (t: Task) => void;
  onDelete: (id: number) => void;
  canComplete: boolean;
  onOpenDetail: (t: Task) => void;
  hasUnread: boolean;
  canEdit: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Fase atual calculada a partir do STATUS da tarefa (não mais da coluna
  // onde o cartão está renderizado — a Agenda agrupa por dia, não por fase).
  const curIdx = COLUMNS.findIndex((c) => c.key === task.status);
  const prev = canEdit ? COLUMNS[curIdx - 1] : undefined;
  // Só o responsável pode mover a tarefa para "Concluído".
  const nextCol = canEdit ? COLUMNS[curIdx + 1] : undefined;
  const next = nextCol?.key === "done" && !canComplete ? undefined : nextCol;
  // No menu (⋮) mostra TODAS as outras fases, não só a vizinha — permite
  // pular direto de "A Fazer" pra "Concluído", por exemplo.
  const otherStatuses = canEdit
    ? COLUMNS.filter((c) => c.key !== task.status && (c.key !== "done" || canComplete))
    : [];
  const overdue = task.dueDate ? isOverdue(task.dueDate, task.status) : false;
  const statusMeta = COLUMNS.find((c) => c.key === task.status) ?? COLUMNS[0]!;

  return (
    <div
      className="bg-white rounded-2xl border border-border shadow-sm p-4 space-y-2 hover:shadow-md transition group"
      data-testid={`task-card-${task.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[15px] leading-snug text-foreground break-words">{task.title}</p>
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
              {canEdit && (
                <>
                  <button onClick={() => { onEdit(task); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                    <Pencil className="w-3 h-3" /> Editar
                  </button>
                  {otherStatuses.map((col) => (
                    <button key={col.key} onClick={() => { onMove(task.id, col.key); setMenuOpen(false); }}
                      className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                      <div className={`w-2 h-2 rounded-full ${col.color}`} /> Mover para {col.label}
                    </button>
                  ))}
                  <button onClick={() => { onDelete(task.id); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg text-destructive hover:bg-destructive/10 transition">
                    <Trash2 className="w-3 h-3" /> Excluir
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground/80 truncate">
        Criada por {task.createdBy?.name ?? "—"}
      </p>

      {task.description && (
        <p className="text-[13px] leading-relaxed text-muted-foreground line-clamp-3">{task.description}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${statusMeta.light} ${statusMeta.text} ${statusMeta.border}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${statusMeta.color}`} /> {statusMeta.label}
        </span>
        <PriorityBadge priority={task.priority} />
        {task.dueDate && (
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${overdue ? "bg-red-100 text-red-700 border-red-200" : "bg-slate-100 text-slate-600 border-slate-200"}`}>
            {overdue ? <AlertCircle className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
            {fmtDate(task.dueDate)} · {fmtTime(task.dueDate)}
            {task.durationMinutes ? ` (${task.durationMinutes}min)` : ""}
          </span>
        )}
        {task.contact && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-violet-50 text-violet-700 border-violet-200">
            <User className="w-2.5 h-2.5" /> {task.contact.name}
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
        <div className="flex items-center gap-1 text-[13px] text-muted-foreground min-w-0">
          <User className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            {task.assignees.length > 0 ? task.assignees.map((a) => a.name).join(", ") : "Sem responsável"}
          </span>
        </div>
        <button onClick={() => onOpenDetail(task)} data-testid={`button-task-detail-${task.id}`}
          className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-primary transition shrink-0">
          {(task.subtaskTotal ?? 0) > 0 && (
            <span className={`inline-flex items-center gap-0.5 font-semibold ${task.subtaskDone === task.subtaskTotal ? "text-green-600" : ""}`}>
              <CheckSquare className="w-3 h-3" />{task.subtaskDone}/{task.subtaskTotal}
            </span>
          )}
          <span className="relative inline-flex items-center gap-0.5 font-semibold">
            <MessageSquare className="w-3 h-3" />{task.commentCount ?? 0}
            {hasUnread && (
              <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-red-500" data-testid={`task-unread-${task.id}`} />
            )}
          </span>
        </button>
      </div>

      {/* Botões visíveis para mudar a tarefa de fase (sem precisar abrir o menu) */}
      {(prev || next) && (
        <div className="flex gap-1.5 pt-1">
          {prev && (
            <button onClick={() => onMove(task.id, prev.key)} data-testid={`button-task-prev-${task.id}`}
              className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold px-2 py-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition">
              <ChevronLeft className="w-3.5 h-3.5" /> {prev.label}
            </button>
          )}
          {next && (
            <button onClick={() => onMove(task.id, next.key)} data-testid={`button-task-next-${task.id}`}
              className={`flex-1 flex items-center justify-center gap-1 text-xs font-semibold px-2 py-2 rounded-lg transition ${
                next.key === "done" ? "bg-green-600 text-white hover:bg-green-700" : "bg-primary text-white hover:opacity-90"
              }`}>
              {next.label} <ChevronRight className="w-3.5 h-3.5" />
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
  const canEdit = canEditModule(user, "tarefas");
  const { toast } = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Task | null>(null);
  const [form, setForm] = useState<TaskFormData>(emptyForm);
  // Filtros da agenda: por setor, responsável (vendedor) e fase.
  const [filterSector, setFilterSector] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  // Busca de cliente do CRM pra vincular ao compromisso (dropdown de resultados).
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<CrmContact[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contactDropdownOpen, setContactDropdownOpen] = useState(false);
  const contactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lembretes de compromisso (Agenda) recebidos em tempo real via SSE +
  // carregados na entrada (pra quem perdeu o evento por estar offline).
  const [reminders, setReminders] = useState<TaskReminder[]>([]);
  // Detalhe da tarefa: subtarefas (checklist) + chat de comentários.
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [subtasks, setSubtasks] = useState<TaskSubtask[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newSubtask, setNewSubtask] = useState("");
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const [commentAttachment, setCommentAttachment] = useState<{ file: File; previewUrl: string | null } | null>(null);
  const [unreadTaskIds, setUnreadTaskIds] = useState<Set<number>>(new Set());
  const commentFileInputRef = useRef<HTMLInputElement>(null);
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
    api.tasks.notifications.unread().then((r) => setUnreadTaskIds(new Set(r.taskIds))).catch(() => {});
    api.tasks.reminders.unread().then(setReminders).catch(() => {});
  }, [fetchTasks]);

  // Lembrete de compromisso em tempo real: chega via SSE (mesmo canal que o
  // resto do sistema já usa — sseEmitter.ts no backend) assim que o job
  // periódico do servidor detecta que está perto do horário marcado.
  useEffect(() => {
    const es = acquireSharedEventSource(EVENTS_URL);
    const onReminder = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { taskId: number; title: string; dueDate: string };
        setReminders((prev) => (prev.some((r) => r.taskId === data.taskId) ? prev : [
          { id: -data.taskId, taskId: data.taskId, title: data.title, dueDate: data.dueDate, read: false, createdAt: new Date().toISOString() },
          ...prev,
        ]));
        toast({ title: "⏰ Compromisso chegando", description: `${data.title} às ${fmtTime(data.dueDate)}` });
      } catch { /* evento mal formado, ignora */ }
    };
    es.addEventListener("task_reminder", onReminder);
    return () => {
      es.removeEventListener("task_reminder", onReminder);
      releaseSharedEventSource(EVENTS_URL);
    };
  }, [toast]);

  const dismissReminder = (r: TaskReminder) => {
    setReminders((prev) => prev.filter((x) => x.id !== r.id));
    if (r.id > 0) api.tasks.reminders.markRead(r.id).catch(() => {});
  };

  // Busca de cliente do CRM com debounce simples (evita bater na API a cada tecla).
  useEffect(() => {
    if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current);
    if (!contactQuery.trim()) { setContactResults([]); return; }
    setContactSearching(true);
    contactSearchTimer.current = setTimeout(() => {
      api.crm.list({ search: contactQuery.trim() })
        .then((r) => setContactResults(r.slice(0, 8)))
        .catch(() => setContactResults([]))
        .finally(() => setContactSearching(false));
    }, 300);
    return () => { if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current); };
  }, [contactQuery]);

  const openAdd = () => {
    setEditTarget(null);
    setForm({ ...emptyForm, sectorId: user?.sectorId ? String(user.sectorId) : "" });
    setContactQuery("");
    setShowForm(true);
  };

  const openEdit = (t: Task) => {
    setEditTarget(t);
    setForm({
      title: t.title,
      description: t.description ?? "",
      status: t.status,
      priority: t.priority,
      assigneeIds: t.assignees.map((a) => a.id),
      sectorId: t.sectorId ? String(t.sectorId) : "",
      dueDate: t.dueDate ? toDatetimeLocal(t.dueDate) : "",
      contactId: t.contactId ? String(t.contactId) : "",
      contactLabel: t.contact?.name ?? "",
      durationMinutes: t.durationMinutes ? String(t.durationMinutes) : "",
      alertMinutesBefore: t.alertMinutesBefore != null ? String(t.alertMinutesBefore) : "",
    });
    setContactQuery("");
    setShowForm(true);
  };

  const openDetail = async (t: Task) => {
    setDetailTask(t);
    setSubtasks([]);
    setComments([]);
    setNewSubtask("");
    setNewComment("");
    setCommentAttachment(null);
    if (unreadTaskIds.has(t.id)) {
      setUnreadTaskIds((prev) => { const next = new Set(prev); next.delete(t.id); return next; });
      api.tasks.notifications.markRead(t.id).catch(() => {});
    }
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

  // Reordena trocando a posição com o vizinho (setinhas ↑/↓ em vez de arrastar).
  const moveSubtask = async (index: number, direction: -1 | 1) => {
    if (!detailTask) return;
    const target = index + direction;
    if (target < 0 || target >= subtasks.length) return;
    const a = subtasks[index]!;
    const b = subtasks[target]!;
    const before = subtasks;
    const reordered = [...subtasks];
    reordered[index] = b;
    reordered[target] = a;
    setSubtasks(reordered);
    try {
      await Promise.all([
        api.tasks.updateSubtask(detailTask.id, a.id, { position: b.position }),
        api.tasks.updateSubtask(detailTask.id, b.id, { position: a.position }),
      ]);
    } catch {
      setSubtasks(before);
      toast({ title: "Erro ao reordenar subtarefa", variant: "destructive" });
    }
  };

  const pickCommentAttachment = (file: File) => {
    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    setCommentAttachment({ file, previewUrl });
  };

  const addComment = async () => {
    if (!detailTask || (!newComment.trim() && !commentAttachment) || sendingComment) return;
    setSendingComment(true);
    try {
      const attachment = commentAttachment
        ? await new Promise<{ base64: string; mimetype: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ base64: (reader.result as string).split(",")[1]!, mimetype: commentAttachment.file.type });
            reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
            reader.readAsDataURL(commentAttachment.file);
          })
        : undefined;
      const c = await api.tasks.addComment(detailTask.id, newComment.trim(), attachment);
      setComments((prev) => [...prev, c]);
      setNewComment("");
      if (commentAttachment?.previewUrl) URL.revokeObjectURL(commentAttachment.previewUrl);
      setCommentAttachment(null);
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
      assigneeIds: form.assigneeIds,
      sectorId: form.sectorId ? Number(form.sectorId) : null,
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      contactId: form.contactId ? Number(form.contactId) : null,
      durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
      alertMinutesBefore: form.dueDate && form.alertMinutesBefore ? Number(form.alertMinutesBefore) : null,
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

  // Aplica os filtros de setor/responsável/fase.
  const PRIORITY_ORDER: Record<string, number> = { alta: 0, media: 1, baixa: 2 };
  const visibleTasks = tasks.filter((t) =>
    (!filterSector || String(t.sectorId ?? "") === filterSector) &&
    (!filterAssignee || t.assignees.some((a) => String(a.id) === filterAssignee)) &&
    (!filterStatus || t.status === filterStatus));
  const byStatus = (status: TaskStatus) => visibleTasks.filter((t) => t.status === status);

  // Agenda: separa quem tem horário marcado (compromisso) de quem não tem
  // (backlog comum, continua funcionando como antes) — e agrupa os
  // compromissos por dia, em ordem cronológica.
  const scheduled = visibleTasks
    .filter((t) => t.dueDate)
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());
  const backlog = visibleTasks
    .filter((t) => !t.dueDate)
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));
  const dayGroups: { key: string; tasks: Task[] }[] = [];
  for (const t of scheduled) {
    const key = dayKey(t.dueDate!);
    const group = dayGroups.find((g) => g.key === key);
    if (group) group.tasks.push(t);
    else dayGroups.push({ key, tasks: [t] });
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-bold text-foreground flex items-center gap-2">
            <ListTodo className="w-5 h-5 text-primary" /> Agenda
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Compromissos e tarefas da equipe, organizados por dia</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
            data-testid="filter-task-status"
            className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
            <option value="">Todas as fases</option>
            {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
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
          {canEdit && (
            <button onClick={openAdd} data-testid="button-task-add"
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
              <Plus className="w-3.5 h-3.5" /> Nova Tarefa
            </button>
          )}
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

      {/* Lembretes de compromisso chegando (alerta em tempo real) */}
      {reminders.length > 0 && (
        <div className="space-y-1.5" data-testid="reminders-banner">
          {reminders.map((r) => (
            <div key={r.id} className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
              <Bell className="w-4 h-4 text-amber-600 shrink-0" />
              <div className="flex-1 min-w-0 text-xs">
                <span className="font-semibold text-amber-900">{r.title}</span>
                <span className="text-amber-700"> · {fmtTime(r.dueDate)}</span>
              </div>
              <button onClick={() => dismissReminder(r)} data-testid={`button-dismiss-reminder-${r.id}`}
                className="p-1 rounded-lg text-amber-600 hover:bg-amber-100 transition shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Agenda: compromissos com horário, agrupados por dia (cronológico) */}
      {loading ? (
        <div className="space-y-3">
          <div className="h-24 rounded-2xl bg-white/60 animate-pulse" />
          <div className="h-24 rounded-2xl bg-white/60 animate-pulse" />
        </div>
      ) : (
        <div className="space-y-4">
          {dayGroups.length === 0 && backlog.length === 0 && (
            <div className="text-center py-10 text-sm text-muted-foreground bg-white rounded-2xl border border-border">
              <p>Nenhum compromisso ou tarefa por aqui</p>
              {canEdit && (
                <button onClick={openAdd} className="mt-2 text-primary font-semibold underline underline-offset-2">
                  Adicionar
                </button>
              )}
            </div>
          )}

          {dayGroups.map((group) => (
            <div key={group.key} className="rounded-2xl bg-white border border-border p-4" data-testid={`agenda-day-${group.key}`}>
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-3.5 h-3.5 text-primary" />
                <span className="text-sm font-bold text-foreground">{dayLabel(group.key)}</span>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  {group.tasks.length}
                </span>
              </div>
              <div className={`grid gap-3 items-start ${compact ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2"}`}>
                {group.tasks.map((t) => (
                  <TaskCard
                    key={t.id} task={t} onMove={handleMove}
                    onEdit={openEdit} onDelete={handleDelete}
                    canComplete={t.assignees.length === 0 || t.assignees.some((a) => a.id === user?.id)}
                    onOpenDetail={openDetail}
                    hasUnread={unreadTaskIds.has(t.id)}
                    canEdit={canEdit}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Backlog: tarefas sem horário marcado — continua funcionando igual antes. */}
          {(backlog.length > 0 || dayGroups.length === 0) && (
            <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4" data-testid="agenda-backlog">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <ListTodo className="w-3.5 h-3.5 text-slate-500" />
                  <span className="text-sm font-bold text-slate-700">Sem horário marcado</span>
                </div>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white text-slate-600 border border-slate-200">
                  {backlog.length}
                </span>
              </div>
              {backlog.length === 0 ? (
                <div className="text-center py-6 text-xs text-muted-foreground">
                  <p>Nenhuma tarefa sem horário</p>
                  {canEdit && (
                    <button onClick={openAdd} className="mt-2 text-slate-600 font-semibold underline underline-offset-2">
                      Adicionar
                    </button>
                  )}
                </div>
              ) : (
                <div className={`grid gap-3 items-start ${compact ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2"}`}>
                  {backlog.map((t) => (
                    <TaskCard
                      key={t.id} task={t} onMove={handleMove}
                      onEdit={openEdit} onDelete={handleDelete}
                      canComplete={t.assignees.length === 0 || t.assignees.some((a) => a.id === user?.id)}
                      onOpenDetail={openDetail}
                      hasUnread={unreadTaskIds.has(t.id)}
                      canEdit={canEdit}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Detalhe: subtarefas + chat de comentários */}
      {detailTask && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDetailTask(null)}>
          <div className="shk-card w-full max-w-md p-5 max-h-[90vh] overflow-y-auto space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-bold text-sm break-words">{detailTask.title}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {detailTask.assignees.length > 0 ? `Responsáveis: ${detailTask.assignees.map((a) => a.name).join(", ")}` : "Sem responsável"}
                  {detailTask.sector ? ` · ${detailTask.sector.name}` : ""}
                </p>
                <p className="text-[11px] text-muted-foreground/80 flex items-center gap-1 mt-0.5">
                  <Clock className="w-3 h-3 shrink-0" />
                  Criada por {detailTask.createdBy?.name ?? "—"} em {new Date(detailTask.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <button onClick={() => setDetailTask(null)}><X className="w-5 h-5 text-muted-foreground shrink-0" /></button>
            </div>

            {/* Subtarefas */}
            <fieldset disabled={!canEdit} className="border-0 p-0 m-0">
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
                {subtasks.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-2 group/sub px-1 py-1 rounded-lg hover:bg-secondary/40">
                    <input type="checkbox" checked={s.isDone} onChange={() => toggleSubtask(s)}
                      data-testid={`subtask-check-${s.id}`}
                      className="w-4 h-4 accent-green-600 shrink-0 cursor-pointer" />
                    <span className={`text-xs flex-1 break-words ${s.isDone ? "line-through text-muted-foreground" : ""}`}>{s.title}</span>
                    <div className="flex items-center opacity-0 group-hover/sub:opacity-100 transition shrink-0">
                      <button onClick={() => moveSubtask(i, -1)} disabled={i === 0} data-testid={`subtask-up-${s.id}`}
                        className="p-0.5 text-muted-foreground hover:text-primary disabled:opacity-30 disabled:hover:text-muted-foreground">
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => moveSubtask(i, 1)} disabled={i === subtasks.length - 1} data-testid={`subtask-down-${s.id}`}
                        className="p-0.5 text-muted-foreground hover:text-primary disabled:opacity-30 disabled:hover:text-muted-foreground">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => removeSubtask(s)} className="p-0.5 ml-0.5">
                        <Trash2 className="w-3 h-3 text-red-400" />
                      </button>
                    </div>
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
            </fieldset>

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
                        {c.mediaUrl && c.mediaType === "image" && (
                          <a href={c.mediaUrl} target="_blank" rel="noopener noreferrer" className="block mb-1">
                            <img src={c.mediaUrl} alt="Anexo" className="max-w-full max-h-40 rounded-lg object-cover" />
                          </a>
                        )}
                        {c.mediaUrl && c.mediaType === "doc" && (
                          <a href={c.mediaUrl} target="_blank" rel="noopener noreferrer" download
                            className={`flex items-center gap-1.5 mb-1 rounded-lg px-2 py-1 ${mine ? "bg-white/15" : "bg-white"}`}>
                            <FileText className="w-3.5 h-3.5 shrink-0" />
                            <span className="text-[11px] truncate">Anexo</span>
                          </a>
                        )}
                        {c.content && <div className="text-xs whitespace-pre-wrap break-words">{c.content}</div>}
                        <div className={`text-[9px] mt-0.5 text-right ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                          {new Date(c.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {canEdit && commentAttachment && (
                <div className="flex items-center gap-2 mt-2 bg-secondary/50 rounded-lg px-2 py-1.5">
                  {commentAttachment.previewUrl ? (
                    <img src={commentAttachment.previewUrl} alt="Anexo" className="w-8 h-8 rounded object-cover shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-[11px] text-muted-foreground truncate flex-1">{commentAttachment.file.name}</span>
                  <button onClick={() => {
                    if (commentAttachment.previewUrl) URL.revokeObjectURL(commentAttachment.previewUrl);
                    setCommentAttachment(null);
                  }} data-testid="button-remove-comment-attachment">
                    <X className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
              )}
              {canEdit && (
                <div className="flex gap-1.5 mt-2">
                  <input
                    ref={commentFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) pickCommentAttachment(file);
                      e.target.value = "";
                    }}
                  />
                  <button type="button" onClick={() => commentFileInputRef.current?.click()} data-testid="button-attach-comment"
                    className="px-2.5 py-1.5 rounded-xl border border-border text-muted-foreground hover:bg-secondary transition shrink-0">
                    <Paperclip className="w-3.5 h-3.5" />
                  </button>
                  <input value={newComment} onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addComment(); } }}
                    placeholder="Escreva um comentário..." data-testid="input-new-comment"
                    className="flex-1 px-3 py-1.5 rounded-xl border border-border text-xs" />
                  <button onClick={addComment} disabled={(!newComment.trim() && !commentAttachment) || sendingComment} data-testid="button-add-comment"
                    className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-40">
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
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
                <label className="text-xs font-medium mb-1 block">
                  Responsáveis {form.assigneeIds.length > 0 && `(${form.assigneeIds.length})`}
                </label>
                <div data-testid="select-task-assignee"
                  className="w-full max-h-36 overflow-y-auto rounded-xl border border-border text-sm divide-y divide-border">
                  {team.length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">Nenhum usuário disponível</p>
                  )}
                  {team.map((u) => {
                    const checked = form.assigneeIds.includes(u.id);
                    return (
                      <label key={u.id} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-secondary/40">
                        <input type="checkbox" checked={checked} data-testid={`checkbox-task-assignee-${u.id}`}
                          onChange={() => setForm((f) => ({
                            ...f,
                            assigneeIds: checked ? f.assigneeIds.filter((id) => id !== u.id) : [...f.assigneeIds, u.id],
                          }))}
                          className="w-3.5 h-3.5 accent-primary shrink-0" />
                        <span className="truncate">{u.name}</span>
                      </label>
                    );
                  })}
                </div>
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
                <label className="text-xs font-medium mb-1 block">Horário do compromisso</label>
                <input type="datetime-local" value={form.dueDate} data-testid="input-task-duedate"
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <p className="text-[11px] text-muted-foreground mt-1">Deixe em branco pra uma tarefa comum, sem horário marcado — ela entra na lista "Sem horário marcado".</p>
              </div>
              {form.dueDate && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium mb-1 block">Duração</label>
                    <select value={form.durationMinutes} data-testid="select-task-duration"
                      onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                      <option value="">—</option>
                      {DURATION_OPTIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block">Alerta</label>
                    <select value={form.alertMinutesBefore} data-testid="select-task-alert"
                      onChange={(e) => setForm({ ...form, alertMinutesBefore: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
                      {ALERT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
              <div className="relative">
                <label className="text-xs font-medium mb-1 block">Cliente (opcional)</label>
                {form.contactId ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-sm bg-secondary/30" data-testid="selected-task-contact">
                    <Users2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{form.contactLabel}</span>
                    <button type="button" onClick={() => setForm((f) => ({ ...f, contactId: "", contactLabel: "" }))}
                      data-testid="button-clear-task-contact">
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <input
                      value={contactQuery}
                      onChange={(e) => { setContactQuery(e.target.value); setContactDropdownOpen(true); }}
                      onFocus={() => setContactDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setContactDropdownOpen(false), 150)}
                      placeholder="Buscar cliente por nome ou telefone..."
                      data-testid="input-task-contact-search"
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    {contactDropdownOpen && contactQuery.trim() && (
                      <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-white border border-border rounded-xl shadow-lg max-h-48 overflow-y-auto">
                        {contactSearching ? (
                          <p className="px-3 py-2 text-xs text-muted-foreground">Buscando...</p>
                        ) : contactResults.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-muted-foreground">Nenhum cliente encontrado</p>
                        ) : contactResults.map((c) => (
                          <button key={c.id} type="button" data-testid={`option-task-contact-${c.id}`}
                            onClick={() => { setForm((f) => ({ ...f, contactId: String(c.id), contactLabel: c.name })); setContactQuery(""); setContactDropdownOpen(false); }}
                            className="w-full text-left px-3 py-2 text-xs hover:bg-secondary/40 transition border-b border-border/50 last:border-0">
                            <p className="font-medium truncate">{c.name}</p>
                            {c.contact && <p className="text-muted-foreground truncate">{c.contact}</p>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
