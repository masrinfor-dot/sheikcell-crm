import { useState, useEffect, useRef, useCallback } from "react";
import { api, type Conversation, type ChatMessage, type Sector } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Search, Plus, Send, RefreshCw, X, ChevronDown,
  MessageCircle, Clock, CheckCheck, Tag, Filter,
  Smartphone, Instagram, UserCircle2, Archive, Circle,
  Phone, ArrowRightLeft
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────
type StatusFilter = "all" | "open" | "pending" | "resolved";
const LABELS_OPTIONS = ["VIP", "Urgente", "Promoção", "Suporte", "Pós-venda", "Aguardando"];
const STATUS_COLORS: Record<string, string> = {
  open: "bg-green-500", pending: "bg-amber-400", resolved: "bg-gray-400",
};
const STATUS_LABELS: Record<string, string> = {
  open: "Aberto", pending: "Pendente", resolved: "Resolvido",
};

function channelIcon(ch: string) {
  if (ch === "whatsapp") return <Smartphone className="w-3 h-3 text-green-500" />;
  if (ch === "instagram") return <Instagram className="w-3 h-3 text-pink-500" />;
  return <MessageCircle className="w-3 h-3 text-muted-foreground" />;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "agora";
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function msgTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ─── Avatar ────────────────────────────────────────────────────────────────
function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const colors = ["bg-blue-500", "bg-purple-500", "bg-green-500", "bg-orange-500", "bg-pink-500", "bg-teal-500"];
  const color = colors[name.charCodeAt(0) % colors.length];
  const sz = size === "sm" ? "w-8 h-8 text-xs" : size === "lg" ? "w-12 h-12 text-base" : "w-10 h-10 text-sm";
  return (
    <div className={`${sz} ${color} rounded-full flex items-center justify-center text-white font-bold shrink-0`}>
      {initials || <UserCircle2 className="w-5 h-5" />}
    </div>
  );
}

