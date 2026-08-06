import { useState, useEffect, useCallback } from "react";
import { api, type SystemBoardItem, type SystemBoardType, type SystemBoardStatus, type SystemBoardComment, type TaskPriority } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, X, RefreshCw, Trash2, ChevronRight, ChevronLeft,
  User, Calendar, Flag, Wrench, Pencil, AlertCircle, AlertTriangle,
  MessageSquare, Send, Sparkles, RefreshCcw,
} from "lucide-react";

const COLUMNS = [
  { key: "aberto"    as const, label: "Aberto",       color: "bg-slate-400", light: "bg-slate-50", border: "border-slate-200", text: "text-slate-700" },
  { key: "andamento" as const, label: "Em Andamento", color: "bg-blue-500",  light: "bg-blue-50",  border: "border-blue-200",  text: "text-blue-700"  },
  { key: "concluido" as const, label: "Concluído",    color: "bg-green-500", light: "bg-green-50", border: "border-green-200", text: "text-green-700" },
] as const;

const TYPE_META: Record<SystemBoardType, { label: string; icon: typeof AlertTriangle; color: string }> = {
  problema:       { label: "Problema",       icon: AlertTriangle, color: "bg-red-100 text-red-700 border-red-200" },
  atualizacao:    { label: "Atualização",    icon: RefreshCcw,    color: "bg-blue-100 text-blue-700 border-blue-200" },
  implementacao:  { label: "Implementação",  icon: Sparkles,      color: "bg-violet-100 text-violet-700 border-violet-200" },
};

const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  alta:  { label: "Alta",  color: "bg-red-100 text-red-700 border-red-200" },
  media: { label: "Média", color: "bg-amber-100 text-amber-700 border-amber-200" },
  baixa: { label: "Baixa", color: "bg-slate-100 text-slate-600 border-slate-200" },
};

type TeamUser = { id: number; name: string; role: string };

type ItemFormData = {
  type: SystemBoardType; title: string; description: string; status: SystemBoardStatus;
  priority: TaskPriority; responsibleId: string; dueDate: string;
};

const emptyForm: ItemFormData = {
  type: "problema", title: "", description: "", status: "aberto",
  priority: "media", responsibleId: "", dueDate: "",
};

