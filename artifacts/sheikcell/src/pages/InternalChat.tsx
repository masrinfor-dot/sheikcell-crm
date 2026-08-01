import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, can, type InternalConversation, type InternalMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Users, Send, Plus, X, Search, MessagesSquare, ChevronLeft, SquareKanban, ClipboardPlus, Trash2 } from "lucide-react";
import TaskBoard from "./TaskBoard";

const roleLabel: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  vendedor: "Vendedor",
  attendant: "Vendedor",
};

function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

// Destaca @menções no texto da mensagem. Recebe os nomes conhecidos da equipe
// e realça `@Nome` (menção a você fica mais forte para chamar atenção).
function renderWithMentions(content: string, names: string[], myName: string | undefined, mine: boolean) {
  if (names.length === 0 || !content.includes("@")) return content;
  const escaped = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Fronteira no fim: evita realçar só "Ana" dentro de "@Anabela".
  const re = new RegExp(`@(${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const parts: (string | { name: string })[] = [];
  let last = 0;
  for (const m of content.matchAll(re)) {
    if (m.index! > last) parts.push(content.slice(last, m.index));
    parts.push({ name: m[1] });
    last = m.index! + m[0].length;
  }
  if (parts.length === 0) return content;
  if (last < content.length) parts.push(content.slice(last));
  return parts.map((p, i) => {
    if (typeof p === "string") return <span key={i}>{p}</span>;
    const isMe = myName && p.name.toLowerCase() === myName.toLowerCase();
    return (
      <span key={i} className={`font-semibold rounded px-1 ${
        isMe ? "bg-amber-200 text-amber-900" : mine ? "bg-white/25 text-white" : "bg-primary/10 text-primary"
      }`}>@{p.name}</span>
    );
  });
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export default function InternalChat({ docked = false }: { docked?: boolean } = {}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<InternalConversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<InternalMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showNew, setShowNew] = useState(false);
  // Aba interna: conversas da equipe ou o quadro de tarefas (kanban).
  const [view, setView] = useState<"chat" | "tasks">("chat");
  const [colleagues, setColleagues] = useState<{ id: number; name: string; role: string }[]>([]);
  const [colleagueSearch, setColleagueSearch] = useState("");
  // Criação de grupo: modo do modal "Novo", nome e participantes escolhidos.
  const [newMode, setNewMode] = useState<"direct" | "group">("direct");
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<number[]>([]);
  const [creatingGroup, setCreatingGroup] = useState(false);
  // @menção: sugestões enquanto digita "@..." no composer.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // Criar tarefa a partir de uma mensagem do chat (vínculo com o quadro).
  const [taskFromMsg, setTaskFromMsg] = useState<InternalMessage | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState<string>("");
  const [taskDue, setTaskDue] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);

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

  // Equipe carregada já na abertura: usada nas @menções e no "criar tarefa".
  useEffect(() => {
    api.chatUsers().then((users) => setColleagues(users.filter((u) => u.id !== user?.id))).catch(() => {});
  }, [user?.id]);

  // After a reconnection, the client's per-conversation unread counters may
  // have drifted (replay bumps them +1 per message, which is only approximate).
  // Refetch the authoritative counts from the server so every badge matches the
  // backend exactly. The conversation currently open is being read now, so force
  // its badge to 0 to avoid a transient ghost while the server mark-read (via
  // the messages refetch below) catches up.
  const reconcileAfterReconnect = useCallback(async () => {
    const openId = activeIdRef.current;
    try {
      const list = await api.internalChat.conversations();
      setConversations(openId != null ? list.map((c) => (c.id === openId ? { ...c, unreadCount: 0 } : c)) : list);
    } catch {
      /* ignore */
    }
    if (openId != null) {
      api.internalChat.messages(openId).then((msgs) => {
        if (activeIdRef.current === openId) setMessages(msgs);
      }).catch(() => {});
    }
  }, []);

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
    // When the reconnection gap is larger than the server's replay buffer (or
    // the server restarted), the server asks the client to resync. Reconcile the
    // conversation list (authoritative unread counts) and the open conversation's
    // messages so nothing sent during the outage is lost.
    // Novo grupo criado por um colega: aparece na lista em tempo real.
    es.addEventListener("internal_conversation_new", (e) => {
      const conv = JSON.parse((e as MessageEvent).data) as InternalConversation;
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [...prev, conv]));
    });
    // Grupo excluído por um admin/supervisor: some da lista de todos na hora.
    es.addEventListener("internal_conversation_removed", (e) => {
      const { id } = JSON.parse((e as MessageEvent).data) as { id: number };
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    });
    es.addEventListener("resync", () => {
      reconcileAfterReconnect();
    });
    // After a within-buffer reconnect, the server replays missed messages (which
    // flow through the handler above and bump unread counters approximately) and
    // then emits this sentinel. Reconcile so the badges match the backend exactly.
    es.addEventListener("internal_reconnect", () => {
      reconcileAfterReconnect();
    });
    return () => es.close();
  }, [user?.id, loadConversations, reconcileAfterReconnect]);

  const openNew = async () => {
    setShowNew(true);
    setNewMode("direct");
    setGroupName("");
    setGroupMembers([]);
  };

  // Abre o modal "criar tarefa" preenchido com a mensagem; se ela menciona
  // alguém (@Nome), já sugere esse colega como responsável.
  const teamNames = [...colleagues.map((c) => c.name), ...(user?.name ? [user.name] : [])];
  const openTaskFromMsg = (m: InternalMessage) => {
    setTaskFromMsg(m);
    setTaskTitle(m.content.length > 80 ? `${m.content.slice(0, 77)}...` : m.content);
    const mentioned = colleagues.find((c) => m.content.toLowerCase().includes(`@${c.name.toLowerCase()}`));
    setTaskAssignee(mentioned ? String(mentioned.id) : "");
    setTaskDue("");
  };

  const createTaskFromMsg = async () => {
    if (!taskFromMsg || creatingTask) return;
    const title = taskTitle.trim();
    if (!title) { toast({ title: "Dê um título à tarefa", variant: "destructive" }); return; }
    setCreatingTask(true);
    try {
      await api.tasks.create({
        title,
        description: `Criada a partir do chat interno — mensagem de ${taskFromMsg.senderName} em ${new Date(taskFromMsg.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}:\n\n"${taskFromMsg.content}"`,
        assigneeId: taskAssignee ? Number(taskAssignee) : null,
        dueDate: taskDue || null,
      });
      setTaskFromMsg(null);
      toast({ title: "Tarefa criada no quadro! 📋" });
    } catch (err) {
      toast({ title: "Erro ao criar tarefa", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setCreatingTask(false);
    }
  };

  // @menção: procura um "@texto" logo antes do fim do rascunho.
  const updateMentionState = (value: string) => {
    const m = /(?:^|\s)@([\p{L}\p{N} ]{0,30})$/u.exec(value);
    setMentionQuery(m ? m[1] : null);
  };
  const mentionOptions = mentionQuery != null
    ? colleagues.filter((c) => c.name.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6)
    : [];
  const insertMention = (name: string) => {
    setDraft((prev) => prev.replace(/@[\p{L}\p{N} ]{0,30}$/u, `@${name} `));
    setMentionQuery(null);
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

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name) { toast({ title: "Dê um nome ao grupo", variant: "destructive" }); return; }
    if (groupMembers.length === 0) { toast({ title: "Escolha pelo menos um participante", variant: "destructive" }); return; }
    setCreatingGroup(true);
    try {
      const conv = await api.internalChat.createGroup(name, groupMembers);
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]));
      setActiveId(conv.id);
      setShowNew(false);
      setColleagueSearch("");
      toast({ title: `Grupo "${name}" criado! 🎉` });
    } catch (err) {
      toast({ title: "Erro ao criar grupo", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || activeId == null || sending) return;
    setSending(true);
    setDraft("");
    setMentionQuery(null);
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

  const listPanel = (
    <>
          <div className="p-3 border-b flex items-center justify-between gap-2 shrink-0">
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
                  c.kind === "general" ? "bg-amber-500 text-white" : c.kind === "group" ? "bg-violet-500 text-white" : "bg-primary text-white"
                }`}>
                  {c.kind !== "direct" ? <Users className="w-4 h-4" /> : initials(c.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeLabel(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs text-muted-foreground truncate">{c.lastMessage ?? (c.kind === "general" ? "Sala da equipe" : c.kind === "group" ? "Grupo da equipe" : "Iniciar conversa")}</span>
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
    </>
  );

  const threadPanel = active ? (
            <>
              <header className="px-4 py-3 border-b flex items-center gap-3 shrink-0">
                <button
                  onClick={() => setActiveId(null)}
                  data-testid="button-back-internal"
                  className={`p-1 -ml-1 rounded-md hover:bg-muted/50 shrink-0 ${docked ? "" : "md:hidden"}`}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold ${
                  active.kind === "general" ? "bg-amber-500 text-white" : active.kind === "group" ? "bg-violet-500 text-white" : "bg-primary text-white"
                }`}>
                  {active.kind !== "direct" ? <Users className="w-4 h-4" /> : initials(active.name)}
                </div>
                <div>
                  <div className="font-semibold text-sm">{active.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {active.kind === "general" ? "Todos os membros da equipe"
                      : active.kind === "group" ? `Você${active.memberNames && active.memberNames.length > 0 ? ", " + active.memberNames.join(", ") : ""}`
                      : (active.otherUser ? roleLabel[active.otherUser.role] ?? active.otherUser.role : "")}
                  </div>
                </div>
                {active.kind === "group" && user?.role === "admin" && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Excluir o grupo "${active.name}"? Todas as mensagens dele serão apagadas para todos.`)) return;
                      try {
                        await api.internalChat.deleteGroup(active.id);
                        setConversations((prev) => prev.filter((c) => c.id !== active.id));
                        setActiveId(null);
                      } catch (err) {
                        alert(err instanceof Error ? err.message : "Erro ao excluir grupo");
                      }
                    }}
                    data-testid="button-delete-group"
                    title="Excluir grupo"
                    className="ml-auto p-2 rounded-lg text-red-600 hover:bg-red-50 transition shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </header>

              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-muted/10">
                {messages.length === 0 && (
                  <div className="text-center text-xs text-muted-foreground py-8">Nenhuma mensagem. Diga olá! 👋</div>
                )}
                {messages.map((m) => {
                  const mine = m.senderId === user?.id;
                  return (
                    <div key={m.id} className={`group flex items-center gap-1 ${mine ? "justify-end" : "justify-start"}`}>
                      {mine && can(user, "tarefas") && (
                        <button
                          onClick={() => openTaskFromMsg(m)}
                          data-testid={`button-task-from-msg-${m.id}`}
                          title="Criar tarefa desta mensagem"
                          className="opacity-0 group-hover:opacity-100 transition p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 shrink-0"
                        >
                          <ClipboardPlus className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                        mine ? "bg-primary text-white rounded-br-sm" : "bg-card border rounded-bl-sm"
                      }`}>
                        {!mine && active.kind !== "direct" && (
                          <div className="text-[11px] font-semibold text-primary mb-0.5">{m.senderName}</div>
                        )}
                        <div className="text-sm whitespace-pre-wrap break-words">{renderWithMentions(m.content, teamNames, user?.name, mine)}</div>
                        <div className={`text-[10px] mt-0.5 text-right ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                          {timeLabel(m.createdAt)}
                        </div>
                      </div>
                      {!mine && can(user, "tarefas") && (
                        <button
                          onClick={() => openTaskFromMsg(m)}
                          data-testid={`button-task-from-msg-${m.id}`}
                          title="Criar tarefa desta mensagem"
                          className="opacity-0 group-hover:opacity-100 transition p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 shrink-0"
                        >
                          <ClipboardPlus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              <div className="relative p-3 border-t flex items-end gap-2 shrink-0">
                {/* Sugestões de @menção */}
                {mentionOptions.length > 0 && (
                  <div className="absolute bottom-full left-3 mb-1 z-30 bg-card border rounded-xl shadow-lg overflow-hidden min-w-[200px]" data-testid="mention-suggestions">
                    {mentionOptions.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => insertMention(c.name)}
                        data-testid={`mention-option-${c.id}`}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-primary/10 transition"
                      >
                        <span className="w-6 h-6 rounded-full bg-primary text-white text-[10px] font-semibold flex items-center justify-center shrink-0">{initials(c.name)}</span>
                        <span className="text-sm font-medium truncate">{c.name}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{roleLabel[c.role] ?? c.role}</span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); updateMentionState(e.target.value); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (mentionOptions.length > 0) { insertMention(mentionOptions[0].name); return; }
                      handleSend();
                    }
                    if (e.key === "Escape") setMentionQuery(null);
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
  );

  // Modal: criar tarefa no quadro a partir de uma mensagem do chat.
  const taskModal = taskFromMsg && (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setTaskFromMsg(null)}>
      <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border overflow-hidden mx-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm flex items-center gap-2"><ClipboardPlus className="w-4 h-4 text-primary" /> Criar tarefa desta mensagem</span>
          <button onClick={() => setTaskFromMsg(null)} data-testid="button-close-task-modal" className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs bg-muted/40 border rounded-lg px-3 py-2 text-muted-foreground line-clamp-3">
            "{taskFromMsg.content}" — {taskFromMsg.senderName}
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Título da tarefa</label>
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} data-testid="input-task-title"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Responsável</label>
            <select value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)} data-testid="select-task-assignee"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
              <option value="">Sem responsável</option>
              {user && <option value={String(user.id)}>Eu ({user.name})</option>}
              {colleagues.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Prazo (opcional)</label>
            <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} data-testid="input-task-due"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
          </div>
          <button onClick={createTaskFromMsg} disabled={creatingTask} data-testid="button-create-task-from-msg"
            className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
            {creatingTask ? "Criando..." : "Criar tarefa no quadro"}
          </button>
        </div>
      </div>
    </div>
  );

  const newModal = showNew && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNew(false)}>
            <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <span className="font-semibold text-sm">Nova conversa</span>
                <button onClick={() => setShowNew(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {/* Conversa direta ou grupo */}
              <div className="flex gap-1 p-2 border-b">
                <button onClick={() => setNewMode("direct")} data-testid="tab-new-direct"
                  className={`flex-1 text-xs font-semibold rounded-lg px-3 py-2 transition ${newMode === "direct" ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted/60"}`}>
                  Conversa
                </button>
                {user?.role === "admin" && (
                  <button onClick={() => setNewMode("group")} data-testid="tab-new-group"
                    className={`flex-1 text-xs font-semibold rounded-lg px-3 py-2 transition ${newMode === "group" ? "bg-violet-600 text-white" : "text-muted-foreground hover:bg-muted/60"}`}>
                    <Users className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />Grupo
                  </button>
                )}
              </div>
              {newMode === "group" && (
                <div className="p-3 border-b">
                  <input
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="Nome do grupo (ex.: Vendas Loja 1)"
                    data-testid="input-group-name"
                    className="w-full px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              )}
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
                {filteredColleagues.map((c) => {
                  const selected = groupMembers.includes(c.id);
                  return (
                  <button
                    key={c.id}
                    onClick={() => newMode === "direct"
                      ? startDirect(c.id)
                      : setGroupMembers((prev) => selected ? prev.filter((id) => id !== c.id) : [...prev, c.id])}
                    data-testid={`start-chat-${c.id}`}
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-border/50 transition ${newMode === "group" && selected ? "bg-violet-50" : "hover:bg-muted/50"}`}
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${newMode === "group" && selected ? "bg-violet-600 text-white" : "bg-primary text-white"}`}>
                      {initials(c.name)}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{roleLabel[c.role] ?? c.role}</div>
                    </div>
                    {newMode === "group" && (
                      <div className={`w-4 h-4 rounded border flex items-center justify-center ${selected ? "bg-violet-600 border-violet-600" : "border-border"}`}>
                        {selected && <span className="text-white text-[10px] leading-none">✓</span>}
                      </div>
                    )}
                  </button>
                  );
                })}
              </div>
              {newMode === "group" && (
                <div className="p-3 border-t">
                  <button onClick={createGroup} disabled={creatingGroup} data-testid="button-create-group"
                    className="w-full py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 transition disabled:opacity-50">
                    {creatingGroup ? "Criando..." : `Criar grupo${groupMembers.length > 0 ? ` (${groupMembers.length} participante${groupMembers.length > 1 ? "s" : ""})` : ""}`}
                  </button>
                </div>
              )}
            </div>
          </div>
  );

  const viewTabs = (
    <div className="flex items-center gap-1 p-1.5 border-b bg-muted/20 shrink-0">
      <button
        onClick={() => setView("chat")}
        data-testid="tab-internal-chat"
        className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 transition ${
          view === "chat" ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted/60"
        }`}
      >
        <MessagesSquare className="w-3.5 h-3.5" /> Conversas
      </button>
      <button
        onClick={() => setView("tasks")}
        data-testid="tab-internal-tasks"
        className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 transition ${
          view === "tasks" ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted/60"
        }`}
      >
        <SquareKanban className="w-3.5 h-3.5" /> Quadro de Tarefas
      </button>
    </div>
  );

  if (docked) {
    return (
      <div className="relative flex flex-col h-full min-h-0 bg-card overflow-hidden">
        {viewTabs}
        {view === "tasks" ? (
          <div className="flex-1 overflow-y-auto p-3">
            <TaskBoard compact />
          </div>
        ) : active ? (
          <section className="flex-1 flex flex-col min-h-0">{threadPanel}</section>
        ) : (
          <div className="flex flex-col h-full min-h-0">{listPanel}</div>
        )}
        {newModal}{taskModal}
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-2 md:px-4 py-2 md:py-4">
      {/* Celular: uma coluna só (lista OU conversa) e altura descontando a
          bottom nav — duas colunas espremidas distorciam tudo. */}
      <div className="relative flex flex-col h-[calc(100dvh-11rem-env(safe-area-inset-bottom))] md:h-[calc(100vh-180px)] min-h-[380px] md:min-h-[480px] rounded-xl border bg-card overflow-hidden shadow-sm">
        {viewTabs}
        {view === "tasks" ? (
          <div className="flex-1 overflow-y-auto p-4">
            <TaskBoard />
          </div>
        ) : (
          <div className="relative flex flex-1 min-h-0">
            <aside className={`w-full md:w-72 shrink-0 md:border-r flex-col bg-muted/20 ${active ? "hidden md:flex" : "flex"}`}>{listPanel}</aside>
            <section className={`flex-1 flex-col min-w-0 ${active ? "flex" : "hidden md:flex"}`}>{threadPanel}</section>
          </div>
        )}
        {newModal}{taskModal}
      </div>
    </div>
  );
}