// ─── Conversation list item ─────────────────────────────────────────────────
function ConvItem({ conv, active, onClick }: { conv: Conversation; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-testid={`conv-item-${conv.id}`}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/60 transition border-b border-border/50 ${active ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
    >
      <div className="relative shrink-0">
        <Avatar name={conv.name} size="md" />
        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${STATUS_COLORS[conv.status] ?? "bg-gray-300"}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className="font-semibold text-sm text-foreground truncate">{conv.name}</span>
          <span className="text-xs text-muted-foreground shrink-0">{timeAgo(conv.lastMessageAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-1">
          <p className="text-xs text-muted-foreground truncate flex-1">{conv.lastMessage ?? "Sem mensagens"}</p>
          <div className="flex items-center gap-1 shrink-0">
            {channelIcon(conv.channel)}
            {conv.unreadCount > 0 && (
              <span className="bg-green-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-bold">
                {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
              </span>
            )}
          </div>
        </div>
        {conv.labels && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {conv.labels.split(",").map((l) => l.trim()).filter(Boolean).slice(0, 2).map((label) => (
              <span key={label} className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">{label}</span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

// ─── Message bubble ─────────────────────────────────────────────────────────
function MsgBubble({ msg }: { msg: ChatMessage }) {
  const out = msg.direction === "outbound";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"} mb-1`}>
      <div className={`max-w-[75%] rounded-2xl px-3 py-2 shadow-sm ${out ? "bg-[#dcf8c6] rounded-br-sm" : "bg-white rounded-bl-sm border border-border"}`}>
        {!out && msg.senderName && (
          <p className="text-xs font-semibold text-primary mb-1">{msg.senderName}</p>
        )}
        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{msg.content}</p>
        <div className={`flex items-center gap-1 mt-1 ${out ? "justify-end" : "justify-start"}`}>
          <span className="text-xs text-gray-500">{msgTime(msg.createdAt)}</span>
          {out && (
            <CheckCheck className={`w-3 h-3 ${msg.status === "read" ? "text-blue-500" : "text-gray-400"}`} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function ChatCenter() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [convs, setConvs] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [labelFilter, setLabelFilter] = useState("");
  const [msgText, setMsgText] = useState("");
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [showNewConv, setShowNewConv] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showTransferPicker, setShowTransferPicker] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [newForm, setNewForm] = useState({ name: "", phone: "", channel: "whatsapp", sectorId: "" });

  const msgsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeConv = convs.find((c) => c.id === activeId) ?? null;

  // ── Fetch conversations ──
  const fetchConvs = useCallback(async () => {
    try {
      const params: Parameters<typeof api.chat.conversations>[0] = {};
      if (search) params.search = search;
      if (statusFilter !== "all") params.status = statusFilter;
      if (labelFilter) params.label = labelFilter;
      const data = await api.chat.conversations(params);
      setConvs(data);
    } catch { /* silent */ } finally { setLoadingConvs(false); }
  }, [search, statusFilter, labelFilter]);

  // ── Fetch messages ──
  const fetchMsgs = useCallback(async (id: number) => {
    setLoadingMsgs(true);
    try {
      const data = await api.chat.messages(id);
      setMessages(data);
      setConvs((prev) => prev.map((c) => c.id === id ? { ...c, unreadCount: 0 } : c));
    } catch { /* silent */ } finally { setLoadingMsgs(false); }
  }, []);

  useEffect(() => { fetchConvs(); }, [fetchConvs]);

  useEffect(() => {
    if (activeId) { fetchMsgs(activeId); inputRef.current?.focus(); }
  }, [activeId, fetchMsgs]);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── SSE real-time ──
  useEffect(() => {
    const es = new EventSource("/api/chat/events", { withCredentials: true });
    es.addEventListener("message", (e) => {
      try {
        const { conversationId, message } = JSON.parse(e.data) as { conversationId: number; message: ChatMessage };
        if (conversationId === activeId) {
          setMessages((prev) => [...prev, message]);
        }
        setConvs((prev) => prev.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: message.content, lastMessageAt: message.createdAt, unreadCount: conversationId === activeId ? 0 : c.unreadCount + 1 }
            : c
        ));
      } catch { /* silent */ }
    });
    es.addEventListener("conversation_new", (e) => {
      try { const conv = JSON.parse(e.data) as Conversation; setConvs((prev) => [conv, ...prev]); } catch { /* silent */ }
    });
    es.addEventListener("conversation_updated", (e) => {
      try { const conv = JSON.parse(e.data) as Conversation; setConvs((prev) => prev.map((c) => c.id === conv.id ? { ...c, ...conv } : c)); } catch { /* silent */ }
    });
    return () => es.close();
  }, [activeId]);

  useEffect(() => {
    api.sectors.list().then(setSectors).catch(() => {});
  }, []);

  // ── Send message ──
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || !msgText.trim() || sending) return;
    const text = msgText.trim();
    setMsgText("");
    setSending(true);
    const optimistic: ChatMessage = {
      id: -Date.now(), conversationId: activeId, content: text,
      direction: "outbound", type: "text", status: "sent",
      senderName: user?.name ?? null, mediaUrl: null, externalId: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const msg = await api.chat.sendMessage(activeId, text);
      setMessages((prev) => prev.map((m) => m.id === optimistic.id ? msg : m));
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setMsgText(text);
      toast({ title: "Erro ao enviar mensagem", variant: "destructive" });
    } finally { setSending(false); }
  };

  // ── Update status ──
  const handleStatus = async (status: string) => {
    if (!activeId) return;
    try {
      await api.chat.updateConversation(activeId, { status });
      setConvs((prev) => prev.map((c) => c.id === activeId ? { ...c, status } : c));
    } catch { toast({ title: "Erro ao atualizar", variant: "destructive" }); }
  };

  // ── Transfer conversation to sector ──
  const handleTransfer = async (targetSectorId: number) => {
    if (!activeConv) return;
    const targetSector = sectors.find((s) => s.id === targetSectorId);
    try {
      const updated = await api.chat.updateConversation(activeConv.id, { sectorId: targetSectorId });
      setConvs((prev) => prev.map((c) => c.id === activeConv.id ? { ...c, ...updated } : c));
      // Insert system message locally to show the transfer in chat history
      await api.chat.sendMessage(activeConv.id, `🔀 Conversa transferida para ${targetSector?.name ?? "outro setor"}`);
      setMessages((prev: ChatMessage[]) => [...prev, {
        id: Date.now(), conversationId: activeConv.id,
        content: `🔀 Conversa transferida para ${targetSector?.name ?? "outro setor"}`,
        direction: "outbound" as const, type: "system", status: "sent",
        senderName: "Sistema", mediaUrl: null, externalId: null,
        createdAt: new Date().toISOString(),
      }]);
      toast({ title: `Transferido para ${targetSector?.name ?? "setor"}` });
    } catch { toast({ title: "Erro ao transferir", variant: "destructive" }); }
    setShowTransferPicker(false);
  };

  // ── Toggle label ──
  const handleLabel = async (label: string) => {
    if (!activeConv) return;
    const current = activeConv.labels ? activeConv.labels.split(",").map((l) => l.trim()).filter(Boolean) : [];
    const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
    const labels = next.join(",");
    try {
      await api.chat.updateConversation(activeConv.id, { labels });
      setConvs((prev) => prev.map((c) => c.id === activeConv.id ? { ...c, labels } : c));
    } catch { toast({ title: "Erro ao salvar etiqueta", variant: "destructive" }); }
  };

  // ── Create conversation ──
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const conv = await api.chat.createConversation({
        phone: newForm.phone, name: newForm.name, channel: newForm.channel,
        sectorId: newForm.sectorId ? Number(newForm.sectorId) : undefined,
      });
      setConvs((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setShowNewConv(false);
      setNewForm({ name: "", phone: "", channel: "whatsapp", sectorId: "" });
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const filteredConvs = convs.filter((c) =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search)
  );

  const currentLabels = activeConv?.labels ? activeConv.labels.split(",").map((l) => l.trim()).filter(Boolean) : [];

  return (
    <div className="flex h-[calc(100vh-112px)] bg-[#f0f2f5] overflow-hidden rounded-2xl border border-border shadow-sm">

      {/* ── LEFT PANEL: conversation list ──────────────────────────────── */}
      <div className="w-80 lg:w-96 bg-white flex flex-col border-r border-border shrink-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-[#ededed] flex items-center justify-between">
          <span className="font-bold text-foreground">Conversas</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowFilter(!showFilter)} className={`p-1.5 rounded-lg hover:bg-secondary transition ${showFilter ? "bg-secondary" : ""}`}>
              <Filter className="w-4 h-4 text-muted-foreground" />
            </button>
            <button onClick={() => setShowNewConv(true)} data-testid="button-new-conv"
              className="p-1.5 rounded-lg hover:bg-secondary transition">
              <Plus className="w-4 h-4 text-muted-foreground" />
            </button>
            <button onClick={fetchConvs} className="p-1.5 rounded-lg hover:bg-secondary transition">
              <RefreshCw className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2 bg-[#ededed]">
          <div className="flex items-center gap-2 bg-white rounded-full px-3 py-1.5 border border-border">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar conversa..."
              data-testid="input-search-conv"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {search && <button onClick={() => setSearch("")}><X className="w-3 h-3 text-muted-foreground" /></button>}
          </div>
        </div>

        {/* Filters */}
        {showFilter && (
          <div className="px-3 py-2 bg-[#ededed] border-b border-border space-y-2">
            <div className="flex gap-1 flex-wrap">
              {(["all", "open", "pending", "resolved"] as StatusFilter[]).map((s) => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium transition border ${statusFilter === s ? "bg-primary text-white border-primary" : "bg-white border-border text-muted-foreground hover:bg-secondary"}`}>
                  {s === "all" ? "Todos" : STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="flex gap-1 flex-wrap">
              {LABELS_OPTIONS.slice(0, 4).map((l) => (
                <button key={l} onClick={() => setLabelFilter(labelFilter === l ? "" : l)}
                  className={`text-xs px-2 py-0.5 rounded-full transition border ${labelFilter === l ? "bg-primary/20 text-primary border-primary/30" : "bg-white border-border text-muted-foreground hover:bg-secondary"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loadingConvs ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
                <div className="w-10 h-10 rounded-full bg-secondary animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-secondary rounded animate-pulse w-3/4" />
                  <div className="h-2.5 bg-secondary rounded animate-pulse w-1/2" />
                </div>
              </div>
            ))
          ) : filteredConvs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <MessageCircle className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm">Nenhuma conversa</p>
            </div>
          ) : (
            filteredConvs.map((conv) => (
              <ConvItem key={conv.id} conv={conv} active={conv.id === activeId} onClick={() => setActiveId(conv.id)} />
            ))
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL: chat window ────────────────────────────────────── */}
      {!activeConv ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-[#f0f2f5]">
          <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-4">
            <MessageCircle className="w-10 h-10 opacity-30" />
          </div>
          <p className="font-semibold text-lg">Central de Atendimento</p>
          <p className="text-sm mt-1">Selecione uma conversa para começar</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div className="bg-[#ededed] border-b border-border px-4 py-2.5 flex items-center gap-3">
            <Avatar name={activeConv.name} size="md" />
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm text-foreground truncate">{activeConv.name}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {channelIcon(activeConv.channel)}
                <span>{activeConv.phone}</span>
                {activeConv.sector && (
                  <span className="px-1.5 py-0.5 rounded-full text-white font-medium" style={{ backgroundColor: activeConv.sector.color, fontSize: "10px" }}>
                    {activeConv.sector.name}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {/* Status quick-set */}
              <div className="relative">
                <button
                  onClick={() => setShowLabelPicker(false)}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-white border border-border hover:bg-secondary transition font-medium"
                  id="status-menu"
                >
                  <Circle className={`w-2 h-2 fill-current ${activeConv.status === "open" ? "text-green-500" : activeConv.status === "pending" ? "text-amber-500" : "text-gray-400"}`} />
                  {STATUS_LABELS[activeConv.status] ?? activeConv.status}
                  <ChevronDown className="w-3 h-3 ml-0.5" />
                </button>
                <div className="absolute right-0 top-9 bg-white border border-border rounded-xl shadow-lg z-20 overflow-hidden w-36" id="status-dropdown" style={{ display: "none" }}>
                  {["open", "pending", "resolved"].map((s) => (
                    <button key={s} onClick={() => handleStatus(s)}
                      className="w-full text-left flex items-center gap-2 text-xs px-3 py-2.5 hover:bg-secondary transition">
                      <Circle className={`w-2 h-2 fill-current ${s === "open" ? "text-green-500" : s === "pending" ? "text-amber-500" : "text-gray-400"}`} />
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
              {/* Labels */}
              <div className="relative">
                <button onClick={() => { setShowLabelPicker((v) => !v); setShowTransferPicker(false); }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-white border border-border hover:bg-secondary transition font-medium">
                  <Tag className="w-3 h-3" /> Etiquetas
                </button>
                {showLabelPicker && (
                  <div className="absolute right-0 top-9 bg-white border border-border rounded-xl shadow-lg z-20 p-2 min-w-[160px]">
                    {LABELS_OPTIONS.map((label) => (
                      <button key={label} onClick={() => handleLabel(label)}
                        className={`w-full text-left text-xs px-3 py-1.5 rounded-lg flex items-center gap-2 transition ${currentLabels.includes(label) ? "bg-primary/10 text-primary font-semibold" : "hover:bg-secondary text-foreground"}`}>
                        <span className={`w-2 h-2 rounded-full ${currentLabels.includes(label) ? "bg-primary" : "bg-gray-300"}`} />
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Transfer to sector */}
              <div className="relative">
                <button
                  onClick={() => { setShowTransferPicker((v) => !v); setShowLabelPicker(false); }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-white border border-border hover:bg-secondary transition font-medium"
                  title="Transferir para outro setor"
                >
                  <ArrowRightLeft className="w-3 h-3" /> Transferir
                </button>
                {showTransferPicker && (
                  <div className="absolute right-0 top-9 bg-white border border-border rounded-xl shadow-lg z-20 overflow-hidden min-w-[200px]">
                    <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground">
                      Transferir para:
                    </div>
                    {sectors
                      .filter((s) => s.id !== activeConv?.sectorId)
                      .map((s) => (
                        <button key={s.id} onClick={() => handleTransfer(s.id)}
                          className="w-full text-left flex items-center gap-2 text-xs px-3 py-2.5 hover:bg-secondary transition">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          {s.name}
                        </button>
                      ))}
                  </div>
                )}
              </div>
              {/* Status buttons */}
              {["open", "pending", "resolved"].map((s) => (
                <button key={s} onClick={() => handleStatus(s)}
                  className={`hidden sm:flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border transition font-medium ${activeConv.status === s ? "bg-primary text-white border-primary" : "bg-white border-border text-muted-foreground hover:bg-secondary"}`}>
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Label chips */}
          {currentLabels.length > 0 && (
            <div className="bg-white border-b border-border px-4 py-1.5 flex items-center gap-2 flex-wrap">
              {currentLabels.map((label) => (
                <span key={label} className="flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                  <Tag className="w-2.5 h-2.5" />{label}
                  <button onClick={() => handleLabel(label)} className="ml-0.5 opacity-60 hover:opacity-100"><X className="w-2.5 h-2.5" /></button>
                </span>
              ))}
            </div>
          )}

          {/* Messages area — WhatsApp wallpaper */}
          <div
            className="flex-1 overflow-y-auto px-4 py-4"
            style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect width='400' height='400' fill='%23e5ddd5'/%3E%3C/svg%3E\")", backgroundColor: "#e5ddd5" }}
          >
            {loadingMsgs ? (
              <div className="flex justify-center items-center h-20">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : messages.length === 0 ? (
              <div className="text-center text-xs text-muted-foreground py-8 bg-white/50 rounded-xl px-4">
                Nenhuma mensagem ainda. Inicie a conversa!
              </div>
            ) : (
              <>
                {messages.map((msg) => <MsgBubble key={msg.id} msg={msg} />)}
                <div ref={msgsEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <form onSubmit={handleSend} className="bg-[#f0f2f5] border-t border-border px-3 py-2.5 flex items-center gap-2">
            <input
              ref={inputRef}
              value={msgText}
              onChange={(e) => setMsgText(e.target.value)}
              placeholder="Digite uma mensagem..."
              data-testid="input-message"
              className="flex-1 bg-white rounded-full px-4 py-2 text-sm border border-border outline-none focus:ring-2 focus:ring-primary/20"
              disabled={sending}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
            />
            <button type="submit" disabled={!msgText.trim() || sending} data-testid="button-send-message"
              className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white hover:bg-primary/90 disabled:opacity-40 transition shrink-0">
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}

      {/* ── New conversation modal ─────────────────────────────────────── */}
      {showNewConv && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">Nova Conversa</h3>
              <button onClick={() => setShowNewConv(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome *</label>
                <input required value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
                  placeholder="Nome do contato"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">WhatsApp / Telefone *</label>
                <input required value={newForm.phone} onChange={(e) => setNewForm({ ...newForm, phone: e.target.value })}
                  placeholder="33 99999-0000"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Canal</label>
                <select value={newForm.channel} onChange={(e) => setNewForm({ ...newForm, channel: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                  <option value="manual">Manual</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Setor</label>
                <select value={newForm.sectorId} onChange={(e) => setNewForm({ ...newForm, sectorId: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  <option value="">— Padrão —</option>
                  {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowNewConv(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">Cancelar</button>
                <button type="submit" data-testid="button-confirm-new-conv"
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition">Criar</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
