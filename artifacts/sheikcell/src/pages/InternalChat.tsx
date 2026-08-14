import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, canEditModule, type InternalConversation, type InternalMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { reportInternalChatUnread } from "@/hooks/useInternalChatNotifier";
import { acquireSharedEventSource, releaseSharedEventSource } from "@/lib/sharedEventSource";

const INTERNAL_CHAT_EVENTS_URL = "/api/internal-chat/events";
import {
  Users, Send, Plus, X, Search, MessagesSquare, ChevronLeft, SquareKanban, ClipboardPlus, Trash2, Pencil,
  Paperclip, Mic, Square, Reply, Forward, FileText, Volume2, Loader2,
} from "lucide-react";
import TaskBoard from "./TaskBoard";

// Rótulos/emoji fixos de mensagens de mídia sem legenda (ver POST .../media
// no servidor) — usados para não exibir o placeholder como se fosse texto.
const MEDIA_PLACEHOLDERS = new Set(["📷 Foto", "🎤 Áudio"]);
// Mesmo limite do endpoint POST .../media no servidor — valida no cliente
// antes de ler o arquivo em base64, evitando esperar por um erro do servidor.
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
function isMediaPlaceholder(s: string): boolean {
  return MEDIA_PLACEHOLDERS.has(s) || s.startsWith("📄 ");
}
function extractCaption(content: string): string {
  const nl = content.indexOf("\n");
  if (nl === -1) return isMediaPlaceholder(content) ? "" : content;
  const first = content.slice(0, nl);
  return isMediaPlaceholder(first) ? content.slice(nl + 1) : content;
}

// Prévia de uma linha da mensagem citada (na barra "respondendo a" e dentro do
// balão da resposta) — texto puro, ou rótulo do tipo de mídia + legenda se houver.
function replyPreviewText(r: { type: InternalMessage["type"]; content: string }): string {
  if (r.type === "text") return r.content;
  const label = r.type === "image" ? "📷 Foto" : r.type === "audio" ? "🎤 Áudio" : r.content.split("\n")[0]!;
  const caption = extractCaption(r.content);
  return caption ? `${label} · ${caption}` : label;
}