function TypeBadge({ type }: { type: SystemBoardType }) {
  const m = TYPE_META[type] ?? TYPE_META.implementacao;
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${m.color}`}>
      <Icon className="w-2.5 h-2.5" />{m.label}
    </span>
  );
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

function isOverdue(iso: string, status: SystemBoardStatus): boolean {
  if (status === "concluido") return false;
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

function ItemCard({
  item, onMove, onEdit, onDelete, colIdx, onOpenDetail,
}: {
  item: SystemBoardItem;
  onMove: (id: number, status: SystemBoardStatus) => void;
  onEdit: (t: SystemBoardItem) => void;
  onDelete: (id: number) => void;
  colIdx: number;
  onOpenDetail: (t: SystemBoardItem) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const prev = COLUMNS[colIdx - 1];
  const next = COLUMNS[colIdx + 1];
  const overdue = item.dueDate ? isOverdue(item.dueDate, item.status) : false;

  return (
    <div
      className="bg-white rounded-2xl border border-border shadow-sm p-4 space-y-2 hover:shadow-md transition group"
      data-testid={`sysboard-card-${item.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[15px] leading-snug text-foreground break-words">{item.title}</p>
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
              <button onClick={() => { onEdit(item); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                <Pencil className="w-3 h-3" /> Editar
              </button>
              {prev && (
                <button onClick={() => { onMove(item.id, prev.key); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                  <ChevronLeft className="w-3 h-3" /> Mover para {prev.label}
                </button>
              )}
              {next && (
                <button onClick={() => { onMove(item.id, next.key); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                  <ChevronRight className="w-3 h-3" /> Mover para {next.label}
                </button>
              )}
              <button onClick={() => { onDelete(item.id); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg text-destructive hover:bg-destructive/10 transition">
                <Trash2 className="w-3 h-3" /> Excluir
              </button>
            </div>
          )}
        </div>
      </div>

      {item.description && (
        <p className="text-[13px] leading-relaxed text-muted-foreground line-clamp-3">{item.description}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <TypeBadge type={item.type} />
        <PriorityBadge priority={item.priority} />
        {item.dueDate && (
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${overdue ? "bg-red-100 text-red-700 border-red-200" : "bg-slate-100 text-slate-600 border-slate-200"}`}>
            {overdue ? <AlertCircle className="w-2.5 h-2.5" /> : <Calendar className="w-2.5 h-2.5" />}
            {fmtDate(item.dueDate)}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-1 pt-1 border-t border-border">
        <div className="flex items-center gap-1 text-[13px] text-muted-foreground min-w-0">
          <User className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{item.responsible ? item.responsible.name : "Sem responsável"}</span>
        </div>
        <button onClick={() => onOpenDetail(item)} data-testid={`button-sysboard-detail-${item.id}`}
          className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-primary transition shrink-0">
          <span className="inline-flex items-center gap-0.5 font-semibold">
            <MessageSquare className="w-3 h-3" />{item.commentCount ?? 0}
          </span>
        </button>
      </div>

      {(prev || next) && (
        <div className="flex gap-1.5 pt-1">
          {prev && (
            <button onClick={() => onMove(item.id, prev.key)} data-testid={`button-sysboard-prev-${item.id}`}
              className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold px-2 py-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition">
              <ChevronLeft className="w-3.5 h-3.5" /> {prev.label}
            </button>
          )}
          {next && (
            <button onClick={() => onMove(item.id, next.key)} data-testid={`button-sysboard-next-${item.id}`}
              className={`flex-1 flex items-center justify-center gap-1 text-xs font-semibold px-2 py-2 rounded-lg transition ${
                next.key === "concluido" ? "bg-green-600 text-white hover:bg-green-700" : "bg-primary text-white hover:opacity-90"
              }`}>
              {next.label} <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Quadro interno de desenvolvimento do sheikcell-crm: problemas, atualizações
// e implementações do próprio sistema, com responsável e prazo. Pensado para
// o admin coordenar a equipe de programação (ex.: os devs adicionados no GitHub).
export default function SystemBoard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<SystemBoardItem[]>([]);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<SystemBoardItem | null>(null);
  const [form, setForm] = useState<ItemFormData>(emptyForm);
  const [filterType, setFilterType] = useState("");
  const [filterResponsible, setFilterResponsible] = useState("");
  const [detailItem, setDetailItem] = useState<SystemBoardItem | null>(null);
  const [comments, setComments] = useState<SystemBoardComment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);

  const fetchItems = useCallback(async () => {
    try {
      const data = await api.systemBoard.list();
      setItems(data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchItems();
    api.chatUsers().then(setTeam).catch(() => {});
  }, [fetchItems]);

  const openAdd = () => {
    setEditTarget(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (t: SystemBoardItem) => {
    setEditTarget(t);
    setForm({
      type: t.type,
      title: t.title,
      description: t.description ?? "",
      status: t.status,
      priority: t.priority,
      responsibleId: t.responsibleId ? String(t.responsibleId) : "",
      dueDate: t.dueDate ? t.dueDate.slice(0, 10) : "",
    });
    setShowForm(true);
  };

  const openDetail = async (t: SystemBoardItem) => {
    setDetailItem(t);
    setComments([]);
    setNewComment("");
    try {
      const coms = await api.systemBoard.comments(t.id);
      setDetailItem((current) => {
        if (current?.id === t.id) setComments(coms);
        return current;
      });
    } catch { /* modal fica vazio; usuário pode reabrir */ }
  };

  const bumpCommentCount = (itemId: number, delta: number) => {
    setItems((prev) => prev.map((t) => t.id === itemId ? { ...t, commentCount: (t.commentCount ?? 0) + delta } : t));
  };

  const addComment = async () => {
    if (!detailItem || !newComment.trim() || sendingComment) return;
    setSendingComment(true);
    try {
      const c = await api.systemBoard.addComment(detailItem.id, newComment.trim());
      setComments((prev) => [...prev, c]);
      setNewComment("");
      bumpCommentCount(detailItem.id, 1);
    } catch { toast({ title: "Erro ao comentar", variant: "destructive" }); }
    finally { setSendingComment(false); }
  };

  const handleMove = async (id: number, status: SystemBoardStatus) => {
    setItems((prev) => prev.map((t) => t.id === id ? { ...t, status } : t));
    try {
      await api.systemBoard.update(id, { status });
    } catch (err) {
      toast({ title: "Erro ao mover item", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      fetchItems();
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.systemBoard.remove(id);
      setItems((prev) => prev.filter((t) => t.id !== id));
      toast({ title: "Item excluído" });
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) { toast({ title: "Título é obrigatório", variant: "destructive" }); return; }
    const payload = {
      type: form.type,
      title: form.title.trim(),
      description: form.description || undefined,
      status: form.status,
      priority: form.priority,
      responsibleId: form.responsibleId ? Number(form.responsibleId) : null,
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
    };
    try {
      if (editTarget) {
        const updated = await api.systemBoard.update(editTarget.id, payload);
        setItems((prev) => prev.map((t) => t.id === editTarget.id ? updated : t));
        toast({ title: "Item atualizado!" });
      } else {
        const created = await api.systemBoard.create(payload);
        setItems((prev) => [created, ...prev]);
        toast({ title: "Item criado!" });
      }
      setShowForm(false);
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const PRIORITY_ORDER: Record<string, number> = { alta: 0, media: 1, baixa: 2 };
  const visibleItems = items.filter((t) =>
    (!filterType || t.type === filterType) &&
    (!filterResponsible || String(t.responsibleId ?? "") === filterResponsible));
  const byStatus = (status: SystemBoardStatus) => visibleItems
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
            <Wrench className="w-5 h-5 text-primary" /> Sistema (Dev)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Problemas, atualizações e implementações do próprio sheikcell-crm — com responsável e prazo</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
            data-testid="filter-sysboard-type"
            className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
            <option value="">Todos os tipos</option>
            {(Object.keys(TYPE_META) as SystemBoardType[]).map((k) => <option key={k} value={k}>{TYPE_META[k].label}</option>)}
          </select>
          <select value={filterResponsible} onChange={(e) => setFilterResponsible(e.target.value)}
            data-testid="filter-sysboard-responsible"
            className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
            <option value="">Todos os responsáveis</option>
            {team.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
          </select>
          <button onClick={fetchItems}
            className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={openAdd} data-testid="button-sysboard-add"
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
            <Plus className="w-3.5 h-3.5" /> Novo Item
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total", value: visibleItems.length, color: "text-foreground" },
          { label: "Aberto", value: byStatus("aberto").length, color: "text-slate-600" },
          { label: "Em Andamento", value: byStatus("andamento").length, color: "text-blue-600" },
          { label: "Concluídos", value: byStatus("concluido").length, color: "text-green-600" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-border p-3 text-center">
            <p className={`text-lg font-bold ${color}`}>{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* Kanban */}
      <div className="grid gap-4 items-start grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {COLUMNS.map((col, colIdx) => {
          const cards = byStatus(col.key);
          return (
            <div key={col.key} className={`rounded-2xl ${col.light} border ${col.border} p-4`} data-testid={`sysboard-col-${col.key}`}>
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
                    <p>Nada aqui</p>
                    <button onClick={openAdd} className={`mt-2 ${col.text} font-semibold underline underline-offset-2`}>
                      Adicionar
                    </button>
                  </div>
                ) : (
                  cards.map((t) => (
                    <ItemCard
                      key={t.id} item={t} onMove={handleMove}
                      onEdit={openEdit} onDelete={handleDelete}
                      colIdx={colIdx}
                      onOpenDetail={openDetail}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detalhe: chat de comentários */}
      {detailItem && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDetailItem(null)}>
          <div className="shk-card w-full max-w-md p-5 max-h-[90vh] overflow-y-auto space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-bold text-sm break-words">{detailItem.title}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {detailItem.responsible ? `Responsável: ${detailItem.responsible.name}` : "Sem responsável"}
                  {detailItem.dueDate ? ` · Prazo: ${fmtDate(detailItem.dueDate)}` : ""}
                </p>
              </div>
              <button onClick={() => setDetailItem(null)}><X className="w-5 h-5 text-muted-foreground shrink-0" /></button>
            </div>

            <div className="border-t border-border pt-3">
              <div className="flex items-center gap-1.5 mb-2">
                <MessageSquare className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-bold">Comentários</span>
              </div>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {comments.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-3">Nenhum comentário. Registre o andamento ou tire dúvidas aqui.</p>
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
                  placeholder="Escreva um comentário..." data-testid="input-sysboard-comment"
                  className="flex-1 px-3 py-1.5 rounded-xl border border-border text-xs" />
                <button onClick={addComment} disabled={!newComment.trim() || sendingComment} data-testid="button-sysboard-comment-send"
                  className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-40">
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editTarget ? "Editar Item" : "Novo Item"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Tipo</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as SystemBoardType })}
                  data-testid="select-sysboard-type"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  {(Object.keys(TYPE_META) as SystemBoardType[]).map((k) => <option key={k} value={k}>{TYPE_META[k].label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Título *</label>
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Ex: Corrigir erro ao salvar tarefa" data-testid="input-sysboard-title"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Descrição</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Detalhes do problema/atualização/implementação..." rows={3}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Coluna</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SystemBoardStatus })}
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
                <select value={form.responsibleId} onChange={(e) => setForm({ ...form, responsibleId: e.target.value })}
                  data-testid="select-sysboard-responsible"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  <option value="">— Sem responsável —</option>
                  {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
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
                <button type="submit" data-testid="button-sysboard-save"
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
