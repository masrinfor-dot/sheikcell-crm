import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { api, can, type Conversation, type ChatMessage, type Sector, type ChatLabel, type User, type CrmContact, type CrmCustomField, type QuickReply, type ScheduledMessage, type ChatNotification, type Store as StoreType, type OutboundUsage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Search, Plus, Send, RefreshCw, X, ChevronDown, SpellCheck,
  MessageCircle, CheckCheck, AlertCircle, Tag, Filter,
  Smartphone, Instagram, UserCircle2, Circle,
  ArrowRightLeft, FileText, Volume2, Image, Video, Mic, Users, Paperclip, IdCard,
  Settings2, Trash2, Info, Sparkles, Check, Bell, BellOff, VolumeX, Zap, CalendarClock, AlertTriangle,
  Pin, PinOff, Reply, StickyNote
} from "lucide-react";
import CrmContactDetail from "@/components/CrmContactDetail";

// ─── Types ─────────────────────────────────────────────────────────────────
// Cores sugeridas para novas etiquetas
const LABEL_COLOR_PRESETS = ["#1a2e6e", "#f59e0b", "#16a34a", "#dc2626", "#8b5cf6", "#0891b2", "#db2777", "#6b7280"];
const STATUS_COLORS: Record<string, string> = {
  open: "bg-green-500", pending: "bg-amber-400", resolved: "bg-gray-400",
};
const STATUS_LABELS: Record<string, string> = {
  open: "Aberto", pending: "Pendente", resolved: "Resolvido",
};

// Motivos pré-definidos para finalizar (resolver) um atendimento. "Outro"
// libera um campo de texto para o vendedor detalhar.
const FINALIZE_REASONS = [
  "Venda realizada",
  "Orçamento enviado",
  "Cliente vai pensar",
  "Sem interesse",
  "Sem resposta do cliente",
  "Dúvida esclarecida",
  "Problema resolvido",
  "Outro",
] as const;

// ─── Atendimento categories ──────────────────────────────────────────────────
// POTENCIAIS: números novos aguardando triagem (futura inteligência artificial)
// PENDENTES: já filtrados, aguardando na fila de atendimento
// ATIVOS: já em atendimento por um vendedor (possuem responsável)
type Category = "potenciais" | "pendentes" | "ativos" | "resolvidas";
const CATEGORIES: { id: Category; label: string; help: string; color: string }[] = [
  { id: "resolvidas", label: "Resolvidas", help: "Atendimentos finalizados", color: "#6b7280" },
  { id: "ativos", label: "Ativos", help: "Em atendimento pelos vendedores", color: "#16a34a" },
  { id: "pendentes", label: "Pendentes", help: "Já filtrados, na fila de atendimento", color: "#f59e0b" },
  { id: "potenciais", label: "Potenciais", help: "Números novos — serão triados pela IA", color: "#8b5cf6" },
];

function conversationCategory(c: Conversation): Category {
  if (c.isArchived || c.status === "resolved" || c.status === "archived") return "resolvidas";
  if (c.assigneeId != null) return "ativos";
  if (c.status === "pending") return "pendentes";
  return "potenciais"; // novos / abertos sem responsável
}

// Mirrors the server-side scoping: admins/supervisors see everything, vendedores
// see their own sector plus any "potencial" (new, unclaimed lead) from any sector.
// Conversa "restrita" = já tem responsável (ativa) ou foi finalizada.
// Essas só ficam visíveis para o vendedor responsável/participantes, o admin
// e o supervisor do mesmo setor (espelha a regra do servidor).
function isRestrictedConv(c: Conversation): boolean {
  return c.assigneeId != null || c.isArchived === true
    || c.status === "resolved" || c.status === "archived";
}

function isVisibleToMe(c: Conversation, user: User | null): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "supervisor") {
    // Supervisor com setor: só o próprio setor + potenciais (sem setor = global).
    if (user.sectorId == null || c.sectorId === user.sectorId) return true;
    return conversationCategory(c) === "potenciais";
  }
  if (isRestrictedConv(c)) {
    if (c.assigneeId === user.id) return true;
    // Eventos SSE trazem a linha crua (sem participants); nesse caso não dá
    // para decidir aqui — o chamador deve mesclar com o estado local antes.
    return (c.participants ?? []).some((p) => p.id === user.id);
  }
  if (c.sectorId === user.sectorId) return true;
  return conversationCategory(c) === "potenciais";
}

// A notice surfaced in the notification bell, in arrival order:
// - "message": mensagem recebida do cliente
// - "retorno": chegou a hora do retorno ao cliente agendado
// - "failed": uma mensagem agendada falhou no envio
type MsgNotification = {
  id: string;
  conversationId: number;
  convName: string;
  preview: string;
  createdAt: string;
  read: boolean;
  kind?: "message" | "retorno" | "failed";
};

// Grupos e comunidades do WhatsApp: o campo "phone" guarda o JID do grupo.
function isGroupConv(c: { phone: string }) {
  return c.phone.includes("@g.us");
}

function channelIcon(ch: string, group?: boolean) {
  if (group) return <Users className="w-3 h-3 text-green-600" />;
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
function Avatar({ name, src, size = "md" }: { name: string; src?: string | null; size?: "sm" | "md" | "lg" }) {
  const [imgError, setImgError] = useState(false);
  const initials = name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const colors = ["bg-blue-500", "bg-purple-500", "bg-green-500", "bg-orange-500", "bg-pink-500", "bg-teal-500"];
  const color = colors[name.charCodeAt(0) % colors.length];
  const sz = size === "sm" ? "w-8 h-8 text-xs" : size === "lg" ? "w-12 h-12 text-base" : "w-10 h-10 text-sm";
  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setImgError(true)}
        className={`${sz} rounded-full object-cover shrink-0`}
      />
    );
  }
  return (
    <div className={`${sz} ${color} rounded-full flex items-center justify-center text-white font-bold shrink-0`}>
      {initials || <UserCircle2 className="w-5 h-5" />}
    </div>
  );
}

// Conexão de WhatsApp (número de atendimento) — usada para etiquetar de qual
// número a conversa está chegando quando há mais de uma conexão pareada.
type WaSessionInfo = { sessionKey: string; displayName: string | null; phoneNumber: string | null };

function waSessionLabel(key: string, sessions: WaSessionInfo[]): string {
  const s = sessions.find((x) => x.sessionKey === key);
  if (s?.displayName) return s.displayName;
  if (s?.phoneNumber) return s.phoneNumber.replace(/@.*$/, "");
  return key === "default" ? "Principal" : key;
}

