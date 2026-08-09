import { useState, useEffect, useRef, useCallback } from "react";
import { api, type SaasTicket, type TicketMessage, type TicketCategory, type TicketPriority } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { LifeBuoy, Plus, X, ChevronLeft, Send, Paperclip, Bug, HelpCircle, Sparkles } from "lucide-react";

// Suporte técnico: a loja abre chamados (bug, dúvida, melhoria) e conversa
// com quem está atendendo (superadmin/técnico) numa timeline própria — não
// se mistura com WhatsApp/chat interno. Só o técnico muda o status; aqui a
// loja acompanha e responde.

const CATEGORY_META: Record<TicketCategory, { label: string; icon: typeof Bug }> = {
  bug: { label: "Bug", icon: Bug },
  duvida: { label: "Dúvida", icon: HelpCircle },
  melhoria: { label: "Melhoria", icon: Sparkles },
};

const STATUS_META: Record<SaasTicket["status"], { label: string; className: string }> = {
  aberto: { label: "Aberto", className: "bg-blue-50 text-blue-700 border-blue-200" },
  em_analise: { label: "Em análise", className: "bg-violet-50 text-violet-700 border-violet-200" },
  em_andamento: { label: "Em andamento", className: "bg-amber-50 text-amber-700 border-amber-200" },
  resolvido: { label: "Resolvido", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  fechado: { label: "Fechado", className: "bg-gray-100 text-gray-600 border-gray-200" },
};

const PRIORITY_META: Record<TicketPriority, { label: string; className: string }> = {
  baixa: { label: "Baixa", className: "text-gray-500" },
  normal: { label: "Normal", className: "text-blue-600" },
  alta: { label: "Alta", className: "text-amber-600" },
  urgente: { label: "Urgente", className: "text-red-600 font-bold" },
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function Suporte() {
  const { toast } = useToast();
  const [tickets, setTickets] = useState<SaasTicket[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [active, setActive] = useState<SaasTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);

  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newCategory, setNewCategory] = useState<TicketCategory>("duvida");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);

  const [reply, setReply] = useState("");
  const [replyFile, setReplyFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const msgsEndRef = useRef<HTMLDivElement>(null);

  const loadTickets = useCallback(() => {
    api.tickets.list().then((r) => setTickets(r.tickets)).catch(() => setTickets([]));
  }, []);
  useEffect(loadTickets, [loadTickets]);

  const loadThread = useCallback(() => {
    if (activeId == null) return;
    api.tickets.messages(activeId).then((r) => { setActive(r.ticket); setMessages(r.messages); }).catch(() => {});
  }, [activeId]);
  useEffect(loadThread, [loadThread]);

  // Polling enquanto um chamado está aberto na tela, pra ver a resposta do
  // técnico sem precisar recarregar a página.
  useEffect(() => {
    if (activeId == null) return;
    const t = setInterval(loadThread, 10000);
    return () => clearInterval(t);
  }, [activeId, loadThread]);

  useEffect(() => { msgsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const openNew = () => { setNewTitle(""); setNewDescription(""); setNewCategory("duvida"); setNewFile(null); setShowNew(true); };

  const handleCreate = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      await api.tickets.create({ title: newTitle.trim(), description: newDescription.trim() || undefined, category: newCategory }, newFile ?? undefined);
      toast({ title: "Chamado aberto!" });
      setShowNew(false);
      loadTickets();
    } catch (err) {
      toast({ title: "Erro ao abrir chamado", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const handleReply = async () => {
    if (activeId == null || (!reply.trim() && !replyFile) || sending) return;
    setSending(true);
    try {
      await api.tickets.reply(activeId, reply.trim(), replyFile ?? undefined);
      setReply(""); setReplyFile(null);
      loadThread();
    } catch (err) {
      toast({ title: "Erro ao responder", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  if (activeId != null && active) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="shk-card overflow-hidden flex flex-col h-[calc(100vh-11rem)]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
            <button onClick={() => { setActiveId(null); setActive(null); setMessages([]); }} data-testid="button-ticket-back"
              className="p-1 -ml-1 rounded-md hover:bg-secondary shrink-0">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{active.title}</p>
              <p className="text-[11px] text-muted-foreground">Aberto em {fmtDateTime(active.createdAt)}</p>
            </div>
            <span className={`text-[11px] font-semibold px-2 py-1 rounded-full border shrink-0 ${STATUS_META[active.status].className}`}>
              {STATUS_META[active.status].label}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-secondary/10">
            {messages.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">Nenhuma mensagem ainda.</p>
            ) : messages.map((m) => (
              <div key={m.id} className={`flex ${m.authorType === "tenant" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${m.authorType === "tenant" ? "bg-primary text-primary-foreground" : "bg-white border border-border"}`}>
                  {m.authorType === "superadmin" && <p className="text-[11px] font-semibold mb-0.5 opacity-70">{m.authorName}</p>}
                  {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
                  {m.mediaUrl && (
                    m.mediaType?.startsWith("image/") ? (
                      <img src={m.mediaUrl} alt="Anexo" className="mt-1 rounded-lg max-w-full max-h-64 object-contain" />
                    ) : m.mediaType?.startsWith("video/") ? (
                      <video src={m.mediaUrl} controls className="mt-1 rounded-lg max-w-full max-h-64" />
                    ) : (
                      <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="mt-1 text-xs underline block">📎 Ver anexo</a>
                    )
                  )}
                  <p className={`text-[10px] mt-1 ${m.authorType === "tenant" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{fmtDateTime(m.createdAt)}</p>
                </div>
              </div>
            ))}
            <div ref={msgsEndRef} />
          </div>

          <div className="border-t border-border p-3 shrink-0">
            {replyFile && (
              <div className="flex items-center gap-2 mb-2 text-xs bg-secondary rounded-lg px-2 py-1">
                <Paperclip className="w-3 h-3 shrink-0" /> <span className="truncate flex-1">{replyFile.name}</span>
                <button onClick={() => setReplyFile(null)}><X className="w-3 h-3" /></button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input ref={fileInputRef} type="file" accept="image/*,video/*,.pdf" className="hidden"
                onChange={(e) => setReplyFile(e.target.files?.[0] ?? null)} />
              <button onClick={() => fileInputRef.current?.click()} data-testid="button-ticket-attach"
                className="p-2 rounded-full hover:bg-secondary text-muted-foreground shrink-0">
                <Paperclip className="w-4 h-4" />
              </button>
              <input value={reply} onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleReply(); }}
                placeholder="Responder..." data-testid="input-ticket-reply"
                className="flex-1 text-sm bg-secondary/50 rounded-full px-3 py-2 outline-none" />
              <button onClick={handleReply} disabled={(!reply.trim() && !replyFile) || sending} data-testid="button-ticket-send"
                className="p-2 rounded-full bg-primary text-primary-foreground disabled:opacity-40 shrink-0">
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-bold text-foreground flex items-center gap-2"><LifeBuoy className="w-5 h-5 text-primary" /> Suporte técnico</h2>
        <button onClick={openNew} data-testid="button-new-ticket"
          className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-1.5 hover:bg-primary/90">
          <Plus className="w-4 h-4" /> Novo chamado
        </button>
      </div>

      {!tickets ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Carregando...</div>
      ) : tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <LifeBuoy className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-sm">Nenhum chamado aberto ainda.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tickets.map((tk) => {
            const CategoryIcon = CATEGORY_META[tk.category].icon;
            return (
              <button key={tk.id} onClick={() => setActiveId(tk.id)} data-testid={`ticket-card-${tk.id}`}
                className="shk-card p-4 text-left hover:bg-secondary/20 transition">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_META[tk.status].className}`}>
                    {STATUS_META[tk.status].label}
                  </span>
                  <span className={`text-[11px] font-medium ${PRIORITY_META[tk.priority].className}`}>{PRIORITY_META[tk.priority].label}</span>
                </div>
                <p className="font-semibold text-sm text-foreground truncate">{tk.title}</p>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1">
                  <CategoryIcon className="w-3 h-3" /> {CATEGORY_META[tk.category].label} · {fmtDateTime(tk.createdAt)}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowNew(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-base">Novo chamado</h3>
              <button onClick={() => setShowNew(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">Tipo</label>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(CATEGORY_META) as TicketCategory[]).map((cat) => {
                  const Icon = CATEGORY_META[cat].icon;
                  return (
                    <button key={cat} type="button" onClick={() => setNewCategory(cat)} data-testid={`button-category-${cat}`}
                      className={`flex flex-col items-center gap-1 py-2 rounded-xl border text-xs font-medium transition ${
                        newCategory === cat ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary"
                      }`}>
                      <Icon className="w-4 h-4" /> {CATEGORY_META[cat].label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">Título *</label>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={120}
                placeholder="Resuma em poucas palavras" data-testid="input-new-ticket-title"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/20" />
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">Descrição</label>
              <textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)} rows={4} maxLength={4000}
                placeholder="Explique o que está acontecendo, passos pra reproduzir, etc." data-testid="input-new-ticket-description"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none resize-none focus:ring-2 focus:ring-primary/20" />
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">Anexo (print ou vídeo, opcional)</label>
              {newFile ? (
                <div className="flex items-center gap-2 text-xs bg-secondary rounded-lg px-3 py-2">
                  <Paperclip className="w-3.5 h-3.5 shrink-0" /> <span className="truncate flex-1">{newFile.name}</span>
                  <button onClick={() => setNewFile(null)}><X className="w-3.5 h-3.5" /></button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 text-xs text-muted-foreground border border-dashed border-border rounded-xl py-3 cursor-pointer hover:bg-secondary/50">
                  <Paperclip className="w-4 h-4" /> Escolher arquivo
                  <input type="file" accept="image/*,video/*,.pdf" className="hidden" data-testid="input-new-ticket-attachment"
                    onChange={(e) => setNewFile(e.target.files?.[0] ?? null)} />
                </label>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setShowNew(false)}
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">Cancelar</button>
              <button type="button" onClick={handleCreate} disabled={!newTitle.trim() || creating} data-testid="button-confirm-new-ticket"
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
                {creating ? "Abrindo..." : "Abrir chamado"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