/** Áudio com botão de transcrição (Whisper) — mesmo padrão do ChatCenter. */
function InternalAudioBubble({ msg, onTranscribed }: { msg: InternalMessage; onTranscribed: (id: number, transcript: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleTranscribe = async () => {
    if (busy || msg.transcript) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.internalChat.transcribe(msg.id);
      onTranscribed(msg.id, r.transcript);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Falha ao transcrever");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 bg-black/5 rounded-xl px-3 py-2 min-w-[200px]">
        <Volume2 className="w-4 h-4 shrink-0" />
        <audio controls className="flex-1 h-8 max-w-[200px]" style={{ minWidth: 0 }}>
          <source src={msg.mediaUrl ?? undefined} />
        </audio>
      </div>
      {msg.transcript ? (
        <p className="text-xs mt-1 bg-black/5 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap" data-testid={`text-transcript-${msg.id}`}>
          📝 {msg.transcript}
        </p>
      ) : (
        <button onClick={handleTranscribe} disabled={busy} data-testid={`button-transcribe-${msg.id}`}
          className="text-[11px] font-semibold underline mt-0.5 disabled:opacity-60 opacity-90">
          {busy ? "Transcrevendo…" : "📝 Transcrever áudio"}
        </button>
      )}
      {err && <p className="text-[11px] text-red-600 mt-0.5">{err}</p>}
    </div>
  );
}

function InternalMediaContent({ msg, onTranscribed }: { msg: InternalMessage; onTranscribed: (id: number, transcript: string) => void }) {
  if (!msg.mediaUrl) return null;
  if (msg.type === "audio") return <InternalAudioBubble msg={msg} onTranscribed={onTranscribed} />;
  if (msg.type === "image") {
    return (
      <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="block mb-1">
        <img src={msg.mediaUrl} alt="Foto" className="max-w-full rounded-xl object-cover max-h-64 cursor-pointer hover:opacity-90 transition" />
      </a>
    );
  }
  if (msg.type === "doc") {
    const filename = msg.mediaUrl.split("/").pop() ?? "documento";
    return (
      <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" download
        className="flex items-center gap-2 mb-1 bg-black/5 rounded-xl px-3 py-2 hover:bg-black/10 transition">
        <FileText className="w-5 h-5 shrink-0" />
        <span className="text-xs break-all">{filename}</span>
      </a>
    );
  }
  return null;
}

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

type InternalChatProps = {
  docked?: boolean;
  onActiveConversationChange?: (id: number | null) => void;
  // Só lido na montagem (useState initializer): a tela sempre monta do zero
  // quando a aba "equipe" é aberta, então isso já basta pra abrir direto na
  // conversa pedida pelo widget flutuante ("expandir").
  initialConversationId?: number | null;
};

export default function InternalChat({ docked = false, onActiveConversationChange, initialConversationId = null }: InternalChatProps = {}) {
  const { user } = useAuth();
  const canEdit = canEditModule(user, "equipe");
  const { toast } = useToast();
  const [conversations, setConversations] = useState<InternalConversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(initialConversationId);
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
  // Edição de grupo (admin): renomear e adicionar/remover participantes.
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editMembers, setEditMembers] = useState<number[]>([]);
  const [editSearch, setEditSearch] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  // @menção: sugestões enquanto digita "@..." no composer.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // Criar tarefa a partir de uma mensagem do chat (vínculo com o quadro).
  const [taskFromMsg, setTaskFromMsg] = useState<InternalMessage | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState<string>("");
  const [taskDue, setTaskDue] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  // Envio de mídia (foto/documento/áudio) e gravação de áudio. Todo anexo
  // (escolhido no seletor de arquivo ou gravado no microfone) passa por um
  // preview com legenda opcional antes de ser efetivamente enviado.
  const [sendingMedia, setSendingMedia] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ file: File; kind: "image" | "doc" | "audio"; previewUrl: string | null } | null>(null);
  const [attachCaption, setAttachCaption] = useState("");
  // Encaminhar mensagem: modal com a lista de conversas para escolher destino(s).
  const [forwardMsg, setForwardMsg] = useState<InternalMessage | null>(null);
  const [forwardTargets, setForwardTargets] = useState<number[]>([]);
  const [forwarding, setForwarding] = useState(false);
  // Responder mensagem (estilo WhatsApp): mensagem citada mostrada acima do
  // composer até ser enviada (ou cancelada); highlightedMsgId é o realce
  // temporário ao pular para a mensagem original clicando na citação.
  const [replyTarget, setReplyTarget] = useState<InternalMessage | null>(null);
  const [highlightedMsgId, setHighlightedMsgId] = useState<number | null>(null);

  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordSendRef = useRef(false);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    onActiveConversationChange?.(activeId);
  }, [activeId, onActiveConversationChange]);

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

  // Mantém o badge do menu (fora deste componente) sincronizado com a lista
  // real de conversas sempre que ela muda — sem esperar o polling do hook.
  useEffect(() => {
    reportInternalChatUnread(conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0));
  }, [conversations]);

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

  // Campo de mensagem multi-linha: cresce junto com o texto (até o limite
  // visual de max-h-32, quando passa a rolar em vez de crescer mais).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Real-time updates.
  useEffect(() => {
    const es = acquireSharedEventSource(INTERNAL_CHAT_EVENTS_URL);
    const onInternalMessage = (e: Event) => {
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
    };
    es.addEventListener("internal_message", onInternalMessage);
    // When the reconnection gap is larger than the server's replay buffer (or
    // the server restarted), the server asks the client to resync. Reconcile the
    // conversation list (authoritative unread counts) and the open conversation's
    // messages so nothing sent during the outage is lost.
    // Novo grupo criado por um colega: aparece na lista em tempo real.
    const onConversationNew = (e: Event) => {
      const conv = JSON.parse((e as MessageEvent).data) as InternalConversation & { members?: { id: number; name: string }[] };
      // Quando o servidor manda a lista de membros (ex.: fui adicionado a um
      // grupo existente), monta o "Você, Fulano..." excluindo a si mesmo.
      if (conv.members) conv.memberNames = conv.members.filter((m) => m.id !== user?.id).map((m) => m.name);
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [...prev, conv]));
    };
    es.addEventListener("internal_conversation_new", onConversationNew);
    // Grupo excluído por um admin/supervisor (ou fui removido dele): some da
    // lista na hora.
    const onConversationRemoved = (e: Event) => {
      const { id } = JSON.parse((e as MessageEvent).data) as { id: number };
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    };
    es.addEventListener("internal_conversation_removed", onConversationRemoved);
    // Grupo editado (renomeado / participantes mudaram): atualiza em tempo real.
    const onConversationUpdated = (e: Event) => {
      const payload = JSON.parse((e as MessageEvent).data) as { id: number; name: string; members: { id: number; name: string }[] };
      setConversations((prev) => prev.map((c) => c.id === payload.id
        ? { ...c, name: payload.name, memberNames: payload.members.filter((m) => m.id !== user?.id).map((m) => m.name) }
        : c));
    };
    es.addEventListener("internal_conversation_updated", onConversationUpdated);
    // Transcrição de áudio pronta (pode ter sido pedida por outro membro da conversa).
    const onMessageUpdated = (e: Event) => {
      const payload = JSON.parse((e as MessageEvent).data) as { conversationId: number; messageId: number; transcript: string };
      if (activeIdRef.current === payload.conversationId) {
        setMessages((prev) => prev.map((m) => (m.id === payload.messageId ? { ...m, transcript: payload.transcript } : m)));
      }
    };
    es.addEventListener("internal_message_updated", onMessageUpdated);
    const onResync = () => { reconcileAfterReconnect(); };
    es.addEventListener("resync", onResync);
    // After a within-buffer reconnect, the server replays missed messages (which
    // flow through the handler above and bump unread counters approximately) and
    // then emits this sentinel. Reconcile so the badges match the backend exactly.
    const onInternalReconnect = () => { reconcileAfterReconnect(); };
    es.addEventListener("internal_reconnect", onInternalReconnect);
    return () => {
      es.removeEventListener("internal_message", onInternalMessage);
      es.removeEventListener("internal_conversation_new", onConversationNew);
      es.removeEventListener("internal_conversation_removed", onConversationRemoved);
      es.removeEventListener("internal_conversation_updated", onConversationUpdated);
      es.removeEventListener("internal_message_updated", onMessageUpdated);
      es.removeEventListener("resync", onResync);
      es.removeEventListener("internal_reconnect", onInternalReconnect);
      releaseSharedEventSource(INTERNAL_CHAT_EVENTS_URL);
    };
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

  // Abre o modal de edição do grupo carregando os participantes atuais.
  const openEditGroup = async (conv: InternalConversation) => {
    setEditingGroupId(conv.id);
    setEditName(conv.name);
    setEditSearch("");
    setEditMembers([]);
    try {
      const members = await api.internalChat.groupMembers(conv.id);
      setEditMembers(members.map((m) => m.id));
    } catch {
      toast({ title: "Erro ao carregar participantes", variant: "destructive" });
      setEditingGroupId(null);
    }
  };

  const saveGroup = async () => {
    if (editingGroupId == null || savingGroup) return;
    const name = editName.trim();
    if (!name) { toast({ title: "Dê um nome ao grupo", variant: "destructive" }); return; }
    if (editMembers.length === 0) { toast({ title: "Escolha pelo menos um participante", variant: "destructive" }); return; }
    setSavingGroup(true);
    try {
      // A lista é enviada exatamente como escolhida: o admin pode inclusive
      // sair do grupo desmarcando a si mesmo (o servidor não readiciona ninguém).
      const updated = await api.internalChat.updateGroup(editingGroupId, { name, memberIds: editMembers });
      const stillMember = user != null && (updated.members ?? []).some((m) => m.id === user.id);
      if (stillMember) {
        const memberNames = (updated.members ?? []).filter((m) => m.id !== user?.id).map((m) => m.name);
        setConversations((prev) => prev.map((c) => (c.id === editingGroupId ? { ...c, name: updated.name, memberNames } : c)));
      } else {
        // Saí do grupo: ele some da minha lista (o SSE também manda o evento).
        setConversations((prev) => prev.filter((c) => c.id !== editingGroupId));
        setActiveId((cur) => (cur === editingGroupId ? null : cur));
      }
      setEditingGroupId(null);
      toast({ title: "Grupo atualizado! ✅" });
    } catch (err) {
      toast({ title: "Erro ao salvar grupo", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingGroup(false);
    }
  };

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || activeId == null || sending) return;
    setSending(true);
    setDraft("");
    setMentionQuery(null);
    // Mantém o foco no campo pra continuar digitando na hora — sem isso, quem
    // envia clicando no botão (em vez de Ctrl+Enter) perde o foco pro botão.
    textareaRef.current?.focus();
    try {
      const msg = await api.internalChat.send(activeId, content, replyTarget?.id);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, lastMessage: msg.content, lastMessageAt: msg.createdAt } : c)));
      setReplyTarget(null);
    } catch (err) {
      setDraft(content);
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Falha ao enviar", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  // ── Envio de mídia (foto/documento/áudio) com preview antes de enviar ──
  // Arquivo escolhido no seletor: monta o preview (imagem/áudio tocável, ou
  // ícone+nome para documento) em vez de enviar direto.
  const pickAttachment = (file: File) => {
    if (file.size > MEDIA_MAX_BYTES) {
      toast({ title: "Arquivo muito grande", description: "O tamanho máximo é 20 MB.", variant: "destructive" });
      return;
    }
    const kind: "image" | "doc" | "audio" = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "doc";
    const previewUrl = kind === "doc" ? null : URL.createObjectURL(file);
    setPendingAttachment({ file, kind, previewUrl });
    setAttachCaption("");
  };

  const cancelAttachment = () => {
    if (pendingAttachment?.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
    setPendingAttachment(null);
    setAttachCaption("");
  };

  const confirmSendAttachment = async () => {
    if (!pendingAttachment || activeId == null || sendingMedia) return;
    setSendingMedia(true);
    try {
      const msg = await api.internalChat.sendMedia(activeId, pendingAttachment.file, attachCaption.trim() || undefined, replyTarget?.id);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, lastMessage: msg.content, lastMessageAt: msg.createdAt } : c)));
      if (pendingAttachment.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
      setPendingAttachment(null);
      setAttachCaption("");
      setReplyTarget(null);
    } catch (err) {
      toast({ title: "Erro ao enviar arquivo", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSendingMedia(false);
    }
  };

  // ── Gravação de nota de voz (microfone) — mesmo padrão do ChatCenter ──
  const stopRecordTimer = () => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
  };

  const handleStartRecording = async () => {
    if (activeId == null || recording || sendingMedia) return;
    if (typeof window !== "undefined" && !window.isSecureContext) {
      toast({ title: "Microfone bloqueado: o site precisa abrir com https://", variant: "destructive" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast({ title: "Gravação de áudio não suportada neste navegador", variant: "destructive" });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recordChunksRef.current = [];
      recordSendRef.current = false;
      rec.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopRecordTimer();
        setRecording(false);
        setRecordSecs(0);
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        // "Cancelar" durante a gravação: descarta sem passar pelo preview.
        if (!recordSendRef.current || chunks.length === 0) return;
        const type = (rec.mimeType || "audio/webm").split(";")[0];
        const ext = type === "audio/mp4" ? "m4a" : "weba";
        const file = new File([new Blob(chunks, { type })], `nota-de-voz.${ext}`, { type: rec.mimeType || "audio/webm" });
        // Ao invés de enviar direto, cai no mesmo preview usado por
        // foto/documento — usuário ouve antes de confirmar o envio.
        setPendingAttachment({ file, kind: "audio", previewUrl: URL.createObjectURL(file) });
        setAttachCaption("");
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordSecs(0);
      recordTimerRef.current = setInterval(() => setRecordSecs((s) => s + 1), 1000);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      toast({
        title: name === "NotFoundError" ? "Nenhum microfone encontrado neste aparelho" : "Permissão do microfone negada",
        variant: "destructive",
      });
    }
  };

  const handleStopRecording = (send: boolean) => {
    recordSendRef.current = send;
    recorderRef.current?.stop();
  };

  const recordTimeLabel = `${Math.floor(recordSecs / 60)}:${String(recordSecs % 60).padStart(2, "0")}`;

  // ── Responder mensagem (estilo WhatsApp) ──
  const openReply = (m: InternalMessage) => setReplyTarget(m);
  const cancelReply = () => setReplyTarget(null);

  // Clique na citação dentro do balão: pula até a mensagem original (mesma
  // conversa, já carregada) e dá um realce temporário para achar na hora.
  const scrollToMessage = (id: number) => {
    document.getElementById(`internal-msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMsgId(id);
    setTimeout(() => setHighlightedMsgId((cur) => (cur === id ? null : cur)), 1500);
  };

  const onTranscribed = (id: number, transcript: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, transcript } : m)));
  };

  // ── Encaminhar mensagem ──
  const openForward = (m: InternalMessage) => {
    setForwardMsg(m);
    setForwardTargets([]);
  };

  const submitForward = async () => {
    if (!forwardMsg || forwardTargets.length === 0 || forwarding) return;
    setForwarding(true);
    try {
      await api.internalChat.forward(forwardMsg.id, forwardTargets);
      // Se um dos destinos é a conversa aberta, a própria mensagem chega via SSE.
      toast({ title: `Mensagem encaminhada para ${forwardTargets.length} conversa${forwardTargets.length > 1 ? "s" : ""}! ↪️` });
      setForwardMsg(null);
    } catch (err) {
      toast({ title: "Erro ao encaminhar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setForwarding(false);
    }
  };

  const filteredColleagues = colleagues.filter((c) => c.name.toLowerCase().includes(colleagueSearch.toLowerCase()));

  const listPanel = (
    <>
          <div className="p-3 border-b flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <MessagesSquare className="w-4 h-4 text-primary" /> Chat Interno
            </div>
            {canEdit && (
              <div className="flex items-center gap-1">
                <button
                  onClick={openNew}
                  data-testid="button-new-internal-chat"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:bg-primary/10 rounded-md px-2 py-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Novo
                </button>
              </div>
            )}
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
                    onClick={() => openEditGroup(active)}
                    data-testid="button-edit-group"
                    title="Editar grupo"
                    className="ml-auto p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition shrink-0"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
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
                    className="p-2 rounded-lg text-red-600 hover:bg-red-50 transition shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                {active.kind === "general" && user?.role === "admin" && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Excluir "${active.name}" para SEMPRE? Todo o histórico de mensagens da equipe inteira será apagado e não pode ser desfeito. A sala não será recriada automaticamente.`)) return;
                      try {
                        await api.internalChat.deleteGeneral();
                        setConversations((prev) => prev.filter((c) => c.id !== active.id));
                        setActiveId(null);
                      } catch (err) {
                        alert(err instanceof Error ? err.message : "Erro ao excluir a sala geral");
                      }
                    }}
                    data-testid="button-delete-general"
                    title="Excluir sala geral (permanente)"
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
                  const caption = m.type !== "text" ? extractCaption(m.content) : "";
                  const toolbar = (
                    <div className="opacity-0 group-hover:opacity-100 transition flex items-center gap-0.5 shrink-0">
                      {canEditModule(user, "tarefas") && (
                        <button
                          onClick={() => openTaskFromMsg(m)}
                          data-testid={`button-task-from-msg-${m.id}`}
                          title="Criar tarefa desta mensagem"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10"
                        >
                          <ClipboardPlus className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {canEdit && (
                        <>
                          <button
                            onClick={() => openForward(m)}
                            data-testid={`button-forward-msg-${m.id}`}
                            title="Encaminhar mensagem"
                            className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10"
                          >
                            <Forward className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => openReply(m)}
                            data-testid={`button-reply-msg-${m.id}`}
                            title="Responder mensagem"
                            className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10"
                          >
                            <Reply className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                  return (
                    <div
                      key={m.id}
                      id={`internal-msg-${m.id}`}
                      className={`group flex items-center gap-1 rounded-lg transition-colors duration-500 ${mine ? "justify-end" : "justify-start"} ${
                        highlightedMsgId === m.id ? "bg-amber-200/60" : ""
                      }`}
                    >
                      {mine && toolbar}
                      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                        mine ? "bg-primary text-white rounded-br-sm" : "bg-card border rounded-bl-sm"
                      }`}>
                        {!mine && active.kind !== "direct" && (
                          <div className="text-[11px] font-semibold text-primary mb-0.5">{m.senderName}</div>
                        )}
                        {m.forwarded && (
                          <div className={`flex items-center gap-1 text-[10px] italic mb-0.5 ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                            <Forward className="w-3 h-3" /> Encaminhada
                          </div>
                        )}
                        {m.replyTo && (
                          <button
                            onClick={() => scrollToMessage(m.replyTo!.id)}
                            data-testid={`button-jump-reply-${m.id}`}
                            className={`block w-full text-left mb-1 rounded-lg px-2 py-1 border-l-4 truncate ${
                              mine ? "bg-white/15 border-white/50" : "bg-black/5 border-primary/50"
                            }`}
                          >
                            <div className={`text-[11px] font-semibold ${mine ? "text-white/90" : "text-primary"}`}>{m.replyTo.senderName}</div>
                            <div className={`text-xs truncate ${mine ? "text-white/80" : "text-muted-foreground"}`}>{replyPreviewText(m.replyTo)}</div>
                          </button>
                        )}
                        {m.type !== "text" && <InternalMediaContent msg={m} onTranscribed={onTranscribed} />}
                        {(m.type === "text" || caption) && (
                          <div className="text-sm whitespace-pre-wrap break-words">
                            {renderWithMentions(m.type === "text" ? m.content : caption, teamNames, user?.name, mine)}
                          </div>
                        )}
                        <div className={`flex items-center justify-end gap-1 text-[10px] mt-0.5 ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                          {timeLabel(m.createdAt)}
                        </div>
                      </div>
                      {!mine && toolbar}
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {!canEdit ? (
                <div className="border-t shrink-0 px-3 py-2.5 text-center">
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 inline-block">
                    Você só tem acesso de visualização ao Chat Interno — peça ao administrador para liberar edição.
                  </p>
                </div>
              ) : (
              <div className="border-t shrink-0">
                {/* Barra "respondendo a": aparece acima do composer até enviar ou cancelar
                    a citação; vale tanto para o próximo texto quanto para o próximo anexo. */}
                {replyTarget && (
                  <div className="flex items-center gap-2 px-3 pt-2" data-testid="reply-preview-bar">
                    <div className="flex-1 min-w-0 bg-muted/40 border-l-4 border-primary/60 rounded-lg px-2.5 py-1.5">
                      <div className="text-[11px] font-semibold text-primary">Respondendo a {replyTarget.senderName}</div>
                      <div className="text-xs text-muted-foreground truncate">{replyPreviewText(replyTarget)}</div>
                    </div>
                    <button onClick={cancelReply} data-testid="button-cancel-reply" title="Cancelar resposta"
                      className="p-1.5 rounded-md text-muted-foreground hover:bg-muted/60 shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              <div className="relative p-3 flex items-end gap-2">
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
                {pendingAttachment ? (
                  <div className="flex-1 flex items-center gap-2 rounded-lg border px-3 py-2 bg-muted/30" data-testid="attachment-preview">
                    {pendingAttachment.kind === "image" && pendingAttachment.previewUrl && (
                      <img src={pendingAttachment.previewUrl} alt="Preview" className="w-11 h-11 rounded-lg object-cover shrink-0" />
                    )}
                    {pendingAttachment.kind === "audio" && pendingAttachment.previewUrl && (
                      <audio controls src={pendingAttachment.previewUrl} className="h-8 max-w-[170px] shrink-0" />
                    )}
                    {pendingAttachment.kind === "doc" && (
                      <div className="flex items-center gap-1.5 shrink-0 max-w-[140px]">
                        <FileText className="w-5 h-5 shrink-0 text-muted-foreground" />
                        <span className="text-xs truncate">{pendingAttachment.file.name}</span>
                      </div>
                    )}
                    <input
                      value={attachCaption}
                      onChange={(e) => setAttachCaption(e.target.value)}
                      placeholder="Adicionar legenda (opcional)"
                      data-testid="input-attachment-caption"
                      className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
                    />
                  </div>
                ) : recording ? (
                  <div className="flex-1 flex items-center gap-2 rounded-lg border px-3 py-2 bg-red-50" data-testid="recording-indicator">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                    <span className="text-sm text-red-700 font-medium flex-1">Gravando áudio... {recordTimeLabel}</span>
                    <button onClick={() => handleStopRecording(false)} data-testid="button-cancel-recording"
                      title="Cancelar" className="p-1.5 rounded-md text-red-600 hover:bg-red-100">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => { setDraft(e.target.value); updateMentionState(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && mentionOptions.length > 0) {
                        e.preventDefault();
                        insertMention(mentionOptions[0].name);
                        return;
                      }
                      // Enter e Shift+Enter só quebram linha (comportamento padrão do
                      // textarea); enviar é só pelo botão ou Ctrl/Cmd+Enter.
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        handleSend();
                        return;
                      }
                      if (e.key === "Escape") setMentionQuery(null);
                    }}
                    placeholder="Escreva uma mensagem... (Enter quebra linha, Ctrl+Enter envia)"
                    title="Enter quebra linha. Envie pelo botão ou com Ctrl+Enter."
                    rows={1}
                    data-testid="input-internal-message"
                    className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm max-h-32 overflow-y-auto focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/webm,audio/aac,application/pdf,application/msword,.docx,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) pickAttachment(f);
                  }}
                />
                {pendingAttachment ? (
                  <>
                    <button
                      onClick={cancelAttachment}
                      disabled={sendingMedia}
                      data-testid="button-cancel-attachment"
                      title="Cancelar"
                      className="shrink-0 w-10 h-10 rounded-lg border flex items-center justify-center text-muted-foreground hover:bg-muted/60 disabled:opacity-40"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <button
                      onClick={confirmSendAttachment}
                      disabled={sendingMedia}
                      data-testid="button-send-attachment"
                      className="shrink-0 w-10 h-10 rounded-lg bg-primary text-white flex items-center justify-center disabled:opacity-40 hover:bg-primary/90"
                    >
                      {sendingMedia ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    </button>
                  </>
                ) : (
                  <>
                    {!recording && (
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={sendingMedia}
                        data-testid="button-attach-internal"
                        title="Anexar foto, áudio ou documento"
                        className="shrink-0 w-10 h-10 rounded-lg border flex items-center justify-center text-muted-foreground hover:bg-muted/60 disabled:opacity-40"
                      >
                        {sendingMedia ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      </button>
                    )}
                    {draft.trim() ? (
                      <button
                        onClick={handleSend}
                        disabled={sending}
                        data-testid="button-send-internal"
                        className="shrink-0 w-10 h-10 rounded-lg bg-primary text-white flex items-center justify-center disabled:opacity-40 hover:bg-primary/90"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => (recording ? handleStopRecording(true) : handleStartRecording())}
                        disabled={sendingMedia}
                        data-testid="button-record-internal"
                        title={recording ? "Parar gravação" : "Gravar áudio"}
                        className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center disabled:opacity-40 ${
                          recording ? "bg-red-500 text-white hover:bg-red-600" : "bg-primary text-white hover:bg-primary/90"
                        }`}
                      >
                        {recording ? <Square className="w-4 h-4" fill="currentColor" /> : <Mic className="w-4 h-4" />}
                      </button>
                    )}
                  </>
                )}
              </div>
              </div>
              )}
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

  // Modal: encaminhar mensagem — escolher uma ou mais conversas de destino.
  const forwardModal = forwardMsg && (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setForwardMsg(null)}>
      <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border overflow-hidden mx-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm flex items-center gap-2"><Forward className="w-4 h-4 text-primary" /> Encaminhar mensagem</span>
          <button onClick={() => setForwardMsg(null)} data-testid="button-close-forward-modal" className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 pt-3">
          <div className="text-xs bg-muted/40 border rounded-lg px-3 py-2 text-muted-foreground line-clamp-3">
            {forwardMsg.type === "text" ? `"${forwardMsg.content}"` : forwardMsg.content.split("\n")[0]} — {forwardMsg.senderName}
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto mt-2">
          {conversations.map((c) => {
            const selected = forwardTargets.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => setForwardTargets((prev) => selected ? prev.filter((id) => id !== c.id) : [...prev, c.id])}
                data-testid={`forward-target-${c.id}`}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-border/50 transition ${selected ? "bg-primary/10" : "hover:bg-muted/50"}`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                  c.kind === "general" ? "bg-amber-500 text-white" : c.kind === "group" ? "bg-violet-500 text-white" : "bg-primary text-white"
                }`}>
                  {c.kind !== "direct" ? <Users className="w-4 h-4" /> : initials(c.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{c.name}</div>
                </div>
                <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${selected ? "bg-primary border-primary" : "border-border"}`}>
                  {selected && <span className="text-white text-[10px] leading-none">✓</span>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="p-3 border-t">
          <button onClick={submitForward} disabled={forwardTargets.length === 0 || forwarding} data-testid="button-submit-forward"
            className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
            {forwarding ? "Encaminhando..." : `Encaminhar${forwardTargets.length > 0 ? ` (${forwardTargets.length})` : ""}`}
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

  // Modal: editar grupo (renomear + adicionar/remover participantes).
  // O próprio admin aparece na lista: ele também pode entrar/sair do grupo.
  const editCandidates = user ? [{ id: user.id, name: `${user.name} (você)`, role: user.role }, ...colleagues] : colleagues;
  const editFiltered = editCandidates.filter((c) => c.name.toLowerCase().includes(editSearch.toLowerCase()));
  const editModal = editingGroupId != null && (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setEditingGroupId(null)}>
      <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border overflow-hidden mx-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm flex items-center gap-2"><Pencil className="w-4 h-4 text-violet-600" /> Editar grupo</span>
          <button onClick={() => setEditingGroupId(null)} data-testid="button-close-edit-group" className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 border-b">
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Nome do grupo"
            data-testid="input-edit-group-name"
            className="w-full px-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={editSearch}
              onChange={(e) => setEditSearch(e.target.value)}
              placeholder="Buscar colega..."
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {editFiltered.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">Nenhum colega encontrado.</div>
          )}
          {editFiltered.map((c) => {
            const selected = editMembers.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => setEditMembers((prev) => selected ? prev.filter((id) => id !== c.id) : [...prev, c.id])}
                data-testid={`edit-member-${c.id}`}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-border/50 transition ${selected ? "bg-violet-50" : "hover:bg-muted/50"}`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${selected ? "bg-violet-600 text-white" : "bg-primary text-white"}`}>
                  {initials(c.name)}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{roleLabel[c.role] ?? c.role}</div>
                </div>
                <div className={`w-4 h-4 rounded border flex items-center justify-center ${selected ? "bg-violet-600 border-violet-600" : "border-border"}`}>
                  {selected && <span className="text-white text-[10px] leading-none">✓</span>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="p-3 border-t">
          <button onClick={saveGroup} disabled={savingGroup} data-testid="button-save-group"
            className="w-full py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 transition disabled:opacity-50">
            {savingGroup ? "Salvando..." : `Salvar alterações${editMembers.length > 0 ? ` (${editMembers.length} participante${editMembers.length > 1 ? "s" : ""})` : ""}`}
          </button>
        </div>
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
        {newModal}{editModal}{taskModal}{forwardModal}
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-2 md:px-4 py-2 md:py-4">
      {/* Celular: uma coluna só (lista OU conversa) e altura descontando a
          bottom nav — duas colunas espremidas distorciam tudo. */}
      <div className="relative flex flex-col h-[calc(var(--vvh,100dvh)-11rem-env(safe-area-inset-bottom))] md:h-[calc(100vh-180px)] md:min-h-[480px] rounded-xl border bg-card overflow-hidden shadow-sm">
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
        {newModal}{editModal}{taskModal}{forwardModal}
      </div>
    </div>
  );
}