// ─── Conversation list item ─────────────────────────────────────────────────
function ConvItem({ conv, active, onClick, sessionBadge, overdue }: { conv: Conversation; active: boolean; onClick: () => void; sessionBadge?: string | null; overdue?: boolean }) {
  return (
    <button
      onClick={onClick}
      data-testid={`conv-item-${conv.id}`}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/60 transition border-b border-border/50 ${active ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
    >
      <div className="relative shrink-0">
        <Avatar name={conv.name} src={conv.avatarUrl} size="md" />
        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${STATUS_COLORS[conv.status] ?? "bg-gray-300"}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className="font-semibold text-sm text-foreground truncate flex items-center gap-1">
            {conv.pinned && <Pin className="w-3 h-3 text-primary shrink-0 rotate-45" data-testid={`pin-indicator-${conv.id}`} />}
            {conv.name}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">{timeAgo(conv.lastMessageAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-1">
          <p className="text-xs text-muted-foreground truncate flex-1">{conv.lastMessage ?? "Sem mensagens"}</p>
          <div className="flex items-center gap-1 shrink-0">
            {overdue && (
              <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-bold animate-pulse" title="Cliente aguardando resposta há mais tempo que o limite">
                ⚠ sem resposta
              </span>
            )}
            {sessionBadge && (
              <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-semibold truncate max-w-[90px]" title={`Recebida pelo número: ${sessionBadge}`}>
                {sessionBadge}
              </span>
            )}
            {channelIcon(conv.channel, isGroupConv(conv))}
            {conv.unreadCount > 0 && (
              <span className="bg-green-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-bold">
                {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
              </span>
            )}
          </div>
        </div>
        {conv.assignee && (
          <div className="flex items-center gap-1 mt-1">
            <UserCircle2 className="w-3 h-3 text-indigo-500 shrink-0" />
            <span className="text-[10px] text-indigo-600 font-medium truncate" data-testid={`conv-assignee-${conv.id}`} title={`Atendido por ${conv.assignee.name}`}>
              {conv.assignee.name}
            </span>
          </div>
        )}
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

// ─── Media content ────────────────────────────────────────────────────────
function MediaContent({ msg }: { msg: ChatMessage }) {
  if (!msg.mediaUrl) return null;

  if (msg.type === "audio") {
    return <AudioBubble msg={msg} />;
  }

  return <MediaContentRest msg={msg} />;
}

/** Áudio com botão de transcrição (Whisper). */
function AudioBubble({ msg }: { msg: ChatMessage }) {
  const [local, setLocal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const transcript = msg.transcript ?? local;

  const handleTranscribe = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.chat.transcribe(msg.id);
      setLocal(r.transcript);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Falha ao transcrever");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 bg-black/5 rounded-xl px-3 py-2 min-w-[200px]">
        <Volume2 className="w-4 h-4 text-primary shrink-0" />
        <audio controls className="flex-1 h-8 max-w-[200px]" style={{ minWidth: 0 }}>
          <source src={msg.mediaUrl ?? undefined} />
        </audio>
      </div>
      {transcript ? (
        <p className="text-xs mt-1 bg-black/5 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap" data-testid={`text-transcript-${msg.id}`}>
          📝 {transcript}
        </p>
      ) : (
        <button onClick={handleTranscribe} disabled={busy} data-testid={`button-transcribe-${msg.id}`}
          className="text-[11px] font-semibold text-primary underline mt-0.5 disabled:opacity-60">
          {busy ? "Transcrevendo…" : "📝 Transcrever áudio"}
        </button>
      )}
      {err && <p className="text-[11px] text-red-600 mt-0.5">{err}</p>}
    </div>
  );
}

function MediaContentRest({ msg }: { msg: ChatMessage }) {
  if (!msg.mediaUrl) return null;

  if (msg.type === "image") {
    return (
      <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="block mb-1">
        <img
          src={msg.mediaUrl}
          alt="Foto"
          className="max-w-full rounded-xl object-cover max-h-64 cursor-pointer hover:opacity-90 transition"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      </a>
    );
  }

  if (msg.type === "sticker") {
    return (
      <img
        src={msg.mediaUrl}
        alt="Figurinha"
        className="w-32 h-32 object-contain mb-1"
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }

  if (msg.type === "video") {
    return (
      <video
        controls
        preload="metadata"
        className="max-w-full rounded-xl max-h-64 mb-1 bg-black"
        style={{ minWidth: 200 }}
      >
        <source src={msg.mediaUrl} />
      </video>
    );
  }

  if (msg.type === "doc") {
    const filename = msg.mediaUrl.split("/").pop() ?? "documento";
    return (
      <a
        href={msg.mediaUrl}
        target="_blank"
        rel="noopener noreferrer"
        download
        className="flex items-center gap-2 mb-1 bg-black/5 rounded-xl px-3 py-2 hover:bg-black/10 transition"
      >
        <FileText className="w-5 h-5 text-primary shrink-0" />
        <span className="text-xs text-gray-700 break-all">{filename}</span>
      </a>
    );
  }

  return null;
}

// Known placeholder labels that are not captions
const MEDIA_PLACEHOLDERS = new Set(["📷 Foto", "🎵 Áudio", "🎥 Vídeo", "🎤 Áudio"]);
function isMediaPlaceholder(s: string) {
  return MEDIA_PLACEHOLDERS.has(s) || s.startsWith("📄 ");
}

// Extract caption from media message content.
// Supports two formats:
//   1. Outbound (new): "📷 Foto\ncaption" or "📄 file.pdf\ncaption" — extract after newline
//   2. Inbound (WhatsApp): content IS the caption (not a known placeholder)
function extractMediaCaption(content: string): string {
  const nl = content.indexOf("\n");
  if (nl !== -1) {
    return content.slice(nl + 1).trim();
  }
  return isMediaPlaceholder(content) ? "" : content.trim();
}

// ─── Message bubble ─────────────────────────────────────────────────────────
function MsgBubble({ msg, onReply, highlighted, onJumpTo }: {
  msg: ChatMessage;
  onReply: (m: ChatMessage) => void;
  highlighted: boolean;
  onJumpTo: (id: number) => void;
}) {
  const out = msg.direction === "outbound";
  const isMedia = msg.type === "image" || msg.type === "video" || msg.type === "audio" || msg.type === "doc" || msg.type === "sticker";
  const mediaCaption = isMedia ? extractMediaCaption(msg.content) : "";
  const showCaption = isMedia && msg.mediaUrl && mediaCaption.length > 0;

  // Nota interna: nunca vai pro cliente — estilo bem diferente das mensagens
  // (centralizada, âmbar) pra nunca confundir uma com a outra.
  if (msg.type === "note") {
    return (
      <div
        id={`chat-msg-${msg.id}`}
        className={`flex justify-center mb-1 transition-colors duration-500 rounded-lg ${highlighted ? "bg-amber-200/60" : ""}`}
      >
        <div className="max-w-[85%] rounded-xl px-3 py-2 shadow-sm bg-amber-50 border border-amber-300" data-testid={`note-${msg.id}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <StickyNote className="w-3.5 h-3.5 text-amber-700 shrink-0" />
            <span className="text-xs font-semibold text-amber-800">{msg.senderName ?? "Equipe"}</span>
            <span className="text-[10px] text-amber-700/70">· nota interna</span>
          </div>
          <p className="text-sm text-amber-900 whitespace-pre-wrap break-words">{msg.content}</p>
          <div className="text-right mt-1">
            <span className="text-[11px] text-amber-700/70">{msgTime(msg.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }

  const replyButton = (
    <button
      onClick={() => onReply(msg)}
      data-testid={`button-reply-msg-${msg.id}`}
      title="Responder mensagem"
      className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-full text-gray-500 hover:text-primary hover:bg-black/5 shrink-0"
    >
      <Reply className="w-3.5 h-3.5" />
    </button>
  );

  return (
    <div
      id={`chat-msg-${msg.id}`}
      className={`group flex items-center gap-1 mb-1 transition-colors duration-500 rounded-lg ${out ? "justify-end" : "justify-start"} ${highlighted ? "bg-amber-200/60" : ""}`}
    >
      {out && replyButton}
      <div className={`max-w-[75%] rounded-2xl px-3 py-2 shadow-sm ${out ? "bg-[#dcf8c6] rounded-br-sm" : "bg-white rounded-bl-sm border border-border"}`}>
        {!out && msg.senderName && (
          <p className="text-xs font-semibold text-primary mb-1">{msg.senderName}</p>
        )}
        {msg.replyTo && (
          <button
            onClick={() => onJumpTo(msg.replyTo!.id)}
            data-testid={`button-jump-reply-${msg.id}`}
            className="block w-full text-left mb-1 rounded-lg px-2 py-1 border-l-4 border-primary/50 bg-black/5 truncate"
          >
            <div className="text-[11px] font-semibold text-primary">{msg.replyTo.senderName ?? "Cliente"}</div>
            <div className="text-xs text-gray-600 truncate">{msg.replyTo.content}</div>
          </button>
        )}
        {isMedia && msg.mediaUrl ? (
          <>
            <MediaContent msg={msg} />
            {showCaption && (
              <p className="text-sm text-gray-800 whitespace-pre-wrap break-words mt-1">{mediaCaption}</p>
            )}
          </>
        ) : isMedia && !msg.mediaUrl ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 italic">
            {msg.type === "image" && <Image className="w-4 h-4 shrink-0" />}
            {msg.type === "video" && <Video className="w-4 h-4 shrink-0" />}
            {msg.type === "audio" && <Volume2 className="w-4 h-4 shrink-0" />}
            {msg.type === "doc" && <FileText className="w-4 h-4 shrink-0" />}
            {msg.type === "sticker" && <Image className="w-4 h-4 shrink-0" />}
            <span>{msg.content}</span>
          </div>
        ) : (
          <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{msg.content}</p>
        )}
        {!!msg.reactions?.length && (
          <div className={`flex flex-wrap gap-1 mt-1 ${out ? "justify-end" : "justify-start"}`}>
            {msg.reactions.map((r, i) => (
              <span key={i} className="text-xs bg-black/5 rounded-full px-1.5 py-0.5" title={r.senderName ?? undefined}>
                {r.emoji}
              </span>
            ))}
          </div>
        )}
        <div className={`flex items-center gap-1 mt-1 ${out ? "justify-end" : "justify-start"}`}>
          {msg.editedAt && <span className="text-[11px] text-gray-400 italic">editado</span>}
          <span className="text-xs text-gray-500">{msgTime(msg.createdAt)}</span>
          {out && (
            msg.status === "failed" ? (
              <span className="flex items-center gap-0.5 text-[11px] text-red-500" title="Falha no envio — WhatsApp não conectado ou número inválido">
                <AlertCircle className="w-3 h-3" />
                Não entregue
              </span>
            ) : (
              <CheckCheck className={`w-3 h-3 ${msg.status === "read" ? "text-blue-500" : "text-gray-400"}`} />
            )
          )}
        </div>
      </div>
      {!out && replyButton}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
// hint: Logic changed on both sides. Requires understanding intent of each change.
export default function ChatCenter() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [convs, setConvs] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category>("pendentes");
  const [labelFilter, setLabelFilter] = useState("");
  const [msgText, setMsgText] = useState("");
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [composerMode, setComposerMode] = useState<"message" | "note">("message");
  const [highlightedMsgId, setHighlightedMsgId] = useState<number | null>(null);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [showNewConv, setShowNewConv] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [labels, setLabels] = useState<ChatLabel[]>([]);
  const [showLabelManager, setShowLabelManager] = useState(false);
  const [labelForm, setLabelForm] = useState<{ name: string; color: string }>({ name: "", color: LABEL_COLOR_PRESETS[0] });
  const [savingLabel, setSavingLabel] = useState(false);
  const [showTransferPicker, setShowTransferPicker] = useState(false);
  const [showParticipantPicker, setShowParticipantPicker] = useState(false);
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);
  // Filtros avançados da lista: vendedor, setor e nível do cliente no CRM.
  const [filterVendedor, setFilterVendedor] = useState("");
  const [filterSetor, setFilterSetor] = useState("");
  const [filterNivel, setFilterNivel] = useState("");
  // Alerta de atendimento sem resposta (configurável por admin/supervisor).
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [alertMinutes, setAlertMinutes] = useState(5);
  // Conversas estouradas silenciadas manualmente (o alarme fixo some até
  // aparecer coisa nova). Limpa quando a conversa é respondida.
  const [alarmMuted, setAlarmMuted] = useState<Set<number>>(new Set());
  // Modal de configuração do alerta (ligar/desligar + minutos).
  const [showAlertCfg, setShowAlertCfg] = useState(false);
  const [cfgMinutes, setCfgMinutes] = useState(5);
  const [cfgEnabled, setCfgEnabled] = useState(true);
  const [savingAlertCfg, setSavingAlertCfg] = useState(false);
  // Trava anti-disparo em massa do Atendimento ativo (mesmo modal de config).
  const [cfgOutboundHourly, setCfgOutboundHourly] = useState(10);
  const [cfgOutboundDaily, setCfgOutboundDaily] = useState(40);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const alertedRef = useRef<Set<number>>(new Set());
  // Finalizar atendimento: modal para capturar o motivo da finalização.
  const [finalizeTarget, setFinalizeTarget] = useState<number | null>(null);
  const [finalizeReason, setFinalizeReason] = useState<string>(FINALIZE_REASONS[0]);
  const [finalizeDetail, setFinalizeDetail] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  // Venda no atendimento: informada ao finalizar e lançada no CRM do cliente.
  const [finalizeHadSale, setFinalizeHadSale] = useState<boolean | null>(null);
  const [finalizeSaleAmount, setFinalizeSaleAmount] = useState("");
  const [finalizeSaleDesc, setFinalizeSaleDesc] = useState("");
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [chatUsers, setChatUsers] = useState<{ id: number; name: string; role: string; sectorId?: number | null }[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [quickSearch, setQuickSearch] = useState("");
  // Confirmação explícita ao promover uma conversa PARA FORA de "Potenciais"
  // (vira Pendente ou Ativo) — evita puxar um lead pra fila/atendimento sem querer.
  // Pendente → Ativo (pegar da fila) não passa por aqui: é o fluxo normal.
  const [promoteConfirm, setPromoteConfirm] = useState<{ id: number; name: string; to: "pendentes" | "ativos" } | null>(null);
  // Agendamentos: mensagem programada ou lembrete de retorno (vira tarefa no quadro)
  const [showSchedule, setShowSchedule] = useState(false);
  const [schedules, setSchedules] = useState<ScheduledMessage[]>([]);
  const [schedForm, setSchedForm] = useState<{ kind: "mensagem" | "retorno"; content: string; sendAt: string }>({ kind: "mensagem", content: "", sendAt: "" });
  const [schedSaving, setSchedSaving] = useState(false);
  const [waSessions, setWaSessions] = useState<WaSessionInfo[]>([]);
  const [newForm, setNewForm] = useState({ name: "", phone: "", channel: "whatsapp", sectorId: "", assigneeId: "" });
  // Uso atual da trava anti-disparo em massa (Atendimento ativo), consultado
  // ao abrir o modal de Nova Conversa — mostra o risco ANTES de tentar criar.
  const [outboundUsage, setOutboundUsage] = useState<OutboundUsage | null>(null);

  const [filePreview, setFilePreview] = useState<{ file: File; previewUrl: string | null } | null>(null);
  const [caption, setCaption] = useState("");

  // CRM connection: contact opened from the active conversation
  const [crmContactId, setCrmContactId] = useState<number | null>(null);
  const [crmLoading, setCrmLoading] = useState(false);

  // Informações side panel: view/edit the linked CRM contact next to the chat
  const [showInfo, setShowInfo] = useState(false);
  const [infoContact, setInfoContact] = useState<CrmContact | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoSaving, setInfoSaving] = useState(false);
  const [infoForm, setInfoForm] = useState({ name: "", city: "", serviceStore: "", attendanceSource: "", notes: "" });
  const [infoCustomValues, setInfoCustomValues] = useState<Record<string, string>>({});
  const [customDefs, setCustomDefs] = useState<CrmCustomField[]>([]);
  // Lojas da rede (select "Loja para atendimento")
  const [storesList, setStoresList] = useState<StoreType[]>([]);
  useEffect(() => { api.stores.list().then(setStoresList).catch(() => {}); }, []);

  // AI reply suggestion in the composer
  const [suggesting, setSuggesting] = useState(false);
  const [correcting, setCorrecting] = useState(false);

  // Notification bell: inbound messages accumulated in arrival order
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<MsgNotification[]>([]);
  // Espelho para ler o estado atual dentro de efeitos sem re-assinar.
  const notificationsRef = useRef<MsgNotification[]>([]);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);
  // Posição do painel de notificações (portal): ancora no sino no desktop.
  const bellBtnRef = useRef<HTMLButtonElement | null>(null);
  const [notifPanelPos, setNotifPanelPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!showNotifications) { setNotifPanelPos(null); return; }
    const place = () => {
      // Só no desktop (no celular o painel ocupa a largura da tela via CSS).
      if (window.innerWidth < 768 || !bellBtnRef.current) { setNotifPanelPos(null); return; }
      const r = bellBtnRef.current.getBoundingClientRect();
      const width = 384; // md:w-96
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setNotifPanelPos({ left, top: r.bottom + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNotifications]);

  // Alert preferences: play a sound and/or show a native browser notification for
  // inbound messages even when the attendant is on another tab. Persisted locally.
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem("chat.alertSound") !== "off"; } catch { return true; }
  });
  const [desktopEnabled, setDesktopEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem("chat.alertDesktop") === "on"; } catch { return false; }
  });
  const soundEnabledRef = useRef(soundEnabled);
  const desktopEnabledRef = useRef(desktopEnabled);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    try { localStorage.setItem("chat.alertSound", soundEnabled ? "on" : "off"); } catch { /* ignore */ }
  }, [soundEnabled]);
  useEffect(() => {
    desktopEnabledRef.current = desktopEnabled;
    try { localStorage.setItem("chat.alertDesktop", desktopEnabled ? "on" : "off"); } catch { /* ignore */ }
  }, [desktopEnabled]);

  // Sons sintetizados via Web Audio (sem arquivos). Cada área tem um toque
  // diferente e mais chamativo que o bipe de mensagem nova:
  //  - msg: bipe curto de mensagem nova (como antes)
  //  - potenciais: sirene urgente alternando agudo/grave (cliente novo esperando!)
  //  - pendentes: três toques subindo
  //  - ativos: dois toques graves
  const playAlertSound = useCallback((kind: "msg" | "potenciais" | "pendentes" | "ativos" = "msg") => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      let ctx = audioCtxRef.current;
      if (!ctx) { ctx = new Ctx(); audioCtxRef.current = ctx; }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const patterns: Record<string, { wave: OscillatorType; vol: number; notes: [number, number][] }> = {
        msg: { wave: "sine", vol: 0.15, notes: [[880, 0.12], [660, 0.24]] },
        potenciais: { wave: "square", vol: 0.22, notes: [[988, 0.18], [740, 0.18], [988, 0.18], [740, 0.18], [1175, 0.3]] },
        pendentes: { wave: "triangle", vol: 0.25, notes: [[659, 0.16], [831, 0.16], [1046, 0.32]] },
        ativos: { wave: "sine", vol: 0.25, notes: [[523, 0.2], [392, 0.3]] },
      };
      const p = patterns[kind] ?? patterns.msg!;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = p.wave;
      let t = now;
      let total = 0;
      for (const [freq, dur] of p.notes) {
        osc.frequency.setValueAtTime(freq, t);
        t += dur;
        total += dur;
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(p.vol, now + 0.02);
      gain.gain.setValueAtTime(p.vol, now + total - 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + total);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + total + 0.02);
    } catch { /* ignore */ }
  }, []);

  const showDesktopNotification = useCallback((title: string, body: string, conversationId: number) => {
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const n = new Notification(title, { body: body || "Nova mensagem", tag: `conv-${conversationId}`, icon: "/favicon.ico" });
      n.onclick = () => { window.focus(); setActiveId(conversationId); setShowNotifications(false); n.close(); };
    } catch { /* ignore */ }
  }, []);

  // Toggle desktop notifications, requesting browser permission on enable.
  const toggleDesktop = useCallback(async () => {
    if (desktopEnabled) { setDesktopEnabled(false); return; }
    if (!("Notification" in window)) {
      toast({ title: "Notificações não suportadas neste navegador", variant: "destructive" });
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { /* ignore */ } }
    if (perm === "granted") setDesktopEnabled(true);
    else toast({ title: "Permissão de notificação negada pelo navegador", variant: "destructive" });
  }, [desktopEnabled, toast]);

  const msgsEndRef = useRef<HTMLDivElement>(null);
  const msgsContainerRef = useRef<HTMLDivElement>(null);
  // Sempre reflete a conversa aberta AGORA — usado para descartar respostas de
  // paginação que chegam depois de trocar de conversa.
  const activeIdRef = useRef<number | null>(null);
  // Ao prependar mensagens antigas, NÃO rolar para o fim — preservar a posição.
  const skipAutoScrollRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Latest conversations, read from inside the SSE handler without re-subscribing.
  const convsRef = useRef<Conversation[]>([]);
  // Inbound messages that arrived before their conversation was loaded (real-time
  // event ordering). Buffered by conversationId and resolved into notifications
  // once the matching conversation_new event arrives (respecting visible scope),
  // so the first message of a brand-new contact is never silently dropped.
  const pendingNotifsRef = useRef<Map<number, MsgNotification[]>>(new Map());
  // Guards the one-time refetch that closes the initial-load race between the
  // REST fetch and the SSE subscriber being registered server-side. Only the
  // very first stream `open` triggers it; reconnects are covered by replay/resync.
  const initialSyncedRef = useRef(false);

  // ── Gravação de áudio (nota de voz, igual WhatsApp) ──
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Decide no stop se a gravação vira envio ou é descartada.
  const recordSendRef = useRef(false);

  const activeConv = convs.find((c) => c.id === activeId) ?? null;
  const unreadNotifications = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);

  // Avisos persistidos (retorno vencido / falha de envio agendado): carregados
  // do servidor ao abrir a Central, para que nada se perca se o vendedor
  // estava offline quando o aviso venceu. O id espelha o formato dos eventos
  // SSE ("sched-<kind>-<scheduledId>"), então o merge nunca duplica.
  useEffect(() => {
    api.chat.notifications.unread()
      .then((rows: ChatNotification[]) => {
        if (!rows.length) return;
        const mapped: MsgNotification[] = rows.map((r) => ({
          id: r.scheduledId != null ? `sched-${r.kind}-${r.scheduledId}` : `sched-db-${r.id}`,
          conversationId: r.conversationId,
          convName: r.convName || "Cliente",
          preview: r.content,
          createdAt: r.createdAt,
          read: false,
          kind: r.kind,
        }));
        setNotifications((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          const fresh = mapped.filter((n) => !seen.has(n.id));
          return fresh.length ? [...fresh, ...prev].slice(0, 100) : prev;
        });
      })
      .catch(() => { /* silencioso: o sino segue funcionando só com o SSE */ });
  }, []);

  // Persiste a leitura no servidor quando um aviso de agendamento é lido —
  // sem isso, ele voltaria como "não lido" na próxima abertura da Central.
  const persistScheduleReads = useCallback((list: MsgNotification[], conversationId?: number) => {
    const hasSched = list.some((n) => !n.read
      && (n.kind === "retorno" || n.kind === "failed")
      && (conversationId == null || n.conversationId === conversationId));
    if (hasSched) api.chat.notifications.markRead(conversationId).catch(() => {});
  }, []);

  // Open the conversation behind a notification and mark its notices read.
  const openNotification = (n: MsgNotification) => {
    // If the conversation is no longer visible/loaded (e.g. reassigned out of
    // scope), just clear its stale notices instead of trying to open it.
    const stillVisible = convs.some((c) => c.id === n.conversationId);
    persistScheduleReads(notifications, n.conversationId);
    setNotifications((prev) =>
      stillVisible
        ? prev.map((x) => x.conversationId === n.conversationId ? { ...x, read: true } : x)
        : prev.filter((x) => x.conversationId !== n.conversationId)
    );
    if (stillVisible) setActiveId(n.conversationId);
    setShowNotifications(false);
  };
  const markAllNotificationsRead = () => {
    persistScheduleReads(notifications);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  // ── Fetch conversations ──
  const fetchConvs = useCallback(async () => {
    try {
      const params: Parameters<typeof api.chat.conversations>[0] = {};
      if (search) params.search = search;
      if (labelFilter) params.label = labelFilter;
      const data = await api.chat.conversations(params);
      setConvs(data);
    } catch { /* silent */ } finally { setLoadingConvs(false); }
  }, [search, labelFilter]);

  // ── Fetch messages ──
  const fetchMsgs = useCallback(async (id: number) => {
    setLoadingMsgs(true);
    try {
      const { messages: data, hasMore } = await api.chat.messagesPage(id);
      if (activeIdRef.current !== id) return; // trocou de conversa no meio
      setMessages(data);
      setHasMoreOlder(hasMore);
      setConvs((prev) => prev.map((c) => c.id === id ? { ...c, unreadCount: 0 } : c));
    } catch { /* silent */ } finally { setLoadingMsgs(false); }
  }, []);

  // ── Load older messages (cursor pagination) ──
  const loadOlderMsgs = useCallback(async () => {
    const id = activeId;
    const oldest = messages[0];
    if (id == null || !oldest || loadingOlder) return;
    setLoadingOlder(true);
    // Preserva a posição do scroll: mede a altura antes, ajusta depois.
    const el = msgsContainerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const { messages: older, hasMore } = await api.chat.messagesPage(id, oldest.id);
      // Trocou de conversa enquanto a página carregava? Descarta a resposta —
      // o ref reflete a conversa aberta AGORA (o closure ficaria desatualizado).
      if (activeIdRef.current !== id) return;
      skipAutoScrollRef.current = true;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHasMoreOlder(hasMore);
      requestAnimationFrame(() => {
        if (activeIdRef.current !== id) return;
        const node = msgsContainerRef.current;
        if (node) node.scrollTop = node.scrollHeight - prevHeight + prevTop;
      });
    } catch { /* silent */ } finally { setLoadingOlder(false); }
  }, [activeId, messages, loadingOlder]);

  useEffect(() => { fetchConvs(); }, [fetchConvs]);

  useEffect(() => { convsRef.current = convs; }, [convs]);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => {
    if (activeId) { fetchMsgs(activeId); inputRef.current?.focus(); }
  }, [activeId, fetchMsgs]);

  // Opening a conversation clears its notification notices.
  useEffect(() => {
    if (activeId == null) return;
    // Só avisos de MENSAGEM são lidos automaticamente ao abrir a conversa.
    // Avisos de agendamento (retorno/falha) exigem clique explícito no sino:
    // marcar aqui poderia dar baixa no servidor antes de o vendedor sequer
    // ver o aviso (ex.: a conversa já estava restaurada como ativa ao abrir).
    const isMsgNotice = (n: MsgNotification) => n.kind == null || n.kind === "message";
    if (notificationsRef.current.some((n) => n.conversationId === activeId && !n.read && isMsgNotice(n))) {
      setNotifications((prev) => prev.map((n) =>
        n.conversationId === activeId && isMsgNotice(n) ? { ...n, read: true } : n));
    }
  }, [activeId]);

  useEffect(() => {
    if (skipAutoScrollRef.current) { skipAutoScrollRef.current = false; return; }
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── SSE real-time ──
  useEffect(() => {
    const es = new EventSource("/api/chat/events", { withCredentials: true });
    // Close the initial-load race: a message can arrive after the REST fetch
    // snapshot but before the SSE subscriber is registered server-side, landing
    // in neither the fetch nor the stream. Once the stream is actually open
    // (subscriber registered), do a one-time refetch to pull anything that
    // slipped through the gap. A brand-new connection gets no replay, so this
    // never duplicates messages or bell notifications; subsequent reconnects are
    // handled by replay/resync, so the guard keeps this to the very first open.
    es.addEventListener("open", () => {
      if (initialSyncedRef.current) return;
      initialSyncedRef.current = true;
      fetchConvs();
      if (activeId != null) fetchMsgs(activeId);
    });
    es.addEventListener("message_updated", (e) => {
      try {
        const { conversationId, message } = JSON.parse(e.data) as { conversationId: number; message: ChatMessage };
        if (conversationId === activeId) {
          setMessages((prev) => prev.map((m) => m.id === message.id ? message : m));
        }
        setConvs((prev) => prev.map((c) =>
          c.id === conversationId && c.lastMessageAt === message.createdAt
            ? { ...c, lastMessage: message.content }
            : c
        ));
      } catch { /* ignore malformed event */ }
    });

    es.addEventListener("message", (e) => {
      try {
        const { conversationId, message } = JSON.parse(e.data) as { conversationId: number; message: ChatMessage };
        if (conversationId === activeId) {
          // Evita duplicar: quem enviou já recebe a mensagem pela resposta do
          // POST, e o SSE também entrega para o próprio remetente. Se a
          // mensagem real chegar via SSE antes do POST responder, remove a
          // bolha provisória (id negativo) para não aparecer em dobro.
          setMessages((prev) => {
            if (prev.some((m) => m.id === message.id)) return prev;
            const base = message.direction === "outbound" ? prev.filter((m) => m.id >= 0) : prev;
            return [...base, message];
          });
        }
        setConvs((prev) => prev.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: message.content, lastMessageDirection: message.direction, lastMessageAt: message.createdAt, unreadCount: conversationId === activeId ? 0 : c.unreadCount + 1 }
            : c
        ));
        // Surface received (inbound) messages in the notification bell, in arrival
        // order, respecting the attendant's visible-conversation scope. Messages for
        // the conversation already open are counted as already read.
        if (message.direction === "inbound") {
          const conv = convsRef.current.find((c) => c.id === conversationId);
          const notif: MsgNotification = {
            id: `${conversationId}-${message.id}-${message.createdAt}`,
            conversationId,
            convName: conv?.name ?? "",
            preview: message.content,
            createdAt: message.createdAt,
            read: conversationId === activeId,
          };
          if (!conv) {
            // The conversation hasn't loaded yet (e.g. first message of a brand-new
            // contact arriving before conversation_new). Buffer the notice so it can
            // be resolved once the conversation appears, instead of dropping it.
            const map = pendingNotifsRef.current;
            const list = map.get(conversationId) ?? [];
            map.set(conversationId, [...list, notif].slice(-20));
            // Bound the buffer so out-of-scope conversations that never arrive can't
            // grow it without limit; drop the oldest pending conversation.
            if (map.size > 50) {
              const oldest = map.keys().next().value;
              if (oldest !== undefined) map.delete(oldest);
            }
          } else if (isVisibleToMe(conv, user)) {
            setNotifications((prev) => [notif, ...prev].slice(0, 100));
            // Alert the attendant even when this conversation isn't focused or the
            // browser tab is in the background: short sound and/or native notification.
            const notLooking = document.hidden || conversationId !== activeId;
            if (notLooking) {
              if (soundEnabledRef.current) playAlertSound();
              if (desktopEnabledRef.current && document.hidden) {
                showDesktopNotification(conv.name, message.content, conversationId);
              }
            }
          }
        }
      } catch { /* silent */ }
    });
    // Agendamentos: hora do retorno ao cliente ("schedule_due") e falha no envio
    // de mensagem agendada ("schedule_failed"). Toast + sino + som/notificação
    // nativa, sem depender de olhar o quadro de Tarefas.
    const onSchedule = (e: MessageEvent, kind: "retorno" | "failed") => {
      try {
        const p = JSON.parse(e.data) as { scheduledId: number; conversationId: number; convName: string; content: string; sendAt: string };
        const notif: MsgNotification = {
          id: `sched-${kind}-${p.scheduledId}`,
          conversationId: p.conversationId,
          convName: p.convName || "Cliente",
          preview: p.content,
          createdAt: new Date().toISOString(),
          read: false,
          kind,
        };
        setNotifications((prev) => prev.some((n) => n.id === notif.id) ? prev : [notif, ...prev].slice(0, 100));
        const title = kind === "retorno"
          ? `📞 Hora do retorno — ${notif.convName}`
          : `⚠️ Mensagem agendada falhou — ${notif.convName}`;
        toast({
          title,
          description: `${p.content.slice(0, 120)} — toque para abrir a conversa`,
          variant: kind === "failed" ? "destructive" : undefined,
          onClick: () => { setActiveId(p.conversationId); setShowNotifications(false); },
          className: "cursor-pointer",
        });
        if (soundEnabledRef.current) playAlertSound();
        if (desktopEnabledRef.current) {
          showDesktopNotification(title, p.content, p.conversationId);
        }
      } catch { /* silent */ }
    };
    es.addEventListener("schedule_due", (e) => onSchedule(e, "retorno"));
    es.addEventListener("schedule_failed", (e) => onSchedule(e, "failed"));
    es.addEventListener("conversation_new", (e) => {
      try {
        const conv = JSON.parse(e.data) as Conversation;
        // Regardless of visibility, discard any buffered notices for this conv;
        // if it's out of scope they must not surface, if visible we resolve them now.
        const pending = pendingNotifsRef.current.get(conv.id);
        pendingNotifsRef.current.delete(conv.id);
        if (!isVisibleToMe(conv, user)) return;
        setConvs((prev) => prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]);
        // Resolve any inbound messages that arrived before this conversation loaded,
        // so the first notice of a brand-new contact isn't lost to event ordering.
        if (pending && pending.length) {
          const resolved = pending.map((n) => ({
            ...n,
            convName: conv.name,
            read: n.conversationId === activeId,
          }));
          setNotifications((prev) => {
            const seen = new Set(prev.map((n) => n.id));
            const fresh = resolved.filter((n) => !seen.has(n.id));
            return [...fresh.reverse(), ...prev].slice(0, 100);
          });
          const notLooking = document.hidden || conv.id !== activeId;
          if (notLooking) {
            if (soundEnabledRef.current) playAlertSound();
            if (desktopEnabledRef.current && document.hidden) {
              const last = pending[pending.length - 1];
              showDesktopNotification(conv.name, last.preview, conv.id);
            }
          }
        }
      } catch { /* silent */ }
    });
    es.addEventListener("conversation_updated", (e) => {
      try {
        const conv = JSON.parse(e.data) as Conversation;
        setConvs((prev) => {
          // O evento traz a linha crua (sem participants); mescla com o estado
          // local para não descartar uma conversa em que sou participante.
          const existing = prev.find((c) => c.id === conv.id);
          const merged = existing ? { ...existing, ...conv } : conv;
          // A potencial claimed by someone else (or moved to another sector)
          // is no longer visible — drop it from the list.
          if (!isVisibleToMe(merged, user)) {
            // Also drop its notifications so no out-of-scope previews linger.
            setNotifications((p) => p.filter((n) => n.conversationId !== conv.id));
            return prev.filter((c) => c.id !== conv.id);
          }
          if (!existing) return [merged, ...prev];
          return prev.map((c) => c.id === conv.id ? merged : c);
        });
      } catch { /* silent */ }
    });
    // Conversa ficou restrita (assumida/finalizada por outro): remove da tela
    // de quem não está na lista de autorizados. Evento leve: só id + keepFor.
    es.addEventListener("conversation_hidden", (e) => {
      try {
        const { id, keepFor, sectorId } = JSON.parse(e.data) as { id: number; keepFor: number[]; sectorId: number | null };
        if (!user) return;
        if (user.role === "admin") return;
        if (user.role === "supervisor") {
          // Supervisor com setor: só mantém conversas restritas do próprio setor.
          if (user.sectorId == null || sectorId === user.sectorId) return;
        } else if (keepFor.includes(user.id)) {
          return;
        }
        setConvs((prev) => prev.filter((c) => c.id !== id));
        setNotifications((prev) => prev.filter((n) => n.conversationId !== id));
      } catch { /* silent */ }
    });
    // Atendimento excluído pelo administrador: some para todos.
    es.addEventListener("conversation_deleted", (e) => {
      try {
        const { id } = JSON.parse(e.data) as { id: number };
        setConvs((prev) => prev.filter((c) => c.id !== id));
        setNotifications((prev) => prev.filter((n) => n.conversationId !== id));
        setActiveId((cur) => (cur === id ? null : cur));
      } catch { /* silent */ }
    });
    // Participantes mudaram (fui adicionado/removido de uma conversa restrita):
    // a lista do servidor é a fonte da verdade — refetch.
    es.addEventListener("participants_updated", () => {
      fetchConvs();
    });
    // When the reconnection gap is larger than the server's replay buffer (or
    // the server restarted), the server asks the client to resync. Refetch the
    // conversation list and the open conversation's messages so nothing that
    // arrived during the outage is lost. Missed events within buffer range are
    // replayed automatically and flow through the handlers above, so the bell
    // and lists stay correct without any extra work here.
    es.addEventListener("resync", () => {
      fetchConvs();
      if (activeId != null) fetchMsgs(activeId);
    });
    return () => es.close();
  }, [activeId, user, fetchConvs, fetchMsgs]);

  useEffect(() => {
    api.sectors.list().then(setSectors).catch(() => {});
    api.chatUsers().then(setChatUsers).catch(() => {});
    api.settings.get().then((s) => {
      setAlertEnabled(s.alertUnansweredEnabled); setAlertMinutes(s.alertUnansweredMinutes);
      setCfgOutboundHourly(s.outboundHourlyLimit); setCfgOutboundDaily(s.outboundDailyLimit);
    }).catch(() => {});
    api.chat.quickReplies.list().then(setQuickReplies).catch(() => {});
    api.chat.labels.list().then(setLabels).catch(() => {});
    api.chat.waSessions().then(setWaSessions).catch(() => {});
  }, []);

  // ── Etiquetas (labels) management ──
  const fetchLabels = useCallback(async () => {
    try { setLabels(await api.chat.labels.list()); } catch { /* silent */ }
  }, []);

  const handleCreateLabel = async () => {
    const name = labelForm.name.trim();
    if (!name) { toast({ title: "Informe o nome da etiqueta", variant: "destructive" }); return; }
    setSavingLabel(true);
    try {
      await api.chat.labels.create({ name, color: labelForm.color });
      setLabelForm({ name: "", color: LABEL_COLOR_PRESETS[0] });
      await fetchLabels();
      toast({ title: "Etiqueta criada" });
    } catch { toast({ title: "Erro ao criar etiqueta", variant: "destructive" }); }
    finally { setSavingLabel(false); }
  };

  const handleDeleteLabel = async (id: number) => {
    try {
      await api.chat.labels.remove(id);
      await fetchLabels();
    } catch { toast({ title: "Erro ao excluir etiqueta", variant: "destructive" }); }
  };

  useEffect(() => { setShowParticipantPicker(false); setShowStatusPicker(false); setCrmContactId(null); }, [activeId]);

  // ── Send message ──
  const cancelReply = () => setReplyTarget(null);

  const scrollToMessage = (id: number) => {
    document.getElementById(`chat-msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMsgId(id);
    setTimeout(() => setHighlightedMsgId((cur) => (cur === id ? null : cur)), 1500);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || !msgText.trim() || sending) return;
    const text = msgText.trim();
    const isNote = composerMode === "note";
    const replyingTo = isNote ? null : replyTarget;
    setMsgText("");
    setReplyTarget(null);
    setSending(true);
    const optimistic: ChatMessage = {
      id: -Date.now(), conversationId: activeId, content: text,
      direction: "outbound", type: isNote ? "note" : "text", status: "sent",
      senderName: user?.name ?? null, mediaUrl: null, transcript: null, externalId: null,
      createdAt: new Date().toISOString(),
      replyToId: replyingTo?.id ?? null,
      replyTo: replyingTo ? { id: replyingTo.id, senderName: replyingTo.senderName, content: replyingTo.content, type: replyingTo.type } : null,
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const msg = isNote
        ? await api.chat.sendNote(activeId, text)
        : await api.chat.sendMessage(activeId, text, replyingTo?.id);
      setMessages((prev) => prev.some((m) => m.id === msg.id)
        ? prev.filter((m) => m.id !== optimistic.id)
        : prev.map((m) => m.id === optimistic.id ? msg : m));
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setMsgText(text);
      setReplyTarget(replyingTo);
      toast({ title: isNote ? "Erro ao salvar nota" : "Erro ao enviar mensagem", variant: "destructive" });
    } finally { setSending(false); }
  };

  // ── Send file (image or document) ──
  const handleSendFile = async (file: File, fileCaption?: string) => {
    if (!activeId || sending) return;
    const previewUrl = filePreview?.previewUrl ?? null;
    const replyingTo = replyTarget;
    setFilePreview(null);
    setCaption("");
    setReplyTarget(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSending(true);
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    const baseContent = isImage ? "📷 Foto" : isVideo ? "🎥 Vídeo" : isAudio ? "🎤 Áudio" : `📄 ${file.name}`;
    const optimistic: ChatMessage = {
      id: -Date.now(), conversationId: activeId,
      content: fileCaption ? `${baseContent}\n${fileCaption}` : baseContent,
      direction: "outbound", type: isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "doc", status: "sent",
      senderName: user?.name ?? null, mediaUrl: null, transcript: null, externalId: null,
      createdAt: new Date().toISOString(),
      replyToId: replyingTo?.id ?? null,
      replyTo: replyingTo ? { id: replyingTo.id, senderName: replyingTo.senderName, content: replyingTo.content, type: replyingTo.type } : null,
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const msg = await api.chat.sendMedia(activeId, file, fileCaption, { replyToId: replyingTo?.id });
      setMessages((prev) => prev.some((m) => m.id === msg.id)
        ? prev.filter((m) => m.id !== optimistic.id)
        : prev.map((m) => m.id === optimistic.id ? msg : m));
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      toast({ title: "Erro ao enviar arquivo", variant: "destructive" });
    } finally { setSending(false); }
  };

  // ── Gravação de nota de voz (microfone) ──
  const stopRecordTimer = () => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
  };

  const handleStartRecording = async () => {
    if (!activeId || recording || sending) return;
    // Navegadores só liberam o microfone em página segura (https). Sem isso,
    // navigator.mediaDevices nem existe — avisa o motivo real em vez de um
    // erro genérico.
    if (typeof window !== "undefined" && !window.isSecureContext) {
      toast({
        title: "Microfone bloqueado: o site precisa abrir com https://",
        description: "Acesse o sistema pelo endereço com cadeado (https) para gravar áudios.",
        variant: "destructive",
      });
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
      const convId = activeId;
      rec.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        stopRecordTimer();
        setRecording(false);
        setRecordSecs(0);
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        if (!recordSendRef.current || chunks.length === 0) return;
        const type = (rec.mimeType || "audio/webm").split(";")[0];
        const ext = type === "audio/mp4" ? "m4a" : "weba";
        const file = new File([new Blob(chunks, { type })], `nota-de-voz.${ext}`, { type: rec.mimeType || "audio/webm" });
        setSending(true);
        const optimistic: ChatMessage = {
          id: -Date.now(), conversationId: convId,
          content: "🎤 Áudio",
          direction: "outbound", type: "audio", status: "sent",
          senderName: user?.name ?? null, mediaUrl: null, transcript: null, externalId: null,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);
        try {
          const msg = await api.chat.sendMedia(convId, file, undefined, { ptt: true });
          setMessages((prev) => prev.some((m) => m.id === msg.id)
            ? prev.filter((m) => m.id !== optimistic.id)
            : prev.map((m) => m.id === optimistic.id ? msg : m));
        } catch (err) {
          setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
          toast({ title: "Erro ao enviar áudio", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
        } finally { setSending(false); }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordSecs(0);
      recordTimerRef.current = setInterval(() => setRecordSecs((s) => s + 1), 1000);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      toast({
        title: name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "Nenhum microfone encontrado neste aparelho"
          : "Permissão do microfone negada",
        description: name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Libere o microfone nas permissões do navegador (ícone de cadeado ao lado do endereço) e tente de novo."
          : undefined,
        variant: "destructive",
      });
    }
  };

  const handleFinishRecording = (send: boolean) => {
    recordSendRef.current = send;
    recorderRef.current?.stop();
    recorderRef.current = null;
  };

  // Cancela gravação ao trocar de conversa ou sair da tela.
  useEffect(() => {
    return () => {
      recordSendRef.current = false;
      recorderRef.current?.stop();
      recorderRef.current = null;
      stopRecordTimer();
    };
  }, [activeId]);

  // ── Open file preview modal ──
  const handleFileSelected = (file: File) => {
    const isImage = file.type.startsWith("image/");
    if (isImage) {
      const url = URL.createObjectURL(file);
      setFilePreview({ file, previewUrl: url });
    } else {
      setFilePreview({ file, previewUrl: null });
    }
    setCaption("");
  };

  const handleCancelPreview = () => {
    if (filePreview?.previewUrl) URL.revokeObjectURL(filePreview.previewUrl);
    setFilePreview(null);
    setCaption("");
  };

  // ── Update status ──
  const handleStatus = async (status: string) => {
    if (!activeId) return;
    try {
      await api.chat.updateConversation(activeId, { status });
      setConvs((prev) => prev.map((c) => c.id === activeId ? { ...c, status } : c));
    } catch { toast({ title: "Erro ao atualizar", variant: "destructive" }); }
  };

  // ── Potencial → Pendente (enviar para a fila de atendimento) ──
  const handleMoveToQueue = async (id: number) => {
    try {
      await api.chat.updateConversation(id, { status: "pending" });
      setConvs((prev) => prev.map((c) => c.id === id ? { ...c, status: "pending" } : c));
      toast({ title: "Enviado para a fila de atendimento" });
    } catch { toast({ title: "Erro ao enviar para a fila", variant: "destructive" }); }
  };

  // ── Pendente → Ativo (iniciar atendimento: assume a conversa) ──
  // Fixar/desafixar conversa (só para o próprio usuário) com atualização otimista.
  const handleTogglePin = async (conv: Conversation) => {
    const next = !conv.pinned;
    setConvs((prev) => prev.map((c) => (c.id === conv.id ? { ...c, pinned: next } : c)));
    try {
      if (next) await api.chat.pinConversation(conv.id);
      else await api.chat.unpinConversation(conv.id);
    } catch {
      setConvs((prev) => prev.map((c) => (c.id === conv.id ? { ...c, pinned: !next } : c)));
      toast({ title: "Não foi possível alterar a fixação", variant: "destructive" });
    }
  };

  const handleClaim = async (id: number) => {
    try {
      const updated = await api.chat.claimConversation(id);
      setConvs((prev) => prev.map((c) => c.id === id
        ? { ...c, ...updated, assignee: user ? { id: user.id, name: user.name } : c.assignee }
        : c));
      toast({ title: "Atendimento iniciado" });
    } catch (e) {
      // Mostra o motivo real (ex.: 404 se a API em produção estiver desatualizada,
      // 409 se outro vendedor já assumiu) em vez de um erro genérico.
      const msg = e instanceof Error ? e.message : "";
      toast({ title: "Erro ao iniciar atendimento", description: msg || undefined, variant: "destructive" });
    }
  };

  // ── Ativo → Resolvida (finalizar atendimento) ──
  // Abre o modal para o vendedor escolher o motivo antes de finalizar.
  const handleDeleteConv = async (id: number, name: string) => {
    if (!window.confirm(`Excluir o atendimento de "${name}"? As mensagens serão apagadas de vez.`)) return;
    try {
      await api.chat.deleteConversation(id);
      setConvs((prev) => prev.filter((c) => c.id !== id));
      setNotifications((prev) => prev.filter((n) => n.conversationId !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Não foi possível excluir o atendimento");
    }
  };

  const openSchedule = async (convId: number) => {
    setSchedForm({ kind: "mensagem", content: "", sendAt: "" });
    setShowSchedule(true);
    try { setSchedules(await api.chat.schedules.list(convId)); } catch { setSchedules([]); }
  };

  const submitSchedule = async () => {
    if (!activeConv) return;
    if (!schedForm.content.trim()) { toast({ title: "Escreva o texto da mensagem ou do retorno", variant: "destructive" }); return; }
    if (!schedForm.sendAt) { toast({ title: "Escolha a data e a hora", variant: "destructive" }); return; }
    setSchedSaving(true);
    try {
      await api.chat.schedules.create(activeConv.id, {
        kind: schedForm.kind,
        content: schedForm.content.trim(),
        sendAt: new Date(schedForm.sendAt).toISOString(),
      });
      setSchedules(await api.chat.schedules.list(activeConv.id));
      setSchedForm({ kind: schedForm.kind, content: "", sendAt: "" });
      toast({ title: schedForm.kind === "mensagem" ? "Mensagem agendada! Também criei uma tarefa no quadro." : "Retorno agendado! Criei uma tarefa no quadro como lembrete." });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Não foi possível agendar", variant: "destructive" });
    } finally {
      setSchedSaving(false);
    }
  };

  const cancelSchedule = async (schedId: number) => {
    if (!activeConv) return;
    try {
      await api.chat.schedules.cancel(schedId);
      setSchedules((prev) => prev.filter((s) => s.id !== schedId));
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Não foi possível cancelar", variant: "destructive" });
    }
  };

  const handleFinalize = (id: number) => {
    setFinalizeTarget(id);
    setFinalizeReason(FINALIZE_REASONS[0]);
    setFinalizeDetail("");
    setFinalizeHadSale(null);
    setFinalizeSaleAmount("");
    setFinalizeSaleDesc("");
  };

  const submitFinalize = async () => {
    if (finalizeTarget == null) return;
    const id = finalizeTarget;
    // Motivo enviado ao servidor: para "Outro" usa o texto livre, senão o rótulo.
    const isOutro = finalizeReason === "Outro";
    const resolutionReason = (isOutro ? finalizeDetail.trim() : finalizeReason) || null;
    if (isOutro && !resolutionReason) {
      toast({ title: "Descreva o motivo da finalização", variant: "destructive" });
      return;
    }
    if (finalizeHadSale == null) {
      toast({ title: "Informe se teve venda neste atendimento", variant: "destructive" });
      return;
    }
    const saleAmount = parseFloat(finalizeSaleAmount.replace(",", "."));
    if (finalizeHadSale && (!Number.isFinite(saleAmount) || saleAmount <= 0)) {
      toast({ title: "Informe o valor da venda", variant: "destructive" });
      return;
    }
    setFinalizing(true);
    try {
      const updated = await api.chat.updateConversation(id, {
        status: "resolved", resolutionReason,
        hadSale: finalizeHadSale,
        ...(finalizeHadSale ? { saleAmount, saleDescription: finalizeSaleDesc.trim() } : {}),
      });
      setConvs((prev) => prev.map((c) => c.id === id ? { ...c, ...updated, status: "resolved" } : c));
      toast({ title: "Atendimento finalizado" });
      setFinalizeTarget(null);
    } catch { toast({ title: "Erro ao finalizar atendimento", variant: "destructive" }); }
    finally { setFinalizing(false); }
  };

  // ── Transfer conversation to sector ──
  const handleTransferToUser = async (targetUserId: number, targetName: string) => {
    if (!activeConv) return;
    try {
      await api.chat.sendMessage(activeConv.id, `🔀 Conversa transferida para ${targetName}`);
      const updated = await api.chat.updateConversation(activeConv.id, { assigneeId: targetUserId });
      setConvs((prev) => prev.map((c) => c.id === activeConv.id ? { ...c, ...updated } : c));
      setShowTransferPicker(false);
      toast({ title: `Transferido para ${targetName}`, description: "A conversa agora está nos Ativos desse vendedor." });
    } catch (err) {
      toast({ title: "Erro ao transferir", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

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
        senderName: "Sistema", mediaUrl: null, transcript: null, externalId: null,
        createdAt: new Date().toISOString(),
      }]);
      toast({ title: `Transferido para ${targetSector?.name ?? "setor"}`, description: "Conversa enviada para Pendentes para aprovar o atendimento." });
    } catch { toast({ title: "Erro ao transferir", variant: "destructive" }); }
    setShowTransferPicker(false);
  };

  // ── Add/remove participant ──
  const handleAddParticipant = async (userId: number) => {
    if (!activeConv) return;
    try {
      const res = await api.chat.participants.add(activeConv.id, userId);
      const u = chatUsers.find((x) => x.id === userId);
      const newStatus = res.conversation?.status;
      setConvs((prev) => prev.map((c) => {
        if (c.id !== activeConv.id) return c;
        const participants = u ? [...(c.participants ?? []), { id: u.id, name: u.name }] : c.participants;
        return newStatus ? { ...c, participants, status: newStatus } : { ...c, participants };
      }));
      if (newStatus === "pending") {
        toast({ title: "Vendedor adicionado", description: "Conversa enviada para Pendentes para aprovar o atendimento." });
      }
    } catch { toast({ title: "Erro ao adicionar vendedor", variant: "destructive" }); }
  };

  const handleRemoveParticipant = async (userId: number) => {
    if (!activeConv) return;
    try {
      await api.chat.participants.remove(activeConv.id, userId);
      setConvs((prev) => prev.map((c) => c.id === activeConv.id ? { ...c, participants: (c.participants ?? []).filter((p) => p.id !== userId) } : c));
    } catch { toast({ title: "Erro ao remover vendedor", variant: "destructive" }); }
  };

  // ── Open / link the CRM contact for the active conversation ──
  // Uses auto-register so the contact is found by phone or created on the fly,
  // bridging the Atendimento (chat) and CRM modules.
  const handleOpenCrm = async () => {
    if (!activeConv || crmLoading) return;
    if (isGroupConv(activeConv)) {
      toast({ title: "Grupos não são cadastrados no CRM" });
      return;
    }
    setCrmLoading(true);
    try {
      const c = await api.crm.autoRegister({ name: activeConv.name, phone: activeConv.phone, sectorId: activeConv.sectorId ?? undefined });
      setCrmContactId(c.id);
      if (c.created) toast({ title: "Cliente cadastrado no CRM" });
    } catch {
      toast({ title: "Erro ao abrir CRM", variant: "destructive" });
    } finally { setCrmLoading(false); }
  };

  // ── Informações side panel: load the linked CRM contact ──
  const loadInfoContact = useCallback(async () => {
    if (!activeConv) return;
    if (isGroupConv(activeConv)) {
      // Grupos não têm ficha de cliente no CRM.
      setInfoContact(null);
      setInfoLoading(false);
      return;
    }
    setInfoLoading(true);
    try {
      const c = await api.crm.autoRegister({ name: activeConv.name, phone: activeConv.phone, sectorId: activeConv.sectorId ?? undefined });
      const full = await api.crm.get(c.id);
      setInfoContact(full);
      setInfoForm({
        name: full.name,
        city: full.city ?? "",
        serviceStore: full.serviceStore ?? "",
        attendanceSource: full.attendanceSource ?? "",
        notes: full.notes ?? "",
      });
      setInfoCustomValues(full.customFields ?? {});
    } catch {
      toast({ title: "Erro ao carregar informações do cliente", variant: "destructive" });
    } finally { setInfoLoading(false); }
  }, [activeConv, toast]);

  // Load custom-field definitions once for the info panel
  useEffect(() => {
    api.crm.customFields.list().then((f) => setCustomDefs(f.filter((d) => d.isActive))).catch(() => {});
  }, []);

  // (Re)load contact whenever the panel opens or the active conversation changes
  useEffect(() => {
    if (showInfo && activeConv) void loadInfoContact();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInfo, activeId]);

  const handleSaveInfo = async () => {
    if (!infoContact) return;
    setInfoSaving(true);
    try {
      const updated = await api.crm.update(infoContact.id, {
        name: infoForm.name,
        city: infoForm.city,
        serviceStore: infoForm.serviceStore,
        attendanceSource: infoForm.attendanceSource,
        notes: infoForm.notes,
        customFields: infoCustomValues,
      });
      setInfoContact(updated);
      setInfoCustomValues(updated.customFields ?? {});
      toast({ title: "Informações atualizadas!" });
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setInfoSaving(false); }
  };

  // ── AI: suggest a reply for the attendant to review before sending ──
  const handleSuggestReply = async () => {
    if (!activeConv || suggesting) return;
    setSuggesting(true);
    try {
      const { suggestion } = await api.chat.suggestReply(activeConv.id);
      setMsgText(suggestion);
      inputRef.current?.focus();
      toast({ title: "Sugestão gerada — revise antes de enviar" });
    } catch (err: unknown) {
      toast({ title: "IA indisponível", description: err instanceof Error ? err.message : "Erro ao gerar sugestão", variant: "destructive" });
    } finally { setSuggesting(false); }
  };

  // ── AI: fix spelling/grammar of the drafted message ──
  const handleCorrectText = async () => {
    const text = msgText.trim();
    if (!text || correcting || sending) return;
    setCorrecting(true);
    try {
      const { corrected } = await api.chat.correctText(text);
      // Só aplica se o atendente não editou o texto enquanto a IA respondia.
      setMsgText((prev) => (prev.trim() === text ? corrected : prev));
      inputRef.current?.focus();
      if (corrected === text) toast({ title: "Nenhum erro encontrado" });
      else toast({ title: "Texto corrigido — revise antes de enviar" });
    } catch (err: unknown) {
      toast({ title: "Correção indisponível", description: err instanceof Error ? err.message : "Erro ao corrigir texto", variant: "destructive" });
    } finally { setCorrecting(false); }
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

  // Mostra o uso da trava anti-disparo em massa assim que dá pra saber quem
  // vai ser o responsável (self para vendedor; escolhido para admin/supervisor).
  useEffect(() => {
    if (!showNewConv || newForm.channel !== "whatsapp") { setOutboundUsage(null); return; }
    const effectiveAssignee = newForm.assigneeId ? Number(newForm.assigneeId) : (user?.role === "vendedor" ? user.id : null);
    if (effectiveAssignee == null) { setOutboundUsage(null); return; }
    let cancelled = false;
    api.chat.outboundUsage(effectiveAssignee).then((u) => { if (!cancelled) setOutboundUsage(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [showNewConv, newForm.channel, newForm.assigneeId, user]);

  // ── Create conversation ──
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const conv = await api.chat.createConversation({
        phone: newForm.phone, name: newForm.name, channel: newForm.channel,
        sectorId: newForm.sectorId ? Number(newForm.sectorId) : undefined,
        assigneeId: newForm.assigneeId ? Number(newForm.assigneeId) : undefined,
      });
      // O insert no backend não devolve o objeto assignee (só assigneeId) —
      // preenche localmente com o que já temos em chatUsers pra não ficar
      // preso na tela de "Iniciar atendimento" quando já tem responsável.
      const assignee = conv.assigneeId != null
        ? (conv.assigneeId === user?.id ? { id: user.id, name: user.name } : chatUsers.find((u) => u.id === conv.assigneeId))
        : null;
      const convWithAssignee = { ...conv, assignee: assignee ?? conv.assignee ?? null };
      // O broadcast "conversation_new" chega pelo SSE ANTES dessa resposta do
      // POST resolver (o servidor dispara o evento antes de responder) — sem
      // checar duplicata aqui, a conversa aparecia duas vezes na lista.
      setConvs((prev) => prev.some((c) => c.id === convWithAssignee.id)
        ? prev.map((c) => c.id === convWithAssignee.id ? convWithAssignee : c)
        : [convWithAssignee, ...prev]);
      setActiveId(conv.id);
      // Abre a aba onde a conversa realmente caiu (vendedor: já sai em Ativos).
      setCategory(conversationCategory(conv));
      setShowNewConv(false);
      setNewForm({ name: "", phone: "", channel: "whatsapp", sectorId: "", assigneeId: "" });
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  // Relógio de 30s para reavaliar quais conversas estouraram o tempo limite.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Conversa "estourada": cliente falou por último e ninguém respondeu dentro
  // do limite (padrão 5 min). Não vale para resolvidas/arquivadas.
  const isOverdue = useCallback((c: Conversation): boolean => {
    if (!alertEnabled) return false;
    if (c.status === "resolved" || c.status === "archived") return false;
    if (c.lastMessageDirection !== "inbound") return false;
    if (!c.lastMessageAt) return false;
    return nowTick - new Date(c.lastMessageAt).getTime() >= alertMinutes * 60000;
  }, [alertEnabled, alertMinutes, nowTick]);

  // Alerta sonoro + aviso quando uma conversa estoura o limite (1x por estouro).
  // O toque muda conforme a área da conversa (Potenciais/Pendentes/Ativos).
  useEffect(() => {
    if (!alertEnabled) return;
    const overdueNow = convs.filter(isOverdue);
    for (const c of overdueNow) {
      if (!alertedRef.current.has(c.id)) {
        alertedRef.current.add(c.id);
        const cat = conversationCategory(c);
        toast({
          title: `⚠ ${c.name} sem resposta`,
          description: `Cliente aguardando há mais de ${alertMinutes} min (${cat}).`,
          variant: "destructive",
        });
        if (soundEnabledRef.current && (cat === "potenciais" || cat === "pendentes" || cat === "ativos")) playAlertSound(cat);
      }
    }
    // Quando a conversa é respondida, libera para alertar de novo no futuro
    // e sai do alarme fixo (inclusive se estava silenciada).
    for (const id of [...alertedRef.current]) {
      const c = convs.find((x) => x.id === id);
      if (!c || !isOverdue(c)) {
        alertedRef.current.delete(id);
        setAlarmMuted((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [convs, isOverdue, alertEnabled, alertMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Alarme fixo (tipo despertador) ─────────────────────────────────────────
  // Enquanto houver conversa estourada não silenciada, um aviso grande fica na
  // tela e o toque repete a cada 20s até alguém responder ou silenciar.
  // Admin não recebe o alarme fixo (banner + som repetido) — só a equipe.
  const alarmForRole = user?.role !== "admin";
  const overdueConvs = alertEnabled && alarmForRole ? convs.filter(isOverdue) : [];
  const alarmConvs = overdueConvs.filter((c) => !alarmMuted.has(c.id));
  const alarmByCat = { potenciais: 0, pendentes: 0, ativos: 0 } as Record<string, number>;
  for (const c of alarmConvs) alarmByCat[conversationCategory(c)] = (alarmByCat[conversationCategory(c)] ?? 0) + 1;
  const alarmActiveRef = useRef(false);
  alarmActiveRef.current = alarmConvs.length > 0;
  const alarmTopCatRef = useRef<"potenciais" | "pendentes" | "ativos">("potenciais");
  alarmTopCatRef.current = alarmByCat.potenciais! > 0 ? "potenciais" : alarmByCat.pendentes! > 0 ? "pendentes" : "ativos";
  useEffect(() => {
    const t = setInterval(() => {
      if (alarmActiveRef.current && soundEnabledRef.current) playAlertSound(alarmTopCatRef.current);
    }, 20000);
    return () => clearInterval(t);
  }, [playAlertSound]);

  const overdueCount = alertEnabled ? convs.filter(isOverdue).length : 0;

  const visibleConvs = convs.filter((c) =>
    // Busca por nome ou número (aceita número digitado com espaços/traços).
    (!search || c.name.toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search) || c.phone.replace(/\D/g, "").includes(search.replace(/\D/g, "") || "\u0000")) &&
    // Filtro "não respondidas": o cliente falou por último (ou há não lidas).
    (!onlyUnanswered || c.lastMessageDirection === "inbound" || c.unreadCount > 0) &&
    (!filterVendedor || String(c.assigneeId ?? "") === filterVendedor) &&
    (!filterSetor || String(c.sectorId ?? "") === filterSetor) &&
    (!filterNivel || (c.crmProfile ?? "") === filterNivel)
  );
  const hasAdvancedFilter = !!(filterVendedor || filterSetor || filterNivel);

  const counts: Record<Category, number> = { potenciais: 0, pendentes: 0, ativos: 0, resolvidas: 0 };
  for (const c of visibleConvs) {
    counts[conversationCategory(c)]++;
  }

  // Fixadas primeiro; dentro de cada grupo mantém a ordem por última mensagem.
  const filteredConvs = visibleConvs
    .filter((c) => conversationCategory(c) === category)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const activeCategory = activeConv ? conversationCategory(activeConv) : null;

  const currentLabels = activeConv?.labels ? activeConv.labels.split(",").map((l) => l.trim()).filter(Boolean) : [];

  return (
    <div className="flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] md:h-[calc(100vh-88px)] bg-[#f0f2f5] overflow-hidden rounded-none md:rounded-2xl border-0 md:border border-border shadow-none md:shadow-sm">

      {/* ── LEFT PANEL: conversation list ──────────────────────────────── */}
      <div className={`${activeConv ? "hidden md:flex" : "flex"} w-full md:w-80 lg:w-96 bg-white flex-col md:border-r border-border shrink-0`}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-[#ededed] flex items-center justify-between">
          <span className="font-bold text-foreground">Conversas</span>
          <div className="flex items-center gap-1">
            <div className="relative">
              <button
                ref={bellBtnRef}
                onClick={() => setShowNotifications((v) => !v)}
                data-testid="button-notifications"
                title="Notificações"
                className={`relative p-2 md:p-1.5 rounded-lg hover:bg-secondary transition ${showNotifications ? "bg-secondary" : ""}`}
              >
                <Bell className={`w-5 h-5 md:w-4 md:h-4 ${unreadNotifications > 0 ? "text-primary" : "text-muted-foreground"}`} />
                {unreadNotifications > 0 && (
                  <span
                    data-testid="badge-notifications"
                    className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] leading-none rounded-full px-1 py-0.5 min-w-[17px] text-center font-bold ring-2 ring-white animate-in zoom-in duration-200"
                  >
                    {unreadNotifications > 99 ? "99+" : unreadNotifications}
                  </span>
                )}
              </button>
              {/* Painel num portal (body): antes ele era cortado pelo
                  overflow-hidden do container do chat e não dava para ver. */}
              {showNotifications && createPortal(
                <div
                  data-testid="panel-notifications"
                  className="fixed inset-x-2 top-14 md:inset-x-auto md:w-96 z-[70] bg-white border border-border rounded-xl shadow-xl overflow-hidden"
                  style={notifPanelPos ?? undefined}
                >
                  <div className="border-b border-border bg-[#ededed]">
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-sm font-bold text-foreground">Notificações</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setSoundEnabled((v) => !v)}
                          data-testid="button-toggle-sound"
                          title={soundEnabled ? "Som ligado — clique para desligar" : "Som desligado — clique para ligar"}
                          className="p-1 rounded hover:bg-white/70 transition"
                        >
                          {soundEnabled
                            ? <Volume2 className="w-4 h-4 text-primary" />
                            : <VolumeX className="w-4 h-4 text-muted-foreground" />}
                        </button>
                        <button
                          onClick={toggleDesktop}
                          data-testid="button-toggle-desktop"
                          title={desktopEnabled ? "Notificações do navegador ligadas — clique para desligar" : "Notificações do navegador desligadas — clique para ligar"}
                          className="p-1 rounded hover:bg-white/70 transition"
                        >
                          {desktopEnabled
                            ? <Bell className="w-4 h-4 text-primary" />
                            : <BellOff className="w-4 h-4 text-muted-foreground" />}
                        </button>
                      </div>
                    </div>
                    {unreadNotifications > 0 && (
                      <div className="px-3 pb-2 -mt-0.5">
                        <button onClick={markAllNotificationsRead} className="text-xs text-primary hover:underline">
                          Marcar todas como lidas
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="max-h-[60vh] md:max-h-96 overflow-y-auto overscroll-contain">
                    {notifications.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-10">
                        <Bell className="w-8 h-8 text-muted-foreground/40" />
                        <p className="text-xs text-muted-foreground">Nenhuma notificação por enquanto</p>
                      </div>
                    ) : (
                      notifications.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => openNotification(n)}
                          data-testid={`notification-item-${n.conversationId}`}
                          className={`w-full flex gap-2.5 items-start px-3 py-2.5 text-left border-b border-border/50 hover:bg-secondary/60 active:bg-secondary transition ${n.read ? "opacity-60" : ""}`}
                        >
                          <span className={`mt-1 w-7 h-7 rounded-full shrink-0 flex items-center justify-center ${
                            n.kind === "retorno" ? "bg-amber-100" : n.kind === "failed" ? "bg-red-100" : "bg-green-100"
                          }`}>
                            {n.kind === "retorno"
                              ? <CalendarClock className="w-4 h-4 text-amber-600" />
                              : n.kind === "failed"
                                ? <AlertTriangle className="w-4 h-4 text-red-600" />
                                : <MessageCircle className="w-4 h-4 text-green-600" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-semibold text-foreground truncate">
                                {n.kind === "retorno" ? `Retorno: ${n.convName}` : n.kind === "failed" ? `Falha no envio: ${n.convName}` : n.convName}
                              </span>
                              <span className="text-[11px] text-muted-foreground shrink-0">{msgTime(n.createdAt)}</span>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{n.preview || "Mensagem"}</p>
                          </div>
                          {!n.read && <span className="mt-2 w-2 h-2 rounded-full shrink-0 bg-red-500" />}
                        </button>
                      ))
                    )}
                  </div>
                </div>,
                document.body
              )}
            </div>
            <button onClick={() => setShowFilter(!showFilter)} className={`p-1.5 rounded-lg hover:bg-secondary transition ${showFilter ? "bg-secondary" : ""}`}>
              <Filter className="w-4 h-4 text-muted-foreground" />
            </button>
            {can(user, "criar_atendimento") && (
              <button onClick={() => setShowNewConv(true)} data-testid="button-new-conv"
                className="p-1.5 rounded-lg hover:bg-secondary transition">
                <Plus className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
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

        {/* Category tabs: Potenciais / Pendentes / Ativos */}
        <div className="flex border-b border-border bg-white">
          {CATEGORIES.filter((cat) =>
            (cat.id !== "potenciais" || can(user, "ver_potenciais")) &&
            // Resolvidas só para admin/supervisor
            (cat.id !== "resolvidas" || user?.role === "admin" || user?.role === "supervisor")
          ).map((cat) => {
            const isActive = category === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setCategory(cat.id)}
                title={cat.help}
                data-testid={`tab-category-${cat.id}`}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 px-1 text-xs font-semibold transition border-b-2 ${isActive ? "text-foreground" : "text-muted-foreground hover:bg-secondary/40 border-transparent"}`}
                style={isActive ? { borderBottomColor: cat.color } : undefined}
              >
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                  {cat.label}
                </span>
                <span
                  className="text-[11px] font-bold px-1.5 rounded-full min-w-[20px] text-center"
                  style={{ backgroundColor: `${cat.color}1a`, color: cat.color }}
                >
                  {counts[cat.id]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Filters */}
        {showFilter && (
          <div className="px-3 py-2 bg-[#ededed] border-b border-border space-y-2">
            <button
              onClick={() => setOnlyUnanswered((v) => !v)}
              data-testid="button-filter-unanswered"
              className={`text-xs px-2.5 py-1 rounded-full transition border font-semibold ${onlyUnanswered
                ? "bg-red-50 text-red-600 border-red-200"
                : "bg-white text-muted-foreground border-border"}`}
            >
              ● Não respondidas
            </button>
            {/* Alerta de sem resposta: só admin/supervisor liga/desliga */}
            {(user?.role === "admin" || user?.role === "supervisor") && (
              <button
                onClick={() => { setCfgEnabled(alertEnabled); setCfgMinutes(alertMinutes); setShowAlertCfg(true); }}
                data-testid="button-toggle-unanswered-alert"
                title={`Configurar alerta de atendimentos sem resposta (vale para toda a equipe)`}
                className={`ml-1 text-xs px-2.5 py-1 rounded-full transition border font-semibold ${alertEnabled
                  ? "bg-amber-50 text-amber-700 border-amber-300"
                  : "bg-white text-muted-foreground border-border"}`}
              >
                ⏰ Alerta {alertMinutes} min: {alertEnabled ? "LIGADO" : "desligado"}
              </button>
            )}
            {overdueCount > 0 && (
              <span className="ml-1 text-xs px-2 py-1 rounded-full bg-red-100 text-red-600 font-bold">
                {overdueCount} sem resposta há {alertMinutes}+ min
              </span>
            )}
            {/* Vendedor / Setor / Nível CRM */}
            <div className="flex gap-1.5 flex-wrap">
              <select value={filterVendedor} onChange={(e) => setFilterVendedor(e.target.value)}
                data-testid="filter-conv-vendedor"
                className="text-xs px-2 py-1 rounded-lg border border-border bg-white max-w-[140px]">
                <option value="">Vendedor: todos</option>
                {chatUsers.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
              </select>
              <select value={filterSetor} onChange={(e) => setFilterSetor(e.target.value)}
                data-testid="filter-conv-setor"
                className="text-xs px-2 py-1 rounded-lg border border-border bg-white max-w-[140px]">
                <option value="">Setor: todos</option>
                {sectors.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
              </select>
              <select value={filterNivel} onChange={(e) => setFilterNivel(e.target.value)}
                data-testid="filter-conv-nivel"
                className="text-xs px-2 py-1 rounded-lg border border-border bg-white max-w-[140px]">
                <option value="">Nível CRM: todos</option>
                <option value="Novo">Novo</option>
                <option value="Regular">Regular</option>
                <option value="VIP">VIP</option>
              </select>
              {hasAdvancedFilter && (
                <button onClick={() => { setFilterVendedor(""); setFilterSetor(""); setFilterNivel(""); }}
                  data-testid="button-clear-conv-filters"
                  className="text-xs px-2 py-1 rounded-lg border border-red-200 bg-red-50 text-red-600 font-semibold">
                  Limpar
                </button>
              )}
            </div>
            {labels.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhuma etiqueta criada.</p>
            ) : (
              <div className="flex gap-1 flex-wrap">
                {labels.map((l) => (
                  <button key={l.id} onClick={() => setLabelFilter(labelFilter === l.name ? "" : l.name)}
                    className="text-xs px-2 py-0.5 rounded-full transition border"
                    style={labelFilter === l.name
                      ? { backgroundColor: `${l.color}22`, color: l.color, borderColor: `${l.color}55` }
                      : { backgroundColor: "#fff", color: "#6b7280", borderColor: "#e5e7eb" }}>
                    {l.name}
                  </button>
                ))}
              </div>
            )}
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
              <ConvItem
                key={conv.id}
                conv={conv}
                active={conv.id === activeId}
                onClick={() => setActiveId(conv.id)}
                overdue={isOverdue(conv)}
                sessionBadge={
                  // Só etiqueta quando há mais de um número de atendimento
                  // pareado (ou a conversa vem de uma conexão secundária).
                  conv.channel === "whatsapp" && (waSessions.length > 1 || conv.sessionKey !== "default")
                    ? waSessionLabel(conv.sessionKey, waSessions)
                    : null
                }
              />
            ))
          )}
        </div>
      </div>

      {/* ── RIGHT PANEL: chat window ────────────────────────────────────── */}
      {!activeConv ? (
        <div className="hidden md:flex flex-1 flex-col items-center justify-center text-muted-foreground bg-[#f0f2f5]">
          <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-4">
            <MessageCircle className="w-10 h-10 opacity-30" />
          </div>
          <p className="font-semibold text-lg">Central de Atendimento</p>
          <p className="text-sm mt-1">Selecione uma conversa para começar</p>
        </div>
      ) : (
        <div className="flex-1 flex min-w-0">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div className="bg-[#ededed] border-b border-border px-2 md:px-4 py-2.5 flex items-center gap-2 md:gap-3 flex-wrap md:flex-nowrap">
            <button
              onClick={() => setActiveId(null)}
              data-testid="button-back-conv-list"
              title="Voltar para conversas"
              className="md:hidden p-1.5 -ml-0.5 rounded-lg hover:bg-secondary transition text-muted-foreground"
            >
              <ChevronDown className="w-5 h-5 rotate-90" />
            </button>
            <Avatar name={activeConv.name} src={activeConv.avatarUrl} size="md" />
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm text-foreground truncate">{activeConv.name}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {channelIcon(activeConv.channel, isGroupConv(activeConv))}
                <span>{isGroupConv(activeConv) ? "Grupo do WhatsApp" : activeConv.phone}</span>
                {activeConv.channel === "whatsapp" && (waSessions.length > 1 || activeConv.sessionKey !== "default") && (
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold truncate max-w-[140px]" style={{ fontSize: "10px" }} title="Número de atendimento pelo qual esta conversa chega">
                    via {waSessionLabel(activeConv.sessionKey, waSessions)}
                  </span>
                )}
                {activeConv.sector && (
                  <span className="px-1.5 py-0.5 rounded-full text-white font-medium" style={{ backgroundColor: activeConv.sector.color, fontSize: "10px" }}>
                    {activeConv.sector.name}
                  </span>
                )}
                {/* Quem está atendendo esta conversa */}
                {activeConv.assignee && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold truncate max-w-[160px]" style={{ fontSize: "10px" }} title="Vendedor responsável pelo atendimento" data-testid="text-conv-assignee">
                    <UserCircle2 className="w-3 h-3" />
                    {activeConv.assignee.name}
                  </span>
                )}
                {/* Data e hora de início do atendimento (quando foi assumido) */}
                {activeConv.attendanceStartedAt && (
                  <span className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-medium" style={{ fontSize: "10px" }} title="Início do atendimento" data-testid="text-attendance-started">
                    <CalendarClock className="w-3 h-3" />
                    Início: {new Date(activeConv.attendanceStartedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {/* Fixar/desafixar conversa no topo da lista (só para você) */}
              <button
                onClick={() => handleTogglePin(activeConv)}
                data-testid="button-pin-conv"
                className={`p-2 rounded-lg border transition ${activeConv.pinned ? "text-primary bg-primary/10 border-primary/30 hover:bg-primary/20" : "text-muted-foreground bg-white border-border hover:bg-secondary"}`}
                title={activeConv.pinned ? "Desafixar conversa" : "Fixar conversa no topo"}
              >
                {activeConv.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
              </button>
              {/* Excluir atendimento — só admin e só em Potenciais */}
              {user?.role === "admin" && activeCategory === "potenciais" && (
                <button
                  onClick={() => handleDeleteConv(activeConv.id, activeConv.name)}
                  data-testid="button-delete-conv"
                  className="p-2 rounded-lg text-red-600 bg-white border border-border hover:bg-red-50 transition"
                  title="Excluir atendimento"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Iniciar atendimento (assumir a conversa) — atribuição, não é status */}
              {activeCategory === "pendentes" && (
                <button
                  onClick={() => handleClaim(activeConv.id)}
                  data-testid="button-claim-conv"
                  className="p-2 rounded-lg text-white transition hover:opacity-90"
                  style={{ backgroundColor: "#16a34a" }}
                  title="Iniciar atendimento"
                >
                  <UserCircle2 className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Agendar mensagem ou retorno (vira tarefa no quadro) */}
              {activeCategory !== "resolvidas" && (
                <button
                  onClick={() => openSchedule(activeConv.id)}
                  data-testid="button-schedule"
                  className="p-2 rounded-lg bg-white border border-border hover:bg-secondary transition text-indigo-600"
                  title="Agendar mensagem ou retorno"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Finalizar atendimento — atalho visível (abre o modal de motivo) */}
              {activeCategory !== "resolvidas" && can(user, "finalizar") && (
                <button
                  onClick={() => handleFinalize(activeConv.id)}
                  data-testid="button-finalize-conv"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-white text-xs font-semibold transition hover:opacity-90"
                  style={{ backgroundColor: "#6b7280" }}
                  title="Finalizar atendimento"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  <span className="hidden lg:inline">Finalizar</span>
                </button>
              )}
              {/* Status quick-set */}
              <div className="relative">
                <button
                  onClick={() => { setShowStatusPicker((v) => !v); setShowLabelPicker(false); setShowTransferPicker(false); setShowParticipantPicker(false); }}
                  className="flex items-center gap-1 p-2 rounded-lg bg-white border border-border hover:bg-secondary transition"
                  title={`Status: ${STATUS_LABELS[activeConv.status] ?? activeConv.status}`}
                >
                  <Circle className={`w-3 h-3 fill-current ${activeConv.status === "open" ? "text-green-500" : activeConv.status === "pending" ? "text-amber-500" : "text-gray-400"}`} />
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showStatusPicker && (
                  <div className="absolute right-0 top-11 bg-white border border-border rounded-xl shadow-lg z-20 overflow-hidden w-40">
                    {["open", "pending", "resolved"].filter((s) => s !== "resolved" || can(user, "finalizar")).map((s) => (
                      <button key={s} onClick={() => {
                        if (s === "resolved") handleFinalize(activeConv.id);
                        else if (s === "pending") {
                          if (activeCategory === "potenciais") {
                            setPromoteConfirm({ id: activeConv.id, name: activeConv.name, to: "pendentes" });
                          } else {
                            handleMoveToQueue(activeConv.id);
                          }
                        }
                        else handleStatus(s);
                        setShowStatusPicker(false);
                      }}
                        className="w-full text-left flex items-center gap-2 text-xs px-3 py-2.5 hover:bg-secondary transition">
                        <Circle className={`w-2 h-2 fill-current ${s === "open" ? "text-green-500" : s === "pending" ? "text-amber-500" : "text-gray-400"}`} />
                        {STATUS_LABELS[s]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Labels */}
              <div className="relative">
                <button onClick={() => { setShowLabelPicker((v) => !v); setShowTransferPicker(false); setShowParticipantPicker(false); setShowStatusPicker(false); }}
                  className="p-2 rounded-lg bg-white border border-border hover:bg-secondary transition"
                  title="Etiquetas">
                  <Tag className="w-3.5 h-3.5" />
                </button>
                {showLabelPicker && (
                  <div className="absolute right-0 top-9 bg-white border border-border rounded-xl shadow-lg z-20 p-2 min-w-[180px]">
                    {labels.length === 0 ? (
                      <p className="text-xs text-muted-foreground px-3 py-2">Nenhuma etiqueta criada.</p>
                    ) : (
                      labels.map((label) => (
                        <button key={label.id} onClick={() => handleLabel(label.name)}
                          className={`w-full text-left text-xs px-3 py-1.5 rounded-lg flex items-center gap-2 transition ${currentLabels.includes(label.name) ? "bg-primary/10 text-primary font-semibold" : "hover:bg-secondary text-foreground"}`}>
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                          {label.name}
                        </button>
                      ))
                    )}
                    {(user?.role === "admin" || user?.role === "supervisor") && (
                      <button onClick={() => { setShowLabelPicker(false); setShowLabelManager(true); }}
                        className="w-full text-left text-xs px-3 py-1.5 mt-1 rounded-lg flex items-center gap-2 transition border-t border-border pt-2 text-primary hover:bg-secondary">
                        <Settings2 className="w-3 h-3" /> Gerenciar etiquetas
                      </button>
                    )}
                  </div>
                )}
              </div>
              {/* Transfer to sector */}
              {can(user, "transferir") && (
              <div className="relative">
                <button
                  onClick={() => { setShowTransferPicker((v) => !v); setShowLabelPicker(false); setShowParticipantPicker(false); setShowStatusPicker(false); }}
                  className="p-2 rounded-lg bg-white border border-border hover:bg-secondary transition"
                  title="Transferir para outro setor"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                </button>
                {showTransferPicker && (
                  <div className="absolute right-0 top-9 bg-white border border-border rounded-xl shadow-lg z-20 overflow-hidden min-w-[220px] max-h-[60vh] overflow-y-auto">
                    <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground">
                      Transferir para outro setor:
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
                    {(() => {
                      // Vendedores do setor da conversa (menos eu e o responsável atual)
                      const targets = chatUsers.filter((u) =>
                        u.role === "vendedor" &&
                        u.id !== user?.id &&
                        u.id !== activeConv?.assigneeId &&
                        (u.sectorId == null || u.sectorId === activeConv?.sectorId));
                      if (targets.length === 0) return null;
                      return (<>
                        <div className="px-3 py-2 border-y border-border text-xs font-semibold text-muted-foreground">
                          Transferir para vendedor:
                        </div>
                        {targets.map((u) => (
                          <button key={`u-${u.id}`} onClick={() => handleTransferToUser(u.id, u.name)}
                            data-testid={`button-transfer-user-${u.id}`}
                            className="w-full text-left flex items-center gap-2 text-xs px-3 py-2.5 hover:bg-secondary transition">
                            <UserCircle2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            {u.name}
                          </button>
                        ))}
                      </>);
                    })()}
                  </div>
                )}
              </div>
              )}
              {/* Participants / Vendedores */}
              <div className="relative">
                <button
                  onClick={() => { setShowParticipantPicker((v) => !v); setShowLabelPicker(false); setShowTransferPicker(false); setShowStatusPicker(false); }}
                  className="relative p-2 rounded-lg bg-white border border-border hover:bg-secondary transition"
                  title="Vendedores nesta conversa"
                >
                  <Users className="w-3.5 h-3.5" />
                  {(activeConv.participants?.length ?? 0) > 0 && (
                    <span className="absolute -top-1 -right-1 bg-primary text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] font-bold">
                      {activeConv.participants!.length}
                    </span>
                  )}
                </button>
                {showParticipantPicker && (
                  <div className="absolute right-0 top-9 bg-white border border-border rounded-xl shadow-lg z-20 overflow-hidden min-w-[220px]">
                    <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground">
                      Nesta conversa
                    </div>
                    {(activeConv.participants ?? []).length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">Nenhum vendedor atribuído</p>
                    ) : (
                      (activeConv.participants ?? []).map((p) => (
                        <div key={p.id} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-secondary/50">
                          <UserCircle2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span className="flex-1 font-medium">{p.name}</span>
                          <button onClick={() => handleRemoveParticipant(p.id)} className="opacity-40 hover:opacity-100 transition">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))
                    )}
                    {chatUsers.filter((u) => !(activeConv.participants ?? []).some((p) => p.id === u.id)).length > 0 && (
                      <>
                        <div className="px-3 py-2 border-t border-border text-xs font-semibold text-muted-foreground">
                          Adicionar vendedor
                        </div>
                        {chatUsers
                          .filter((u) => !(activeConv.participants ?? []).some((p) => p.id === u.id))
                          .map((u) => (
                            <button key={u.id} onClick={() => handleAddParticipant(u.id)}
                              className="w-full flex items-center gap-2 text-xs px-3 py-2 hover:bg-secondary transition">
                              <UserCircle2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="flex-1 text-left">{u.name}</span>
                              <Plus className="w-3 h-3 text-primary" />
                            </button>
                          ))}
                      </>
                    )}
                  </div>
                )}
              </div>
              {/* CRM — open / link customer record */}
              <button
                onClick={handleOpenCrm}
                disabled={crmLoading}
                data-testid="button-open-crm"
                className="p-2 rounded-lg bg-white border border-border hover:bg-secondary transition disabled:opacity-50"
                title="Abrir ficha do cliente no CRM"
              >
                {crmLoading
                  ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  : <IdCard className="w-3.5 h-3.5" />}
              </button>
              {/* Informações — toggle the customer info side panel */}
              <button
                onClick={() => setShowInfo((v) => !v)}
                data-testid="button-toggle-info"
                className={`p-2 rounded-lg border transition ${showInfo ? "bg-primary text-white border-primary" : "bg-white border-border hover:bg-secondary"}`}
                title="Informações do cliente"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
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
            ref={msgsContainerRef}
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
                {hasMoreOlder && (
                  <div className="flex justify-center pb-3">
                    <button
                      onClick={loadOlderMsgs}
                      disabled={loadingOlder}
                      data-testid="button-load-older"
                      className="text-xs bg-white/90 hover:bg-white text-primary font-medium px-4 py-1.5 rounded-full shadow-sm border border-border transition disabled:opacity-60"
                    >
                      {loadingOlder ? "Carregando..." : "Carregar mensagens antigas"}
                    </button>
                  </div>
                )}
                {messages.map((msg) => (
                  <MsgBubble
                    key={msg.id}
                    msg={msg}
                    onReply={setReplyTarget}
                    highlighted={highlightedMsgId === msg.id}
                    onJumpTo={scrollToMessage}
                  />
                ))}
                <div ref={msgsEndRef} />
              </>
            )}
          </div>

          {/* Barra "respondendo a": some ao enviar/cancelar, vale pro próximo texto ou anexo. */}
          {replyTarget && (
            <div className="flex items-center gap-2 bg-[#f0f2f5] border-t border-border px-3 pt-2" data-testid="reply-preview-bar">
              <div className="flex-1 min-w-0 bg-white border-l-4 border-primary/60 rounded-lg px-2.5 py-1.5">
                <div className="text-[11px] font-semibold text-primary">Respondendo a {replyTarget.senderName ?? "Cliente"}</div>
                <div className="text-xs text-muted-foreground truncate">{replyTarget.content}</div>
              </div>
              <button onClick={cancelReply} data-testid="button-cancel-reply" title="Cancelar resposta"
                className="p-1.5 rounded-md text-muted-foreground hover:bg-black/5 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Input — bloqueado até alguém iniciar o atendimento (assumir a conversa) */}
          {!activeConv.assignee && activeCategory !== "resolvidas" ? (
            <div className="bg-[#f0f2f5] border-t border-border px-3 py-3 flex flex-col items-center gap-1.5">
              <button
                onClick={() => {
                  if (activeCategory === "potenciais") {
                    setPromoteConfirm({ id: activeConv.id, name: activeConv.name, to: "ativos" });
                  } else {
                    handleClaim(activeConv.id);
                  }
                }}
                data-testid="button-start-attendance"
                className="flex items-center gap-2 px-6 py-2.5 rounded-full text-white text-sm font-semibold transition hover:opacity-90"
                style={{ backgroundColor: "#16a34a" }}
              >
                <UserCircle2 className="w-4 h-4" />
                Iniciar atendimento
              </button>
              <span className="text-[11px] text-muted-foreground">
                Para enviar mensagens, primeiro inicie o atendimento
              </span>
            </div>
          ) : (
          recording ? (
            <div className="bg-[#f0f2f5] border-t border-border px-3 py-2.5 flex items-center gap-3" data-testid="bar-recording">
              <button
                type="button"
                onClick={() => handleFinishRecording(false)}
                title="Cancelar gravação"
                data-testid="button-cancel-recording"
                className="w-9 h-9 rounded-full flex items-center justify-center text-red-500 hover:bg-red-50 transition shrink-0"
              >
                <Trash2 className="w-5 h-5" />
              </button>
              <div className="flex-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                <span>Gravando... {Math.floor(recordSecs / 60)}:{String(recordSecs % 60).padStart(2, "0")}</span>
              </div>
              <button
                type="button"
                onClick={() => handleFinishRecording(true)}
                title="Enviar áudio"
                data-testid="button-send-recording"
                className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white hover:bg-primary/90 transition shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          ) : (
          <>
          {/* Mensagem (vai pro cliente) x Nota interna (só a equipe vê) */}
          <div className="flex items-center gap-1 bg-[#f0f2f5] border-t border-border px-3 pt-2">
            <button type="button" onClick={() => setComposerMode("message")} data-testid="button-composer-mode-message"
              className={`text-xs font-medium px-2.5 py-1 rounded-full transition ${composerMode === "message" ? "bg-primary text-white" : "bg-white text-muted-foreground border border-border hover:bg-secondary"}`}>
              Mensagem
            </button>
            <button type="button" onClick={() => { setComposerMode("note"); cancelReply(); }} data-testid="button-composer-mode-note"
              className={`flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full transition ${composerMode === "note" ? "bg-amber-500 text-white" : "bg-white text-muted-foreground border border-border hover:bg-secondary"}`}>
              <StickyNote className="w-3 h-3" />
              Nota interna
            </button>
          </div>
          <form onSubmit={handleSend} className={`border-t border-border px-3 py-2.5 flex items-center gap-2 ${composerMode === "note" ? "bg-amber-50" : "bg-[#f0f2f5]"}`}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/3gpp,video/webm,video/quicktime,audio/ogg,audio/mpeg,audio/mp4,audio/webm,audio/aac,audio/wav,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) { handleFileSelected(file); }
                e.target.value = "";
              }}
            />
            {can(user, "enviar_midia") && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              title="Enviar foto ou documento"
              data-testid="button-attach-file"
              className="w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:bg-secondary transition shrink-0 disabled:opacity-40"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            )}
            {quickReplies.length > 0 && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowQuickReplies((v) => !v)}
                disabled={sending}
                title="Mensagens rápidas"
                data-testid="button-quick-replies"
                className="w-9 h-9 rounded-full flex items-center justify-center text-amber-600 bg-amber-100 hover:bg-amber-200 transition disabled:opacity-40"
              >
                <Zap className="w-4 h-4" />
              </button>
              {showQuickReplies && (
                <div className="absolute bottom-11 left-0 bg-white border border-border rounded-xl shadow-lg z-30 w-80 max-h-80 overflow-y-auto">
                  <div className="px-3 py-2 border-b border-border sticky top-0 bg-white">
                    <p className="text-xs font-semibold text-muted-foreground mb-1.5">Mensagens rápidas</p>
                    <input autoFocus value={quickSearch} onChange={(e) => setQuickSearch(e.target.value)}
                      placeholder="Buscar..." data-testid="input-quickreply-search"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-border text-xs focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  {quickReplies
                    .filter((q) => !quickSearch.trim() || `${q.title} ${q.content}`.toLowerCase().includes(quickSearch.toLowerCase()))
                    .map((q) => (
                    <button key={q.id} type="button" data-testid={`button-quickreply-${q.id}`}
                      onClick={() => {
                        // Substitui variáveis pelo nome do cliente e do vendedor
                        const firstName = (activeConv?.name ?? "").split(" ")[0] ?? "";
                        const content = q.content
                          .replaceAll("{cliente}", firstName)
                          .replaceAll("{vendedor}", user?.name?.split(" ")[0] ?? "");
                        setMsgText((prev) => prev ? `${prev} ${content}` : content);
                        setShowQuickReplies(false);
                        setQuickSearch("");
                        inputRef.current?.focus();
                      }}
                      className="w-full text-left px-3 py-2.5 hover:bg-secondary transition">
                      <p className="text-xs font-semibold">{q.title}</p>
                      <p className="text-[11px] text-muted-foreground line-clamp-2">{q.content}</p>
                    </button>
                  ))}
                  {quickReplies.filter((q) => !quickSearch.trim() || `${q.title} ${q.content}`.toLowerCase().includes(quickSearch.toLowerCase())).length === 0 && (
                    <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">Nenhuma mensagem encontrada</p>
                  )}
                  <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground sticky bottom-0 bg-white">
                    Dica: use {"{cliente}"} e {"{vendedor}"} nas mensagens — viram o nome real na hora de enviar.
                  </div>
                </div>
              )}
            </div>
            )}
            {can(user, "usar_ia") && (<>
            <button
              type="button"
              onClick={handleSuggestReply}
              disabled={sending || suggesting}
              title="Sugerir resposta com IA (revise antes de enviar)"
              data-testid="button-suggest-reply"
              className="h-9 px-3 rounded-full flex items-center gap-1.5 text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/20 transition shrink-0 disabled:opacity-40"
            >
              {suggesting
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : <Sparkles className="w-4 h-4" />}
              <span className="hidden sm:inline">Sugerir (IA)</span>
            </button>
            <button
              type="button"
              onClick={handleCorrectText}
              disabled={!msgText.trim() || correcting || sending}
              title="Corrigir ortografia com IA"
              data-testid="button-correct-text"
              className="h-9 px-3 rounded-full flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-100 hover:bg-emerald-200 transition shrink-0 disabled:opacity-40"
            >
              {correcting
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : <SpellCheck className="w-4 h-4" />}
              <span className="hidden sm:inline">Corrigir</span>
            </button>
            </>)}
            <input
              ref={inputRef}
              value={msgText}
              onChange={(e) => setMsgText(e.target.value)}
              placeholder={composerMode === "note" ? "Escreva uma nota interna (só a equipe vê)..." : "Digite uma mensagem..."}
              spellCheck
              lang="pt-BR"
              data-testid="input-message"
              className="flex-1 bg-white rounded-full px-4 py-2 text-sm border border-border outline-none focus:ring-2 focus:ring-primary/20"
              disabled={sending}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
            />
            {msgText.trim() ? (
              <button type="submit" disabled={sending} data-testid="button-send-message"
                className={`w-10 h-10 rounded-full flex items-center justify-center text-white disabled:opacity-40 transition shrink-0 ${composerMode === "note" ? "bg-amber-500 hover:bg-amber-600" : "bg-primary hover:bg-primary/90"}`}>
                <Send className="w-4 h-4" />
              </button>
            ) : composerMode === "message" && can(user, "enviar_midia") ? (
              <button type="button" onClick={handleStartRecording} disabled={sending}
                title="Gravar nota de voz" data-testid="button-record-audio"
                className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white hover:bg-primary/90 disabled:opacity-40 transition shrink-0">
                <Mic className="w-4 h-4" />
              </button>
            ) : (
              <button type="submit" disabled data-testid="button-send-message-disabled"
                className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white opacity-40 transition shrink-0">
                <Send className="w-4 h-4" />
              </button>
            )}
          </form>
          </>
          ))}
        </div>

        {/* ── Informações side panel ─────────────────────────────────────── */}
        {showInfo && (
          <aside className="fixed inset-0 z-40 w-full md:static md:z-auto md:w-80 shrink-0 md:border-l border-border bg-white flex flex-col overflow-hidden" data-testid="panel-info">
            <div className="bg-primary px-4 py-3 text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4" />
                <span className="font-semibold text-sm">Informações do cliente</span>
              </div>
              <button onClick={() => setShowInfo(false)} className="p-1 rounded-lg hover:bg-white/20 transition" title="Fechar">
                <X className="w-4 h-4" />
              </button>
            </div>
            {infoLoading || !infoContact ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Nome</label>
                  <input value={infoForm.name} onChange={(e) => setInfoForm({ ...infoForm, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Cidade</label>
                  <input value={infoForm.city} onChange={(e) => setInfoForm({ ...infoForm, city: e.target.value })}
                    placeholder="Governador Valadares"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Loja para atendimento</label>
                  <select value={infoForm.serviceStore} onChange={(e) => setInfoForm({ ...infoForm, serviceStore: e.target.value })}
                    data-testid="select-info-store"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">Sem loja</option>
                    {storesList.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                    {infoForm.serviceStore && !storesList.some((s) => s.name === infoForm.serviceStore) && (
                      <option value={infoForm.serviceStore}>{infoForm.serviceStore}</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">De onde veio o atendimento</label>
                  <select value={infoForm.attendanceSource} onChange={(e) => setInfoForm({ ...infoForm, attendanceSource: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    <option value="">— Selecione —</option>
                    {["WhatsApp", "Instagram", "Facebook", "Indicação", "Google", "Loja física", "Telefone", "Outro"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Observações</label>
                  <textarea value={infoForm.notes} onChange={(e) => setInfoForm({ ...infoForm, notes: e.target.value })}
                    rows={3} className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                {customDefs.length > 0 && (
                  <div className="space-y-3 pt-2 border-t border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Campos personalizados</p>
                    {customDefs.map((def) => {
                      const raw = infoCustomValues[String(def.id)];
                      const val = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
                      const set = (v: string) => setInfoCustomValues((prev) => ({ ...prev, [String(def.id)]: v }));
                      const cls = "w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";
                      return (
                        <div key={def.id}>
                          <label className="text-xs text-muted-foreground mb-1 block">{def.name}</label>
                          {def.type === "textarea" ? (
                            <textarea value={val} onChange={(e) => set(e.target.value)} rows={2} className={`${cls} resize-none`} />
                          ) : def.type === "select" ? (
                            <select value={val} onChange={(e) => set(e.target.value)} className={cls}>
                              <option value="">— Selecione —</option>
                              {(def.options ?? "").split(",").map((o) => o.trim()).filter(Boolean).map((o) => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          ) : (
                            <input type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                              value={val} onChange={(e) => set(e.target.value)} className={cls} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <button onClick={handleSaveInfo} disabled={infoSaving} data-testid="button-save-info"
                  className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition flex items-center justify-center gap-2 disabled:opacity-50">
                  {infoSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Salvar informações
                </button>
              </div>
            )}
          </aside>
        )}
        </div>
      )}

      {/* ── File preview modal ─────────────────────────────────────────── */}
      {filePreview && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <h3 className="font-bold text-base">
                {filePreview.previewUrl ? "Prévia da foto" : "Enviar documento"}
              </h3>
              <button onClick={handleCancelPreview} className="text-muted-foreground hover:text-foreground transition">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 pb-3">
              {filePreview.previewUrl ? (
                <img
                  src={filePreview.previewUrl}
                  alt="Prévia"
                  className="w-full max-h-64 object-contain rounded-xl bg-secondary/30"
                />
              ) : (
                <div className="flex items-center gap-3 p-4 bg-secondary/30 rounded-xl">
                  <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center shrink-0">
                    <FileText className="w-6 h-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{filePreview.file.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {(filePreview.file.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 pb-4">
              <input
                autoFocus
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Adicionar legenda (opcional)"
                data-testid="input-file-caption"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/20"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendFile(filePreview.file, caption.trim() || undefined);
                  }
                }}
              />
            </div>

            <div className="flex gap-2 px-5 pb-5">
              <button
                type="button"
                onClick={handleCancelPreview}
                data-testid="button-cancel-file-preview"
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="button-confirm-file-send"
                onClick={() => void handleSendFile(filePreview.file, caption.trim() || undefined)}
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition flex items-center justify-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmação de promoção: Potencial → Pendente/Ativo ──────────── */}
      {promoteConfirm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5">
            <h3 className="font-bold text-base mb-1.5">
              {promoteConfirm.to === "ativos" ? "Assumir este atendimento?" : "Enviar para a fila de atendimento?"}
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              {promoteConfirm.to === "ativos"
                ? <><strong>{promoteConfirm.name}</strong> ainda é um Potencial (só falou com o bot). Ao confirmar, você vira o responsável e a conversa sai da triagem direto para Ativos.</>
                : <><strong>{promoteConfirm.name}</strong> ainda é um Potencial (só falou com o bot). Ao confirmar, ela entra na fila de atendimento (Pendentes), pronta pra qualquer vendedor assumir.</>}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPromoteConfirm(null)}
                data-testid="button-cancel-promote"
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="button-confirm-promote"
                onClick={() => {
                  const { id, to } = promoteConfirm;
                  setPromoteConfirm(null);
                  if (to === "ativos") void handleClaim(id);
                  else void handleMoveToQueue(id);
                }}
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition"
              >
                {promoteConfirm.to === "ativos" ? "Assumir atendimento" : "Enviar para a fila"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CRM contact panel (opened from a conversation) ─────────────── */}
      {crmContactId !== null && (
        <CrmContactDetail
          key={crmContactId}
          contactId={crmContactId}
          onClose={() => setCrmContactId(null)}
          onContactUpdated={() => {}}
          sectors={sectors}
        />
      )}

      {/* ── Etiquetas manager modal ────────────────────────────────────── */}
      {showLabelManager && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold flex items-center gap-2"><Tag className="w-4 h-4 text-primary" /> Gerenciar Etiquetas</h3>
              <button onClick={() => setShowLabelManager(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>

            {/* Create form */}
            <div className="bg-secondary/50 rounded-xl p-3 mb-4 space-y-2">
              <label className="text-xs font-medium block">Nova etiqueta</label>
              <input value={labelForm.name}
                onChange={(e) => setLabelForm({ ...labelForm, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleCreateLabel(); } }}
                placeholder="Ex.: VIP, Urgente, Promoção…"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              <div className="flex items-center gap-1.5 flex-wrap">
                {LABEL_COLOR_PRESETS.map((c) => (
                  <button key={c} type="button" onClick={() => setLabelForm({ ...labelForm, color: c })}
                    className={`w-6 h-6 rounded-full border-2 transition ${labelForm.color === c ? "border-foreground scale-110" : "border-transparent"}`}
                    style={{ backgroundColor: c }} aria-label={`Cor ${c}`} />
                ))}
              </div>
              <button onClick={handleCreateLabel} disabled={savingLabel}
                className="w-full flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2 rounded-xl bg-primary text-white hover:opacity-90 transition disabled:opacity-50">
                <Plus className="w-4 h-4" /> {savingLabel ? "Salvando…" : "Adicionar etiqueta"}
              </button>
            </div>

            {/* Existing labels */}
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {labels.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Nenhuma etiqueta criada ainda.</p>
              ) : (
                labels.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-border">
                    <span className="flex items-center gap-2 text-sm">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                      {l.name}
                    </span>
                    <button onClick={() => handleDeleteLabel(l.id)}
                      className="text-muted-foreground hover:text-red-600 transition" title="Excluir etiqueta">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Alarme fixo de conversas sem resposta (tipo despertador) ──────
          Renderizado num portal (document.body) para aparecer em QUALQUER
          tela, mesmo com o ChatCenter escondido em outra aba. */}
      {alarmConvs.length > 0 && createPortal(
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-1.5rem)] max-w-lg" data-testid="alarm-banner">
          <div className="bg-red-600 text-white rounded-2xl shadow-2xl border-4 border-red-300 animate-pulse-slow p-4"
            style={{ animation: "pulse 1.5s ease-in-out infinite" }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 font-extrabold text-base">
                <span className="text-2xl animate-bounce inline-block">⏰</span>
                {alarmConvs.length === 1 ? "1 cliente sem resposta!" : `${alarmConvs.length} clientes sem resposta!`}
              </div>
              <button
                onClick={() => setAlarmMuted((prev) => { const n = new Set(prev); for (const c of alarmConvs) n.add(c.id); return n; })}
                data-testid="button-alarm-mute"
                className="text-xs font-bold bg-white/20 hover:bg-white/30 rounded-lg px-2.5 py-1.5 shrink-0">
                🔕 Silenciar
              </button>
            </div>
            <div className="flex gap-2 mt-2 flex-wrap text-xs font-bold">
              {alarmByCat.potenciais! > 0 && <span className="bg-yellow-400 text-yellow-950 rounded-full px-2.5 py-1">🟡 Potenciais: {alarmByCat.potenciais}</span>}
              {alarmByCat.pendentes! > 0 && <span className="bg-orange-300 text-orange-950 rounded-full px-2.5 py-1">🟠 Pendentes: {alarmByCat.pendentes}</span>}
              {alarmByCat.ativos! > 0 && <span className="bg-white text-red-700 rounded-full px-2.5 py-1">🔴 Ativos: {alarmByCat.ativos}</span>}
            </div>
            <div className="mt-2 space-y-1">
              {alarmConvs.slice(0, 4).map((c) => (
                <button key={c.id}
                  onClick={() => {
                    setCategory(conversationCategory(c)); setActiveId(c.id);
                    // Se o usuário estiver em outra aba, pede para o painel voltar ao chat.
                    window.dispatchEvent(new CustomEvent("sheikcell:open-chat"));
                  }}
                  data-testid={`button-alarm-open-${c.id}`}
                  className="w-full text-left text-sm bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 font-semibold truncate">
                  💬 {c.name} — esperando há {Math.max(1, Math.floor((nowTick - new Date(c.lastMessageAt!).getTime()) / 60000))} min
                </button>
              ))}
              {alarmConvs.length > 4 && <div className="text-xs font-semibold opacity-90">… e mais {alarmConvs.length - 4}</div>}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Configuração do alerta de sem resposta ──────────────────────── */}
      {showAlertCfg && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowAlertCfg(false)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold">⏰ Configurações do Atendimento</h3>
              <button onClick={() => setShowAlertCfg(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={cfgEnabled} onChange={(e) => setCfgEnabled(e.target.checked)} />
              Alertar quando o cliente ficar sem resposta
            </label>
            <div>
              <label className="text-sm font-semibold">Tempo para alertar (minutos)</label>
              <input type="number" min={1} max={120} value={cfgMinutes}
                onChange={(e) => setCfgMinutes(Number(e.target.value))}
                data-testid="input-alert-minutes"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
              <p className="text-xs text-muted-foreground mt-1">Vale para toda a equipe. Cada área tem um toque diferente (Potenciais, Pendentes e Ativos) e o alarme fica na tela repetindo até responder ou silenciar.</p>
            </div>
            <div className="pt-2 border-t border-border">
              <label className="text-sm font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                Limite do Atendimento ativo (WhatsApp)
              </label>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                Trava anti-disparo em massa: quantas conversas cada atendente pode INICIAR (não responder) por WhatsApp. Passou do limite, só amanhã/na próxima hora.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">Por hora</label>
                  <input type="number" min={1} max={200} value={cfgOutboundHourly}
                    onChange={(e) => setCfgOutboundHourly(Number(e.target.value))}
                    data-testid="input-outbound-hourly-limit"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Por dia</label>
                  <input type="number" min={1} max={1000} value={cfgOutboundDaily}
                    onChange={(e) => setCfgOutboundDaily(Number(e.target.value))}
                    data-testid="input-outbound-daily-limit"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                </div>
              </div>
            </div>
            <button
              onClick={async () => {
                const mins = Math.round(cfgMinutes);
                if (!Number.isFinite(mins) || mins < 1 || mins > 120) {
                  toast({ title: "Tempo inválido", description: "Use entre 1 e 120 minutos.", variant: "destructive" });
                  return;
                }
                const hourly = Math.round(cfgOutboundHourly);
                const daily = Math.round(cfgOutboundDaily);
                if (!Number.isFinite(hourly) || hourly < 1 || hourly > 200) {
                  toast({ title: "Limite por hora inválido", description: "Use entre 1 e 200.", variant: "destructive" });
                  return;
                }
                if (!Number.isFinite(daily) || daily < 1 || daily > 1000) {
                  toast({ title: "Limite por dia inválido", description: "Use entre 1 e 1000.", variant: "destructive" });
                  return;
                }
                setSavingAlertCfg(true);
                try {
                  const s = await api.settings.update({
                    alertUnansweredEnabled: cfgEnabled, alertUnansweredMinutes: mins,
                    outboundHourlyLimit: hourly, outboundDailyLimit: daily,
                  });
                  setAlertEnabled(s.alertUnansweredEnabled);
                  setAlertMinutes(s.alertUnansweredMinutes);
                  setCfgOutboundHourly(s.outboundHourlyLimit);
                  setCfgOutboundDaily(s.outboundDailyLimit);
                  setShowAlertCfg(false);
                  toast({ title: "Configurações salvas! ✅", description: s.alertUnansweredEnabled ? `Avisa após ${s.alertUnansweredMinutes} min sem resposta.` : "Alerta desligado para toda a equipe." });
                } catch (err) {
                  toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                } finally {
                  setSavingAlertCfg(false);
                }
              }}
              disabled={savingAlertCfg}
              data-testid="button-save-alert-cfg"
              className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm disabled:opacity-50">
              {savingAlertCfg ? "Salvando..." : "Salvar"}
            </button>
          </div>
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
              <div>
                <label className="text-xs font-medium mb-1 block">Atendente responsável</label>
                {user?.role === "vendedor" ? (
                  <div className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-secondary/40 text-muted-foreground">
                    Você ({user.name}) — atendimento ativo já sai como seu
                  </div>
                ) : (
                  <select value={newForm.assigneeId} onChange={(e) => setNewForm({ ...newForm, assigneeId: e.target.value })}
                    data-testid="select-new-conv-assignee"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    <option value="">— Deixar na fila (sem responsável) —</option>
                    {chatUsers.filter((u) => u.role !== "admin" && u.role !== "supervisor" && u.role !== "superadmin").map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                )}
              </div>
              {newForm.channel === "whatsapp" && (newForm.assigneeId || user?.role === "vendedor") && (
                <div className={`rounded-xl border p-3 text-xs space-y-1 ${outboundUsage && (outboundUsage.hourly.used >= outboundUsage.hourly.limit || outboundUsage.daily.used >= outboundUsage.daily.limit) ? "bg-red-50 border-red-200 text-red-700" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
                  <p className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    Atendimento ativo por WhatsApp (Baileys, sem API oficial da Meta)
                  </p>
                  <p>Iniciar conversa com quem não fala com a loja tem risco real de o número ser bloqueado por uso indevido. Use com moderação.</p>
                  {outboundUsage && (
                    <p className="font-medium pt-1 border-t border-current/20">
                      Uso desse atendente: {outboundUsage.hourly.used}/{outboundUsage.hourly.limit} nesta hora · {outboundUsage.daily.used}/{outboundUsage.daily.limit} hoje
                    </p>
                  )}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowNewConv(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">Cancelar</button>
                <button type="submit" data-testid="button-confirm-new-conv"
                  disabled={!!outboundUsage && (outboundUsage.hourly.used >= outboundUsage.hourly.limit || outboundUsage.daily.used >= outboundUsage.daily.limit)}
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed">Criar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Finalizar atendimento: motivo ──────────────────────────────── */}
      {/* Modal de agendamento: mensagem programada ou lembrete de retorno */}
      {showSchedule && activeConv && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowSchedule(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-indigo-600" />
                Agendar — {activeConv.name}
              </h3>
              <button onClick={() => setShowSchedule(false)} className="p-1 rounded-lg hover:bg-secondary"><X className="w-4 h-4" /></button>
            </div>

            <div className="flex gap-2">
              {([["mensagem", "Enviar mensagem"], ["retorno", "Lembrete de retorno"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setSchedForm((f) => ({ ...f, kind: k }))}
                  className={`flex-1 text-xs font-semibold px-3 py-2 rounded-xl border transition ${schedForm.kind === k ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-border hover:bg-secondary"}`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {schedForm.kind === "mensagem"
                ? "A mensagem será enviada automaticamente ao cliente no horário escolhido. Também criamos uma tarefa no quadro."
                : "Nada é enviado ao cliente: criamos uma tarefa no quadro de Tarefas como lembrete para você retornar."}
            </p>

            <textarea
              value={schedForm.content}
              onChange={(e) => setSchedForm((f) => ({ ...f, content: e.target.value }))}
              placeholder={schedForm.kind === "mensagem" ? "Texto da mensagem para o cliente..." : "Anotação do retorno (ex.: ligar para confirmar orçamento)..."}
              rows={3}
              className="w-full text-sm border border-border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
              data-testid="input-schedule-content"
            />
            <input
              type="datetime-local"
              value={schedForm.sendAt}
              onChange={(e) => setSchedForm((f) => ({ ...f, sendAt: e.target.value }))}
              className="w-full text-sm border border-border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-200"
              data-testid="input-schedule-datetime"
            />
            <button
              onClick={submitSchedule}
              disabled={schedSaving}
              className="w-full py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-50"
              data-testid="button-schedule-submit"
            >
              {schedSaving ? "Agendando..." : schedForm.kind === "mensagem" ? "Agendar mensagem" : "Agendar retorno"}
            </button>

            {schedules.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">Agendamentos pendentes</p>
                {schedules.map((s) => (
                  <div key={s.id} className="flex items-start gap-2 border border-border rounded-xl p-2.5">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${s.kind === "mensagem" ? "bg-indigo-100 text-indigo-700" : "bg-amber-100 text-amber-700"}`}>
                      {s.kind === "mensagem" ? "Mensagem" : "Retorno"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground line-clamp-2">{s.content}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(s.sendAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                    <button onClick={() => cancelSchedule(s.id)} title="Cancelar agendamento"
                      className="p-1 rounded-lg text-red-600 hover:bg-red-50 transition shrink-0" data-testid={`button-cancel-schedule-${s.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {finalizeTarget != null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => { if (!finalizing) setFinalizeTarget(null); }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="text-base font-semibold">Finalizar atendimento</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Selecione o motivo da finalização.</p>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Motivo</label>
              <select value={finalizeReason} onChange={(e) => setFinalizeReason(e.target.value)}
                data-testid="select-finalize-reason"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                {FINALIZE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            {finalizeReason === "Outro" && (
              <div>
                <label className="text-xs font-medium mb-1 block">Descreva o motivo</label>
                <textarea value={finalizeDetail} onChange={(e) => setFinalizeDetail(e.target.value)}
                  rows={3} autoFocus data-testid="input-finalize-detail"
                  placeholder="Ex.: cliente pediu para retornar amanhã"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
              </div>
            )}
            {/* Teve venda? Valor entra como compra no CRM do cliente */}
            <div>
              <label className="text-xs font-medium mb-1 block">Teve venda neste atendimento?</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setFinalizeHadSale(true)} data-testid="button-sale-yes"
                  className={`flex-1 py-2 rounded-xl border text-sm font-semibold transition ${finalizeHadSale === true ? "bg-green-600 text-white border-green-600" : "border-border hover:bg-secondary"}`}>
                  Sim 💰
                </button>
                <button type="button" onClick={() => setFinalizeHadSale(false)} data-testid="button-sale-no"
                  className={`flex-1 py-2 rounded-xl border text-sm font-semibold transition ${finalizeHadSale === false ? "bg-gray-600 text-white border-gray-600" : "border-border hover:bg-secondary"}`}>
                  Não
                </button>
              </div>
            </div>
            {finalizeHadSale === true && (
              <div className="space-y-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Valor da venda (R$)</label>
                  <input type="text" inputMode="decimal" value={finalizeSaleAmount}
                    onChange={(e) => setFinalizeSaleAmount(e.target.value)}
                    placeholder="Ex.: 1500,00" autoFocus data-testid="input-sale-amount"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">O que foi vendido? (opcional)</label>
                  <input type="text" value={finalizeSaleDesc}
                    onChange={(e) => setFinalizeSaleDesc(e.target.value)}
                    placeholder="Ex.: iPhone 13 128GB + película" data-testid="input-sale-desc"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setFinalizeTarget(null)} disabled={finalizing}
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={submitFinalize} disabled={finalizing}
                data-testid="button-confirm-finalize"
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
                {finalizing ? "Finalizando…" : "Finalizar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
