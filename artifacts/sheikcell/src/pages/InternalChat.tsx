import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, type InternalConversation, type InternalMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Users, Send, Plus, X, Search, MessagesSquare } from "lucide-react";

const roleLabel: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  vendedor: "Vendedor",
  attendant: "Vendedor",
};

function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export default function InternalChat() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<InternalConversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [colleagues, setColleagues] = useState<{ id: number; name: string; role: string }[]>([]);
  const [colleagueSearch, setColleagueSearch] = useState("");

  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  const loadConversations = useCallback(async () => {
    try {
      const list = await api.internalChat.conversations();
      setConversations(list);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load messages when active conversation changes.
  useEffect(() => {
    if (activeId == null) { setMessages([]); return; }
    let cancelled = false;
    api.internalChat.messages(activeId).then((msgs) => {
      if (!cancelled) setMessages(msgs);
    }).catch(() => {});
    // Optimistically clear unread badge for this conversation.
    setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, unreadCount: 0 } : c)));
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Real-time updates.
  useEffect(() => {
    const es = new EventSource("/api/internal-chat/events", { withCredentials: true });
    es.addEventListener("internal_message", (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as {
        conversationId: number;
        kind: "direct" | "general";
        message: InternalMessage;
      };
      const isActive = activeIdRef.current === payload.conversationId;
      if (isActive) {
        setMessages((prev) => (prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message]));
        if (payload.message.senderId !== user?.id) {
          api.internalChat.markRead(payload.conversationId).catch(() => {});
        }
      }
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === payload.conversationId);
        if (!exists) {
          // A new conversation directed at us — refetch to get full metadata.
          loadConversations();
          return prev;
        }
        return prev.map((c) => {
          if (c.id !== payload.conversationId) return c;
          const bumpUnread = !isActive && payload.message.senderId !== user?.id;
          return {
            ...c,
            lastMessage: payload.message.content,
            lastMessageAt: payload.message.createdAt,
            unreadCount: bumpUnread ? c.unreadCount + 1 : c.unreadCount,
          };
        });
      });
    });
    return () => es.close();
  }, [user?.id, loadConversations]);

  const openNew = async () => {
    setShowNew(true);
    try {
      const users = await api.chatUsers();
      setColleagues(users.filter((u) => u.id !== user?.id));
    } catch {
      /* ignore */
    }
  };

  const startDirect = async (userId: number) => {
    try {
      const conv = await api.internalChat.startDirect(userId);
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]));
      setActiveId(conv.id);
      setShowNew(false);
      setColleagueSearch("");
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Falha ao iniciar conversa", variant: "destructive" });
    }
  };

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || activeId == null || sending) return;
    setSending(true);
    setDraft("");
    try {
      const msg = await api.internalChat.send(activeId, content);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, lastMessage: msg.content, lastMessageAt: msg.createdAt } : c)));
    } catch (err) {
      setDraft(content);
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Falha ao enviar", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const filteredColleagues = colleagues.filter((c) => c.name.toLowerCase().includes(colleagueSearch.toLowerCase()));

  return (
    <div className="max-w-6xl mx-auto px-4 py-4">
      <div className="relative flex h-[calc(100vh-180px)] min-h-[480px] rounded-xl border bg-card overflow-hidden shadow-sm">
        {/* Conversation list */}
        <aside className="w-72 shrink-0 border-r flex flex-col bg-muted/20">
          <div className="p-3 border-b flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <MessagesSquare className="w-4 h-4 text-primary" /> Chat Interno
            </div>
            <button
              onClick={openNew}
              data-testid="button-new-internal-chat"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:bg-primary/10 rounded-md px-2 py-1"
            >
              <Plus className="w-3.5 h-3.5" /> Novo
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">Nenhuma conversa ainda.</div>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                data-testid={`internal-conv-${c.id}`}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 border-b border-border/50 transition-colors ${
                  activeId === c.id ? "bg-primary/10" : "hover:bg-muted/50"
                }`}
              >
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                  c.kind === "general" ? "bg-amber-500 text-white" : "bg-primary text-white"
                }`}>
                  {c.kind === "general" ? <Users className="w-4 h-4" /> : initials(c.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeLabel(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs text-muted-foreground truncate">{c.lastMessage ?? (c.kind === "general" ? "Sala da equipe" : "Iniciar conversa")}</span>
                    {c.unreadCount > 0 && (
                      <span className="shrink-0 bg-primary text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                        {c.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Message thread */}
        <section className="flex-1 flex flex-col min-w-0">
          {active ? (
            <>
              <header className="px-4 py-3 border-b flex items-center gap-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold ${
                  active.kind === "general" ? "bg-amber-500 text-white" : "bg-primary text-white"
                }`}>
                  {active.kind === "general" ? <Users className="w-4 h-4" /> : initials(active.name)}
                </div>
                <div>
                  <div className="font-semibold text-sm">{active.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {active.kind === "general" ? "Todos os membros da equipe" : (active.otherUser ? roleLabel[active.otherUser.role] ?? active.otherUser.role : "")}
                  </div>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-muted/10">
                {messages.length === 0 && (
                  <div className="text-center text-xs text-muted-foreground py-8">Nenhuma mensagem. Diga olá! 👋</div>
                )}
                {messages.map((m) => {
                  const mine = m.senderId === user?.id;
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                        mine ? "bg-primary text-white rounded-br-sm" : "bg-card border rounded-bl-sm"
                      }`}>
                        {!mine && active.kind === "general" && (
                          <div className="text-[11px] font-semibold text-primary mb-0.5">{m.senderName}</div>
                        )}
                        <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
                        <div className={`text-[10px] mt-0.5 text-right ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                          {timeLabel(m.createdAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              <div className="p-3 border-t flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
                  }}
                  placeholder="Escreva uma mensagem..."
                  rows={1}
                  data-testid="input-internal-message"
                  className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm max-h-32 focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <button
                  onClick={handleSend}
                  disabled={!draft.trim() || sending}
                  data-testid="button-send-internal"
                  className="shrink-0 w-10 h-10 rounded-lg bg-primary text-white flex items-center justify-center disabled:opacity-40 hover:bg-primary/90"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 text-muted-foreground">
              <MessagesSquare className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">Selecione uma conversa ou inicie uma nova para conversar com a equipe.</p>
            </div>
          )}
        </section>

        {/* New conversation modal */}
        {showNew && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNew(false)}>
            <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <span className="font-semibold text-sm">Nova conversa</span>
                <button onClick={() => setShowNew(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-3 border-b">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={colleagueSearch}
                    onChange={(e) => setColleagueSearch(e.target.value)}
                    placeholder="Buscar colega..."
                    className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {filteredColleagues.length === 0 && (
                  <div className="p-4 text-center text-xs text-muted-foreground">Nenhum colega encontrado.</div>
                )}
                {filteredColleagues.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => startDirect(c.id)}
                    data-testid={`start-chat-${c.id}`}
                    className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-muted/50 border-b border-border/50"
                  >
                    <div className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-xs font-semibold">
                      {initials(c.name)}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{roleLabel[c.role] ?? c.role}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
