import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { api, can, ApiError, type Conversation, type ChatMessage, type Sector, type ChatLabel, type User, type CrmContact, type CrmCustomField, type QuickReply, type ScheduledMessage, type ChatNotification, type Store as StoreType, type OutboundUsage, type MessageMetadata } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useActivityGuard } from "@/lib/activityGuard";
import { useToast } from "@/hooks/use-toast";
import {
  Search, Plus, Send, RefreshCw, X, ChevronDown, SpellCheck,
  MessageCircle, CheckCheck, AlertCircle, Tag, Filter,
  Smartphone, Instagram, UserCircle2, Circle,
  ArrowRightLeft, FileText, Volume2, Image, Video, Mic, Users, Paperclip, IdCard,
  Settings2, Trash2, Info, Sparkles, Check, Bell, BellOff, VolumeX, Zap, CalendarClock, AlertTriangle,
  Pin, PinOff, Reply, StickyNote, Star, StarOff, ChevronLeft, ChevronRight,
  MapPin, ShoppingBag, CreditCard, BarChart3, Ban, UserPlus, ExternalLink,
  FileSpreadsheet, FileArchive, File as FileGeneric, Globe, Download, Maximize2,
} from "lucide-react";
import CrmContactDetail from "@/components/CrmContactDetail";
import { acquireSharedEventSource, releaseSharedEventSource } from "@/lib/sharedEventSource";
import { MediaLightboxProvider, useMediaLightbox } from "@/components/MediaLightbox";
import { PdfBubble } from "@/components/PdfPreview";

const CHAT_EVENTS_URL = "/api/chat/events";

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
type Category = "potenciais" | "pendentes" | "ativos" | "resolvidas" | "favoritos";
// "favoritos" é ortogonal às outras 4 (uma conversa favoritada pode estar em
// qualquer uma delas) — tratado à parte em conversationCategory()/filteredConvs.
const CATEGORIES: { id: Category; label: string; help: string; color: string }[] = [
  { id: "favoritos", label: "Favoritos", help: "Contatos marcados com estrela, de qualquer status", color: "#eab308" },
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

// Texto colado de Word/PDF/sites: normaliza aspas curvas, espaço sem quebra,
// caracteres invisíveis e traços longos pra texto limpo — o WhatsApp não
// renderiza esses caracteres de forma confiável em todos os aparelhos.
// Preserva quebras de linha (só normaliza o fim de linha).
function cleanPastedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/[​-‍﻿]/g, "");
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

// Avatar do cabeçalho da conversa, clicável pra ver a foto de perfil em tela
// cheia — reaproveita o mesmo MediaLightbox das fotos/vídeos de mensagem
// (useMediaLightbox precisa estar dentro do próprio <MediaLightboxProvider>,
// por isso vira um sub-componente em vez de só um onClick na função Avatar).
function HeaderAvatar({ name, src }: { name: string; src?: string | null }) {
  const openLightbox = useMediaLightbox();
  if (!src) return <Avatar name={name} src={src} size="md" />;
  return (
    <button
      type="button"
      onClick={() => openLightbox({ type: "image", src })}
      title="Ver foto de perfil"
      data-testid="button-open-profile-photo"
      className="rounded-full shrink-0 focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      <Avatar name={name} src={src} size="md" />
    </button>
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
function ConvItem({ conv, active, onClick, onTogglePin, sessionBadge, overdue }: { conv: Conversation; active: boolean; onClick: () => void; onTogglePin: () => void; sessionBadge?: string | null; overdue?: boolean }) {
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
            {conv.name}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); onTogglePin(); } }}
              data-testid={`button-favorite-${conv.id}`}
              title={conv.pinned ? "Remover dos favoritos" : "Favoritar este contato"}
              className="p-0.5 -m-0.5 rounded hover:bg-amber-100 transition"
            >
              {conv.pinned
                ? <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" data-testid={`favorite-indicator-${conv.id}`} />
                : <Star className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-amber-500" />}
            </span>
            <span className="text-xs text-muted-foreground">{timeAgo(conv.lastMessageAt)}</span>
          </span>
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

/** Mensagem de mídia indisponível (arquivo apagado/movido no servidor, ou
 * formato que o navegador não consegue tocar) — mostra erro em vez de um
 * player quebrado/mudo, com um jeito de tentar abrir/baixar mesmo assim. */
function MediaUnavailable({ mediaUrl, label }: { mediaUrl: string; label: string }) {
  return (
    <div className="flex items-center gap-2 bg-red-50 rounded-xl px-3 py-2 min-w-[200px]">
      <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-red-700">{label}</p>
        <a href={`${mediaUrl}?download=1`} download className="text-[11px] font-semibold text-primary underline">
          Tentar baixar mesmo assim
        </a>
      </div>
    </div>
  );
}

/** Áudio com botão de transcrição (Whisper). */
function AudioBubble({ msg }: { msg: ChatMessage }) {
  const [local, setLocal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
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

  if (mediaError && msg.mediaUrl) {
    return <MediaUnavailable mediaUrl={msg.mediaUrl} label="Áudio indisponível no servidor" />;
  }

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 bg-black/5 rounded-xl px-3 py-2 min-w-[200px]">
        <Volume2 className="w-4 h-4 text-primary shrink-0" />
        <audio controls className="flex-1 h-8 max-w-[200px]" style={{ minWidth: 0 }} onError={() => setMediaError(true)}>
          <source src={msg.mediaUrl ?? undefined} />
        </audio>
        <a href={`${msg.mediaUrl}?download=1`} download title="Baixar áudio"
          className="text-gray-500 hover:text-primary shrink-0">
          <Download className="w-3.5 h-3.5" />
        </a>
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

/** Vídeo com fallback de erro — cobre tanto arquivo indisponível no servidor
 * quanto formato que o navegador não consegue tocar (ex.: .mov de iPhone em
 * alguns navegadores): nesses casos o <video> dispara onError, e mostramos
 * baixar/abrir em vez de um player preto travado. */
function VideoBubble({ msg }: { msg: ChatMessage }) {
  const [mediaError, setMediaError] = useState(false);
  const openLightbox = useMediaLightbox();
  if (!msg.mediaUrl) return null;
  const url = msg.mediaUrl;

  if (mediaError) {
    return <MediaUnavailable mediaUrl={url} label="Não foi possível tocar este vídeo no navegador" />;
  }

  return (
    <div className="mb-1">
      <div className="relative w-fit">
        <video
          controls
          preload="metadata"
          className="max-w-full rounded-xl max-h-64 bg-black"
          style={{ minWidth: 200 }}
          onError={() => setMediaError(true)}
        >
          <source src={url} />
        </video>
        <button
          onClick={() => openLightbox({ type: "video", src: url, mimeType: msg.metadata?.mimeType })}
          title="Expandir vídeo"
          data-testid={`button-expand-video-${msg.id}`}
          className="absolute top-1.5 right-1.5 bg-black/50 hover:bg-black/70 text-white rounded-full p-1"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <a href={`${url}?download=1`} download
        className="flex items-center gap-1 text-[11px] font-semibold text-primary underline mt-0.5 w-fit">
        <Download className="w-3 h-3" /> Baixar vídeo
      </a>
    </div>
  );
}

function MediaContentRest({ msg }: { msg: ChatMessage }) {
  const openLightbox = useMediaLightbox();
  if (!msg.mediaUrl) return null;

  if (msg.type === "image") {
    const url = msg.mediaUrl;
    return (
      <button onClick={() => openLightbox({ type: "image", src: url })} className="block mb-1" data-testid={`button-open-image-${msg.id}`}>
        <img
          src={url}
          alt="Foto"
          className="max-w-full rounded-xl object-cover max-h-64 cursor-pointer hover:opacity-90 transition"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      </button>
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
    return <VideoBubble msg={msg} />;
  }

  if (msg.type === "doc") {
    const filename = msg.metadata?.fileName ?? msg.mediaUrl.split("/").pop() ?? "documento";
    const size = formatFileSize(msg.metadata?.fileSize);
    const isPdf = msg.metadata?.mimeType?.includes("pdf") || filename.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      return (
        <PdfBubble
          src={msg.mediaUrl}
          fileName={filename}
          sizeLabel={size || undefined}
          icon={<DocIcon mimeType={msg.metadata?.mimeType} fileName={filename} />}
        />
      );
    }
    return (
      <a
        href={msg.mediaUrl}
        target="_blank"
        rel="noopener noreferrer"
        download
        className="flex items-center gap-2 mb-1 bg-black/5 rounded-xl px-3 py-2 hover:bg-black/10 transition"
      >
        <DocIcon mimeType={msg.metadata?.mimeType} fileName={filename} />
        <div className="min-w-0">
          <p className="text-xs text-gray-700 break-all">{filename}</p>
          {size && <p className="text-[10px] text-gray-500">{size}</p>}
        </div>
      </a>
    );
  }

  return null;
}

// ─── Ícone/tamanho de documento ──────────────────────────────────────────
// Nome/tamanho reais vêm de metadata (capturados no envio/recebimento); sem
// isso (mensagens antigas) cai no nome de arquivo do mediaUrl, como antes.
function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocIcon({ mimeType, fileName }: { mimeType?: string; fileName?: string }) {
  const ext = (fileName?.split(".").pop() || "").toLowerCase();
  if (mimeType?.includes("pdf") || ext === "pdf") return <FileText className="w-5 h-5 text-red-500 shrink-0" />;
  if (mimeType?.includes("word") || ["doc", "docx"].includes(ext)) return <FileText className="w-5 h-5 text-blue-600 shrink-0" />;
  if (mimeType?.includes("sheet") || mimeType?.includes("excel") || ["xls", "xlsx", "csv"].includes(ext)) return <FileSpreadsheet className="w-5 h-5 text-emerald-600 shrink-0" />;
  if (mimeType?.includes("zip") || mimeType?.includes("compressed") || ["zip", "rar", "7z"].includes(ext)) return <FileArchive className="w-5 h-5 text-amber-600 shrink-0" />;
  return <FileGeneric className="w-5 h-5 text-primary shrink-0" />;
}

// ─── Preview de link (OG tags) ───────────────────────────────────────────
// Buscado sob demanda pelo backend só pra mensagens de texto da própria
// equipe (não pra mensagens recebidas de clientes — ver linkPreview.ts) e
// chega de forma assíncrona via SSE, então pode não estar presente ainda
// mesmo numa mensagem que tem link (sem loading spinner, aparece quando chegar).
function LinkPreviewCard({ preview }: { preview: NonNullable<MessageMetadata["linkPreview"]> }) {
  let hostname = "";
  try { hostname = new URL(preview.url).hostname.replace(/^www\./, ""); } catch { /* URL inválida, ignora */ }
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block mt-1 rounded-xl border border-black/10 overflow-hidden bg-black/5 hover:bg-black/10 transition max-w-xs"
    >
      {preview.image && (
        <img
          src={preview.image}
          alt=""
          className="w-full max-h-40 object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1 text-[10px] text-gray-500 mb-0.5">
          <Globe className="w-3 h-3 shrink-0" />
          <span className="truncate">{preview.siteName || hostname}</span>
        </div>
        {preview.title && <p className="text-xs font-semibold text-gray-800 line-clamp-2">{preview.title}</p>}
        {preview.description && <p className="text-[11px] text-gray-600 line-clamp-2 mt-0.5">{preview.description}</p>}
      </div>
    </a>
  );
}

// ─── Shared contact card ─────────────────────────────────────────────────
// O backend grava contato compartilhado do WhatsApp como texto formatado
// ("👤 Contato compartilhado: Nome — Telefone", ou uma lista com o prefixo
// "👤 Contatos compartilhados:\n") pra manter busca/prévia/notificação
// funcionando sem mudar o schema — aqui só reconstituímos os campos pra
// desenhar o cartão.
type SharedContact = { name: string; phone: string | null };
const CONTACT_SINGLE_PREFIX = "👤 Contato compartilhado: ";
const CONTACT_MULTI_PREFIX = "👤 Contatos compartilhados:\n";

function parseContactLine(line: string): SharedContact {
  const idx = line.lastIndexOf(" — ");
  return idx === -1
    ? { name: line.trim(), phone: null }
    : { name: line.slice(0, idx).trim(), phone: line.slice(idx + 3).trim() || null };
}

function parseSharedContacts(content: string): SharedContact[] | null {
  if (content.startsWith(CONTACT_MULTI_PREFIX)) {
    const lines = content.slice(CONTACT_MULTI_PREFIX.length).split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines.map(parseContactLine) : null;
  }
  if (content.startsWith(CONTACT_SINGLE_PREFIX)) {
    return [parseContactLine(content.slice(CONTACT_SINGLE_PREFIX.length))];
  }
  return null;
}

function ContactCard({ contact, onStart }: { contact: SharedContact; onStart?: (c: SharedContact) => void }) {
  return (
    <div className="flex items-center gap-2.5 bg-black/5 rounded-xl px-3 py-2.5 min-w-[220px] max-w-full mb-1">
      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <UserCircle2 className="w-6 h-6 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-800 truncate">{contact.name}</p>
        {contact.phone && <p className="text-xs text-gray-500 truncate">{contact.phone}</p>}
      </div>
      {contact.phone && onStart && (
        <button
          type="button"
          onClick={() => onStart(contact)}
          title="Iniciar atendimento com este contato"
          data-testid={`button-start-shared-contact-${contact.phone}`}
          className="shrink-0 p-2 rounded-full text-primary hover:bg-primary/10 transition"
        >
          <MessageCircle className="w-4 h-4" />
        </button>
      )}
    </div>
  );
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

// ─── Poll card ───────────────────────────────────────────────────────────
// Backend grava enquete como texto formatado ("📊 Enquete: Pergunta\n•
// opção 1\n• opção 2") pra manter busca/prévia funcionando — aqui só
// reconstituímos os campos pra desenhar o cartão.
const POLL_PREFIX = "📊 Enquete: ";
function parsePoll(content: string): { question: string; options: string[] } | null {
  if (!content.startsWith(POLL_PREFIX)) return null;
  const lines = content.slice(POLL_PREFIX.length).split("\n");
  const question = lines[0]?.trim() ?? "";
  const options = lines.slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("• "))
    .map((l) => l.slice(2).trim());
  return { question, options };
}

function PollCard({ content }: { content: string }) {
  const poll = parsePoll(content);
  if (!poll) return <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{content}</p>;
  return (
    <div className="min-w-[220px] max-w-full mb-1">
      <div className="flex items-center gap-1.5 mb-1.5">
        <BarChart3 className="w-4 h-4 text-primary shrink-0" />
        <p className="text-sm font-semibold text-gray-800">{poll.question}</p>
      </div>
      {poll.options.length > 0 && (
        <div className="flex flex-col gap-1">
          {poll.options.map((o, i) => (
            <div key={i} className="flex items-center gap-2 bg-black/5 rounded-lg px-2.5 py-1.5">
              <Circle className="w-3 h-3 text-gray-400 shrink-0" />
              <span className="text-sm text-gray-700">{o}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Location card ───────────────────────────────────────────────────────
function parseLocation(content: string): { label: string; link: string | null } {
  const nl = content.indexOf("\n");
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  const link = nl === -1 ? null : content.slice(nl + 1).trim() || null;
  const label = firstLine.replace(/^📍\s*/, "").replace(/^Localização(\s*em tempo real compartilhada)?:?\s*/, "").trim();
  return { label, link };
}

function LocationCard({ content }: { content: string }) {
  const { label, link } = parseLocation(content);
  return (
    <a
      href={link ?? undefined}
      target={link ? "_blank" : undefined}
      rel={link ? "noopener noreferrer" : undefined}
      className={`flex items-center gap-2.5 bg-black/5 rounded-xl px-3 py-2.5 min-w-[220px] max-w-full mb-1 ${link ? "hover:bg-black/10 transition" : ""}`}
    >
      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <MapPin className="w-5 h-5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-800">{label || "Localização compartilhada"}</p>
        {link && <p className="text-xs text-primary flex items-center gap-0.5">Abrir no mapa <ExternalLink className="w-3 h-3" /></p>}
      </div>
    </a>
  );
}

// ─── Catalog product card ────────────────────────────────────────────────
function parseProduct(content: string): { title: string; description: string; url: string | null } {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const title = (lines[0] ?? "").replace(/^🛍️\s*/, "").trim();
  const rest = lines.slice(1);
  const last = rest[rest.length - 1] ?? "";
  const hasUrl = /^https?:\/\//.test(last.trim());
  const url = hasUrl ? last.trim() : null;
  const description = (hasUrl ? rest.slice(0, -1) : rest).join("\n").trim();
  return { title, description, url };
}

function ProductCard({ content }: { content: string }) {
  const { title, description, url } = parseProduct(content);
  return (
    <div className="min-w-[220px] max-w-full mb-1 bg-black/5 rounded-xl px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <ShoppingBag className="w-5 h-5 text-primary" />
        </div>
        <p className="text-sm font-semibold text-gray-800">{title}</p>
      </div>
      {description && <p className="text-xs text-gray-600 mt-1.5 whitespace-pre-wrap break-words">{description}</p>}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary flex items-center gap-0.5 mt-1.5">
          Ver produto <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}

// ─── Simple icon+text cards (pagamento, convite de grupo) ────────────────
// Conteúdo já vem totalmente descritivo do backend — só precisa de um
// cartão visual em vez do balão de texto genérico.
function IconTextCard({ icon: Icon, content }: { icon: typeof CreditCard; content: string }) {
  return (
    <div className="flex items-center gap-2.5 bg-black/5 rounded-xl px-3 py-2.5 min-w-[200px] max-w-full mb-1">
      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <p className="text-sm text-gray-800 whitespace-pre-wrap break-words flex-1">{content}</p>
    </div>
  );
}

// ─── Message bubble ─────────────────────────────────────────────────────────
function MsgBubble({ msg, onReply, highlighted, onJumpTo, isGroup, onStartConversation }: {
  msg: ChatMessage;
  onReply: (m: ChatMessage) => void;
  highlighted: boolean;
  onJumpTo: (id: number) => void;
  isGroup: boolean;
  onStartConversation?: (c: { name: string; phone: string | null }) => void;
}) {
  const out = msg.direction === "outbound";
  const isMedia = msg.type === "image" || msg.type === "video" || msg.type === "audio" || msg.type === "doc" || msg.type === "sticker";
  const mediaCaption = isMedia ? extractMediaCaption(msg.content) : "";
  const showCaption = isMedia && msg.mediaUrl && mediaCaption.length > 0;
  const sharedContacts = msg.type === "contact" ? parseSharedContacts(msg.content) : null;

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
          isGroup && msg.senderPhone && onStartConversation ? (
            <button
              onClick={() => onStartConversation({ name: msg.senderName!, phone: msg.senderPhone! })}
              data-testid={`button-start-participant-${msg.id}`}
              title="Iniciar conversa individual com este participante"
              className="text-xs font-semibold text-primary mb-1 hover:underline"
            >
              {msg.senderName}
            </button>
          ) : (
            <p className="text-xs font-semibold text-primary mb-1">{msg.senderName}</p>
          )
        )}
        {/* Quem da equipe enviou — visível pra qualquer vendedor que abra esta
            conversa depois (ex.: após transferência), não só quem respondeu.
            Data/hora já aparece sempre, junto ao status de entrega, mais abaixo. */}
        {out && msg.senderName && (
          <p className="text-[11px] font-semibold text-gray-600 mb-1 text-right" data-testid={`text-sender-${msg.id}`}>{msg.senderName}</p>
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
        {msg.deletedAt ? (
          <div className="flex items-center gap-1.5 text-sm text-gray-400 italic">
            <Ban className="w-3.5 h-3.5 shrink-0" />
            <span>Esta mensagem foi apagada</span>
          </div>
        ) : sharedContacts ? (
          <>
            {sharedContacts.map((c, i) => (
              <ContactCard key={i} contact={c} onStart={onStartConversation} />
            ))}
          </>
        ) : msg.type === "poll" ? (
          <PollCard content={msg.content} />
        ) : msg.type === "location" ? (
          <LocationCard content={msg.content} />
        ) : msg.type === "product" ? (
          <ProductCard content={msg.content} />
        ) : msg.type === "payment" ? (
          <IconTextCard icon={CreditCard} content={msg.content} />
        ) : msg.type === "group_invite" ? (
          <IconTextCard icon={UserPlus} content={msg.content} />
        ) : isMedia && msg.mediaUrl ? (
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
          <>
            <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{msg.content}</p>
            {msg.metadata?.linkPreview && <LinkPreviewCard preview={msg.metadata.linkPreview} />}
          </>
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
type ChatCenterProps = {
  // Painel compacto do widget flutuante global (bolha estilo Messenger) —
  // mesma instância/estado, só troca o JSX final por uma lista+thread
  // enxutas. Ver bloco `if (docked)` antes do return principal.
  docked?: boolean;
  onUnreadChange?: (count: number) => void;
  onActiveConversationChange?: (id: number | null) => void;
  // "Expandir" no widget: id da conversa a focar + um contador que muda a
  // cada pedido (garante reabrir mesmo pedindo a mesma conversa de novo).
  focusConversationId?: number | null;
  focusRequestId?: number;
};

type FilePreviewItem = { file: File; previewUrl: string | null; kind: "image" | "video" | "other" };

/** Frame do vídeo (por padrão perto do início) capturado num <canvas>, pra
 * mostrar uma miniatura de verdade no preview de envio — igual ao WhatsApp,
 * em vez de só um ícone genérico de arquivo. Resolve null se o navegador não
 * conseguir decodificar o vídeo (preview cai pro ícone genérico nesse caso). */
function captureVideoFrame(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.1, video.duration || 0);
      } catch {
        resolve(null);
        cleanup();
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve(null);
      } finally {
        cleanup();
      }
    };
    video.onerror = () => { resolve(null); cleanup(); };
    video.src = url;
  });
}

export default function ChatCenter({
  docked = false,
  onUnreadChange,
  onActiveConversationChange,
  focusConversationId,
  focusRequestId,
}: ChatCenterProps = {}) {
  const { user } = useAuth();
  const { toast } = useToast();

  const [convs, setConvs] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category>("pendentes");
  const [labelFilter, setLabelFilter] = useState("");
  const [msgText, setMsgText] = useState("");
  // Rascunho por conversa: cada conversationId guarda seu próprio texto não
  // enviado, pra nunca vazar o que foi digitado pro cliente errado ao trocar
  // de conversa (ver draftsRef/prevActiveIdRef mais abaixo).
  const msgTextRef = useRef("");
  const draftsRef = useRef<Map<number, string>>(new Map());
  const prevActiveIdRef = useRef<number | null>(null);
  useEffect(() => { msgTextRef.current = msgText; }, [msgText]);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [composerMode, setComposerMode] = useState<"message" | "note">("message");
  const [highlightedMsgId, setHighlightedMsgId] = useState<number | null>(null);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  // Trava obrigatória de Rotinas e Produtividade (Fase 3) só aparece quando
  // isBusy() está livre — registra aqui os mesmos momentos em que liga/
  // desliga `sending`/`recording`, pra nunca interromper um envio em curso.
  const guard = useActivityGuard();
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
  // Filtro por número de WhatsApp (linha Varejo/Oficial/Atacado/Adm etc.) —
  // usa o sessionKey já gravado em cada conversa (ver waSessions abaixo).
  const [filterSessionKey, setFilterSessionKey] = useState("");
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
  // Opções editáveis pelo admin em Configurações → Aparência (api.settings) —
  // começa com o padrão embutido e é substituída assim que /settings carrega.
  const [finalizeReasonOptions, setFinalizeReasonOptions] = useState<string[]>([...FINALIZE_REASONS]);
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
  // Preview de mensagem rápida: mostra o texto já com {{nome}}/{{loja}}/{{atendente}}
  // substituídos antes de jogar no campo de mensagem — evita mandar variável crua.
  const [quickReplyPreview, setQuickReplyPreview] = useState<string | null>(null);
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

  const [filePreview, setFilePreview] = useState<FilePreviewItem[] | null>(null);
  const [caption, setCaption] = useState("");
  // { current, total } enquanto envia um lote de vários arquivos em sequência
  // (a API só manda uma mídia por mensagem — não existe "álbum" de verdade
  // no envio, cada foto vira uma mensagem própria, uma atrás da outra).
  const [sendProgress, setSendProgress] = useState<{ current: number; total: number } | null>(null);

  // CRM connection: contact opened from the active conversation
  const [crmContactId, setCrmContactId] = useState<number | null>(null);
  const [crmLoading, setCrmLoading] = useState(false);

  // Informações side panel: view/edit the linked CRM contact next to the chat.
  // Fase 3a do redesign: painel colapsável fixo (nunca desmonta no desktop,
  // vira um trilho estreito quando fechado) — estado persistido por
  // atendente via localStorage. No celular continua sendo overlay
  // fullscreen só quando expandido (ver classes no <aside> abaixo).
  const [infoCollapsed, setInfoCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("shk_chat_info_collapsed");
      return saved === null ? true : saved === "1";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("shk_chat_info_collapsed", infoCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [infoCollapsed]);
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
  // HTMLInputElement no modo docked (linha compacta), HTMLTextAreaElement no
  // composer principal (precisa crescer com quebras de linha — ver item 3).
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // Campo de mensagem multi-linha: cresce junto com o texto (até max-h-32,
  // quando passa a rolar) — mesmo padrão do InternalChat.tsx.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [msgText]);
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
  // Enquanto aguarda o navegador liberar o microfone (getUserMedia) — em
  // alguns celulares/navegadores essa promessa pode nunca resolver nem dar
  // erro (trava em silêncio, ex.: app voltou do segundo plano). Sem esse
  // estado o toque no microfone parecia não fazer nada; com ele, o botão
  // mostra "carregando" e, se travar mesmo, um watchdog (ver
  // MIC_REQUEST_TIMEOUT_MS abaixo) cancela e avisa em vez de ficar preso.
  const [requestingMic, setRequestingMic] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Decide no stop se a gravação vira envio ou é descartada.
  const recordSendRef = useRef(false);
  // Trava de corrida: se o watchdog já desistiu (ou o componente trocou de
  // conversa/desmontou) enquanto getUserMedia ainda não respondeu, o stream
  // que chegar depois é encerrado na hora — nunca vira uma gravação "fantasma".
  const micRequestIdRef = useRef(0);

  const activeConv = convs.find((c) => c.id === activeId) ?? null;
  const unreadNotifications = notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);

  // ── Ganchos pro widget flutuante global (bolha estilo Messenger) ──
  // Resolvidas/arquivadas não contam pro badge — pra admin/supervisor elas
  // continuam na lista (podem ver o histórico), mas não representam mais
  // pendência nenhuma. Sem esse filtro, um unreadCount residual que nunca
  // foi zerado no servidor (ex.: conversa finalizada por quem não era o
  // responsável) infla o contador pra sempre.
  useEffect(() => {
    onUnreadChange?.(
      convs.reduce((sum, c) => sum + (conversationCategory(c) === "resolvidas" ? 0 : (c.unreadCount ?? 0)), 0),
    );
  }, [convs, onUnreadChange]);
  useEffect(() => {
    onActiveConversationChange?.(activeId);
  }, [activeId, onActiveConversationChange]);
  useEffect(() => {
    if (focusConversationId != null) setActiveId(focusConversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequestId]);

  // Variáveis disponíveis nas mensagens rápidas: {{nome}} (contato), {{loja}}
  // (unidade do atendente) e {{atendente}} (quem está enviando). Mantém
  // {cliente}/{vendedor} funcionando como apelido do formato antigo.
  const quickReplyVars = {
    nome: activeConv?.name ?? "",
    loja: user?.storeName ?? "",
    atendente: user?.name ?? "",
  };
  const substituteQuickReplyVars = (text: string): string =>
    text
      .replace(/\{\{\s*(nome|loja|atendente)\s*\}\}/gi, (_m, key: string) => quickReplyVars[key.toLowerCase() as keyof typeof quickReplyVars])
      .replaceAll("{cliente}", quickReplyVars.nome)
      .replaceAll("{vendedor}", quickReplyVars.atendente);

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
    const es = acquireSharedEventSource(CHAT_EVENTS_URL);
    // Close the initial-load race: a message can arrive after the REST fetch
    // snapshot but before the SSE subscriber is registered server-side, landing
    // in neither the fetch nor the stream. Once the stream is actually open
    // (subscriber registered), do a one-time refetch to pull anything that
    // slipped through the gap. A brand-new connection gets no replay, so this
    // never duplicates messages or bell notifications; subsequent reconnects are
    // handled by replay/resync, so the guard keeps this to the very first open.
    // A conexão é compartilhada entre instâncias (página + widget flutuante):
    // se outra já deixou o "open" disparar antes desta montar, faz a mesma
    // checagem na hora em vez de esperar um evento que não vai repetir.
    const onOpen = () => {
      if (initialSyncedRef.current) return;
      initialSyncedRef.current = true;
      fetchConvs();
      if (activeId != null) fetchMsgs(activeId);
    };
    if (es.readyState === EventSource.OPEN) onOpen();
    es.addEventListener("open", onOpen);
    const onMessageUpdated = (e: Event) => {
      try {
        const { conversationId, message } = JSON.parse((e as MessageEvent).data) as { conversationId: number; message: ChatMessage };
        if (conversationId === activeId) {
          setMessages((prev) => prev.map((m) => m.id === message.id ? message : m));
        }
        setConvs((prev) => prev.map((c) =>
          c.id === conversationId && c.lastMessageAt === message.createdAt
            ? { ...c, lastMessage: message.content }
            : c
        ));
      } catch { /* ignore malformed event */ }
    };
    es.addEventListener("message_updated", onMessageUpdated);

    const onMessage = (e: Event) => {
      try {
        const { conversationId, message } = JSON.parse((e as MessageEvent).data) as { conversationId: number; message: ChatMessage };
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
            ? {
                ...c, lastMessage: message.content, lastMessageDirection: message.direction,
                lastMessageSenderName: message.direction === "outbound" ? message.senderName : null,
                lastMessageAt: message.createdAt, unreadCount: conversationId === activeId ? 0 : c.unreadCount + 1,
              }
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
    };
    es.addEventListener("message", onMessage);
    // Agendamentos: hora do retorno ao cliente ("schedule_due") e falha no envio
    // de mensagem agendada ("schedule_failed"). Toast + sino + som/notificação
    // nativa, sem depender de olhar o quadro de Tarefas.
    const onSchedule = (e: Event, kind: "retorno" | "failed") => {
      try {
        const p = JSON.parse((e as MessageEvent).data) as { scheduledId: number; conversationId: number; convName: string; content: string; sendAt: string };
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
    const onScheduleDue = (e: Event) => onSchedule(e, "retorno");
    const onScheduleFailed = (e: Event) => onSchedule(e, "failed");
    es.addEventListener("schedule_due", onScheduleDue);
    es.addEventListener("schedule_failed", onScheduleFailed);
    const onConversationNew = (e: Event) => {
      try {
        const conv = JSON.parse((e as MessageEvent).data) as Conversation;
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
    };
    es.addEventListener("conversation_new", onConversationNew);
    const onConversationUpdated = (e: Event) => {
      try {
        const conv = JSON.parse((e as MessageEvent).data) as Conversation;
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
    };
    es.addEventListener("conversation_updated", onConversationUpdated);
    // Conversa ficou restrita (assumida/finalizada por outro): remove da tela
    // de quem não está na lista de autorizados. Evento leve: só id + keepFor.
    const onConversationHidden = (e: Event) => {
      try {
        const { id, keepFor, sectorId } = JSON.parse((e as MessageEvent).data) as { id: number; keepFor: number[]; sectorId: number | null };
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
    };
    es.addEventListener("conversation_hidden", onConversationHidden);
    // Atendimento excluído pelo administrador: some para todos.
    const onConversationDeleted = (e: Event) => {
      try {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: number };
        setConvs((prev) => prev.filter((c) => c.id !== id));
        setNotifications((prev) => prev.filter((n) => n.conversationId !== id));
        setActiveId((cur) => (cur === id ? null : cur));
      } catch { /* silent */ }
    };
    es.addEventListener("conversation_deleted", onConversationDeleted);
    // Participantes mudaram (fui adicionado/removido de uma conversa restrita):
    // a lista do servidor é a fonte da verdade — refetch.
    const onParticipantsUpdated = () => { fetchConvs(); };
    es.addEventListener("participants_updated", onParticipantsUpdated);
    // When the reconnection gap is larger than the server's replay buffer (or
    // the server restarted), the server asks the client to resync. Refetch the
    // conversation list and the open conversation's messages so nothing that
    // arrived during the outage is lost. Missed events within buffer range are
    // replayed automatically and flow through the handlers above, so the bell
    // and lists stay correct without any extra work here.
    const onResync = () => {
      fetchConvs();
      if (activeId != null) fetchMsgs(activeId);
    };
    es.addEventListener("resync", onResync);
    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("message_updated", onMessageUpdated);
      es.removeEventListener("message", onMessage);
      es.removeEventListener("schedule_due", onScheduleDue);
      es.removeEventListener("schedule_failed", onScheduleFailed);
      es.removeEventListener("conversation_new", onConversationNew);
      es.removeEventListener("conversation_updated", onConversationUpdated);
      es.removeEventListener("conversation_hidden", onConversationHidden);
      es.removeEventListener("conversation_deleted", onConversationDeleted);
      es.removeEventListener("participants_updated", onParticipantsUpdated);
      es.removeEventListener("resync", onResync);
      releaseSharedEventSource(CHAT_EVENTS_URL);
    };
  }, [activeId, user, fetchConvs, fetchMsgs]);

  useEffect(() => {
    api.sectors.list().then(setSectors).catch(() => {});
    api.chatUsers().then(setChatUsers).catch(() => {});
    api.settings.get().then((s) => {
      setAlertEnabled(s.alertUnansweredEnabled); setAlertMinutes(s.alertUnansweredMinutes);
      setCfgOutboundHourly(s.outboundHourlyLimit); setCfgOutboundDaily(s.outboundDailyLimit);
      // "Outro" nunca vem do backend — é sempre a última opção fixa aqui,
      // porque a UI depende dela pra abrir o campo de descrição livre.
      setFinalizeReasonOptions([...s.finalizeReasons, "Outro"]);
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

  // Salva o rascunho da conversa que está sendo deixada e restaura o
  // rascunho (ou vazio) da conversa que está sendo aberta.
  useEffect(() => {
    const prev = prevActiveIdRef.current;
    if (prev != null) {
      const draft = msgTextRef.current;
      if (draft.trim()) draftsRef.current.set(prev, draft);
      else draftsRef.current.delete(prev);
    }
    setMsgText(activeId != null ? (draftsRef.current.get(activeId) ?? "") : "");
    prevActiveIdRef.current = activeId;
  }, [activeId]);

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
    // Mantém o foco no campo pra continuar digitando na hora — sem isso, quem
    // envia clicando no botão (em vez de Enter) perde o foco pro botão.
    inputRef.current?.focus();
    setSending(true);
    guard.register("send-text");
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
    } finally { setSending(false); guard.unregister("send-text"); }
  };

  // ── Send one file (image, video, audio ou documento) — usado tanto pra um
  // arquivo avulso quanto por handleSendFiles em loop pra um lote. ──
  const sendOneFile = async (file: File, fileCaption: string | undefined, replyingTo: ChatMessage | null) => {
    if (!activeId) return;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    const baseContent = isImage ? "📷 Foto" : isVideo ? "🎥 Vídeo" : isAudio ? "🎤 Áudio" : `📄 ${file.name}`;
    const optimistic: ChatMessage = {
      id: -(Date.now() * 1000 + Math.floor(Math.random() * 1000)), conversationId: activeId,
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
      toast({ title: `Erro ao enviar ${file.name}`, variant: "destructive" });
    }
  };

  // ── Send file(s) — lote enviado em sequência (a API só aceita uma mídia
  // por mensagem). Legenda só vai anexada à última mensagem do lote, igual
  // ao WhatsApp mostra a legenda embaixo da última foto de um álbum. ──
  const handleSendFiles = async (items: FilePreviewItem[], fileCaption?: string) => {
    if (!activeId || sending || items.length === 0) return;
    const replyingTo = replyTarget;
    setFilePreview(null);
    setCaption("");
    setReplyTarget(null);
    items.forEach((it) => { if (it.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(it.previewUrl); });
    setSending(true);
    guard.register("send-files");
    setSendProgress(items.length > 1 ? { current: 0, total: items.length } : null);
    for (let i = 0; i < items.length; i++) {
      const isLast = i === items.length - 1;
      await sendOneFile(items[i].file, isLast ? fileCaption : undefined, replyingTo);
      setSendProgress(items.length > 1 ? { current: i + 1, total: items.length } : null);
    }
    setSendProgress(null);
    setSending(false);
    guard.unregister("send-files");
  };

  // ── Gravação de nota de voz (microfone) ──
  const stopRecordTimer = () => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
  };

  // Alguns celulares/navegadores (ex.: Safari/Chrome depois de o app voltar
  // do segundo plano) deixam a promessa de getUserMedia presa — nunca resolve
  // nem rejeita. Sem um limite de tempo, o toque no microfone parece travar
  // pra sempre, sem nenhum aviso. Esse valor é só o prazo de espera pelo
  // navegador liberar o microfone, não da gravação em si.
  const MIC_REQUEST_TIMEOUT_MS = 12000;

  const handleStartRecording = async () => {
    if (!activeId || recording || sending || requestingMic) return;
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
    const requestId = ++micRequestIdRef.current;
    setRequestingMic(true);
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      setRequestingMic(false);
      toast({
        title: "Não consegui acessar o microfone a tempo",
        description: "Se o navegador mostrou um aviso pedindo permissão, toque em \"Permitir\". Se não mostrou nada, recarregue a página e tente de novo.",
        variant: "destructive",
      });
    }, MIC_REQUEST_TIMEOUT_MS);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      clearTimeout(watchdog);
      // O watchdog já desistiu (ou o usuário trocou de conversa/saiu enquanto
      // o navegador ainda não tinha respondido) — o stream chegou tarde
      // demais. Libera o microfone na hora, nunca inicia gravação "fantasma".
      if (timedOut || requestId !== micRequestIdRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setRequestingMic(false);
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
        guard.unregister("recording");
        setRecordSecs(0);
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        if (!recordSendRef.current || chunks.length === 0) return;
        const type = (rec.mimeType || "audio/webm").split(";")[0];
        const ext = type === "audio/mp4" ? "m4a" : "weba";
        const file = new File([new Blob(chunks, { type })], `nota-de-voz.${ext}`, { type: rec.mimeType || "audio/webm" });
        setSending(true);
        guard.register("send-voice-note");
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
        } finally { setSending(false); guard.unregister("send-voice-note"); }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      guard.register("recording");
      setRecordSecs(0);
      recordTimerRef.current = setInterval(() => setRecordSecs((s) => s + 1), 1000);
    } catch (err) {
      clearTimeout(watchdog);
      setRequestingMic(false);
      if (timedOut) return; // watchdog já mostrou o próprio aviso — evita toast duplicado
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

  // Cancela gravação ao trocar de conversa ou sair da tela. Também invalida
  // qualquer pedido de microfone ainda em andamento (getUserMedia pendente) —
  // se ele responder depois de trocar de conversa, o stream é descartado em
  // vez de virar uma gravação na conversa errada.
  useEffect(() => {
    return () => {
      micRequestIdRef.current++;
      setRequestingMic(false);
      recordSendRef.current = false;
      recorderRef.current?.stop();
      recorderRef.current = null;
      stopRecordTimer();
    };
  }, [activeId]);

  // ── Open file preview modal (um ou vários arquivos de uma vez) ──
  const handleFilesSelected = (files: File[]) => {
    const items: FilePreviewItem[] = files.map((file) => {
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");
      return {
        file,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        kind: isImage ? "image" : isVideo ? "video" : "other",
      };
    });
    setFilePreview((prev) => (prev ? [...prev, ...items] : items));
    setCaption("");
    // Miniatura de vídeo é assíncrona (precisa carregar o arquivo pra tirar
    // o frame) — atualiza o item pelo file quando (se) resolver.
    for (const item of items) {
      if (item.kind !== "video") continue;
      captureVideoFrame(item.file).then((thumb) => {
        if (!thumb) return;
        setFilePreview((prev) => prev?.map((p) => (p.file === item.file ? { ...p, previewUrl: thumb } : p)) ?? prev);
      });
    }
  };

  const handleRemoveFilePreview = (file: File) => {
    setFilePreview((prev) => {
      const target = prev?.find((p) => p.file === file);
      if (target?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(target.previewUrl);
      const next = prev?.filter((p) => p.file !== file) ?? null;
      return next && next.length > 0 ? next : null;
    });
  };

  const handleCancelPreview = () => {
    filePreview?.forEach((p) => { if (p.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(p.previewUrl); });
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

  // Favoritar/desfavoritar conversa (só para o próprio usuário) com atualização otimista.
  const handleTogglePin = async (conv: Conversation) => {
    const next = !conv.pinned;
    setConvs((prev) => prev.map((c) => (c.id === conv.id ? { ...c, pinned: next } : c)));
    try {
      if (next) await api.chat.pinConversation(conv.id);
      else await api.chat.unpinConversation(conv.id);
    } catch {
      setConvs((prev) => prev.map((c) => (c.id === conv.id ? { ...c, pinned: !next } : c)));
      toast({ title: "Não foi possível alterar favorito", variant: "destructive" });
    }
  };

  // ── Pendente → Ativo (iniciar atendimento: assume a conversa) ──
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
    setFinalizeReason(finalizeReasonOptions[0] ?? FINALIZE_REASONS[0]);
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

  // (Re)load contact whenever the panel is expanded or the active conversation changes
  useEffect(() => {
    if (!infoCollapsed && activeConv) void loadInfoContact();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoCollapsed, activeId]);

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

  // Abre (ou cria, se não existir) uma conversa individual com um número —
  // usado pelo cartão de contato compartilhado e pelo nome clicável de quem
  // mandou uma mensagem dentro de um grupo. Se já existe uma conversa aberta
  // com esse número, o backend responde 409 com o id dela — só abre.
  const startConversationWith = async ({ name, phone }: { name: string; phone: string | null }) => {
    if (!phone) { toast({ title: "Número não disponível para este contato", variant: "destructive" }); return; }
    try {
      const conv = await api.chat.createConversation({ phone, name, channel: "whatsapp" });
      // O insert no backend não devolve o objeto assignee (só assigneeId) —
      // preenche localmente com o que já temos em chatUsers pra não ficar
      // preso na tela de "Iniciar atendimento" quando já tem responsável.
      const assignee = conv.assigneeId != null
        ? (conv.assigneeId === user?.id ? { id: user.id, name: user.name } : chatUsers.find((u) => u.id === conv.assigneeId))
        : null;
      const convWithAssignee = { ...conv, assignee: assignee ?? conv.assignee ?? null };
      setConvs((prev) => prev.some((c) => c.id === convWithAssignee.id)
        ? prev.map((c) => c.id === convWithAssignee.id ? convWithAssignee : c)
        : [convWithAssignee, ...prev]);
      setActiveId(conv.id);
      setCategory(conversationCategory(conv));
    } catch (err: unknown) {
      if (err instanceof ApiError && err.conversationId != null) {
        // Já existe uma conversa aberta com esse número — só abre ela.
        setActiveId(err.conversationId);
        const existing = convs.find((c) => c.id === err.conversationId);
        if (existing) setCategory(conversationCategory(existing));
        return;
      }
      toast({ title: "Erro ao iniciar conversa", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
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
    (!filterNivel || (c.crmProfile ?? "") === filterNivel) &&
    (!filterSessionKey || (c.sessionKey ?? "default") === filterSessionKey)
  );
  const hasAdvancedFilter = !!(filterVendedor || filterSetor || filterNivel || filterSessionKey);

  const counts: Record<Category, number> = { potenciais: 0, pendentes: 0, ativos: 0, resolvidas: 0, favoritos: 0 };
  for (const c of visibleConvs) {
    counts[conversationCategory(c)]++;
    if (c.pinned) counts.favoritos++;
  }

  // Favoritos é ortogonal às outras categorias: mostra qualquer conversa
  // marcada, não importa o status. Fixadas (favoritas) sempre no topo dentro
  // do grupo; dentro de cada grupo mantém a ordem por última mensagem.
  const filteredConvs = visibleConvs
    .filter((c) => category === "favoritos" ? !!c.pinned : conversationCategory(c) === category)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const activeCategory = activeConv ? conversationCategory(activeConv) : null;

  const currentLabels = activeConv?.labels ? activeConv.labels.split(",").map((l) => l.trim()).filter(Boolean) : [];

  // ── Painel compacto do widget flutuante (bolha estilo Messenger) ──
  // JSX próprio, não reaproveita o layout gigante abaixo — só o
  // estado/handlers já declarados acima (visibleConvs, activeConv,
  // messages, msgText, handleSend...). Zero risco pra Central completa.
  if (docked) {
    const dockedConvs = [...visibleConvs].sort(
      (a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime(),
    );
    return (
      <div className="flex flex-col h-full min-h-0 bg-card overflow-hidden">
        {activeConv ? (
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <button onClick={() => setActiveId(null)} data-testid="button-docked-back" className="p-1 -ml-1 rounded-md hover:bg-muted/50 shrink-0">
                <ChevronLeft className="w-4 h-4" />
              </button>
              {activeConv.avatarUrl
                ? <img src={activeConv.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
                : <div className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold shrink-0">{activeConv.name.charAt(0).toUpperCase()}</div>}
              <p className="text-sm font-semibold truncate flex-1">{activeConv.name}</p>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
              {messages.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">Sem mensagens ainda</p>
              ) : messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-xl px-2.5 py-1.5 text-xs ${m.direction === "outbound" ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"}`}>
                    <p className="whitespace-pre-wrap break-words">{m.type === "text" || m.type === "note" ? m.content : "[mídia — abra em tela cheia pra ver]"}</p>
                    <p className={`text-[10px] mt-0.5 ${m.direction === "outbound" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{timeAgo(m.createdAt)}</p>
                  </div>
                </div>
              ))}
              <div ref={msgsEndRef} />
            </div>
            <form onSubmit={handleSend} className="flex items-center gap-2 px-3 py-2 border-t border-border shrink-0">
              <input ref={inputRef as React.RefObject<HTMLInputElement>} value={msgText} onChange={(e) => setMsgText(e.target.value)} placeholder="Mensagem..."
                data-testid="input-docked-message"
                className="flex-1 text-sm bg-secondary/50 rounded-full px-3 py-1.5 outline-none" />
              <button type="submit" disabled={!msgText.trim() || sending} data-testid="button-docked-send"
                className="p-1.5 rounded-full bg-primary text-primary-foreground disabled:opacity-40 shrink-0">
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {loadingConvs ? (
              <p className="text-xs text-muted-foreground text-center py-6">Carregando...</p>
            ) : dockedConvs.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Nenhuma conversa ainda</p>
            ) : dockedConvs.map((c) => (
              <button key={c.id} onClick={() => setActiveId(c.id)} data-testid={`docked-conv-${c.id}`}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-secondary/50 transition text-left border-b border-border/50">
                {c.avatarUrl
                  ? <img src={c.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
                  : <div className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold shrink-0">{c.name.charAt(0).toUpperCase()}</div>}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-sm font-semibold truncate">{c.name}</p>
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-xs text-muted-foreground truncate">{c.lastMessage ?? "Sem mensagens"}</p>
                    {c.unreadCount > 0 && (
                      <span className="text-[10px] font-bold bg-primary text-primary-foreground rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center shrink-0">{c.unreadCount}</span>
                    )}
                  </div>
                  {c.lastMessageSenderName && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <UserCircle2 className="w-3 h-3 text-indigo-500 shrink-0" />
                      <span className="text-[10px] text-indigo-600 font-medium truncate" title={`Última mensagem enviada por ${c.lastMessageSenderName}`}>
                        {c.lastMessageSenderName}
                      </span>
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(var(--vvh,100dvh)-7rem-env(safe-area-inset-bottom))] md:h-[calc(100vh-88px-var(--shk-topbar-extra,0px))] bg-[#f0f2f5] overflow-hidden rounded-none md:rounded-2xl border-0 md:border border-border shadow-none md:shadow-sm">

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

        {/* Category tabs: Favoritos / Potenciais / Pendentes / Ativos / Resolvidas */}
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
              {/* Número de WhatsApp (Varejo/Oficial/Atacado/Adm etc.) — só faz
                  sentido mostrar quando existe mais de uma linha cadastrada. */}
              {waSessions.length > 1 && (
                <select value={filterSessionKey} onChange={(e) => setFilterSessionKey(e.target.value)}
                  data-testid="filter-conv-numero"
                  className="text-xs px-2 py-1 rounded-lg border border-border bg-white max-w-[140px]">
                  <option value="">Número: todos</option>
                  {waSessions.map((s) => (
                    <option key={s.sessionKey} value={s.sessionKey}>{waSessionLabel(s.sessionKey, waSessions)}</option>
                  ))}
                </select>
              )}
              {hasAdvancedFilter && (
                <button onClick={() => { setFilterVendedor(""); setFilterSetor(""); setFilterNivel(""); setFilterSessionKey(""); }}
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
                onTogglePin={() => void handleTogglePin(conv)}
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
            <MediaLightboxProvider>
              <HeaderAvatar name={activeConv.name} src={activeConv.avatarUrl} />
            </MediaLightboxProvider>
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
              {/* Favoritar/desfavoritar contato — fica marcado só para você, some no topo e na aba Favoritos */}
              <button
                onClick={() => handleTogglePin(activeConv)}
                data-testid="button-pin-conv"
                className={`p-2 rounded-lg border transition ${activeConv.pinned ? "text-amber-500 bg-amber-50 border-amber-300 hover:bg-amber-100" : "text-muted-foreground bg-white border-border hover:bg-secondary"}`}
                title={activeConv.pinned ? "Remover dos favoritos" : "Favoritar este contato"}
              >
                {activeConv.pinned ? <Star className="w-3.5 h-3.5 fill-amber-500" /> : <StarOff className="w-3.5 h-3.5" />}
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
              {/* Informações — expande/recolhe o painel do cliente */}
              <button
                onClick={() => setInfoCollapsed((v) => !v)}
                data-testid="button-toggle-info"
                className={`p-2 rounded-lg border transition ${!infoCollapsed ? "bg-primary text-white border-primary" : "bg-white border-border hover:bg-secondary"}`}
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
            <MediaLightboxProvider>
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
                    isGroup={!!activeConv && isGroupConv(activeConv)}
                    onStartConversation={can(user, "criar_atendimento") ? startConversationWith : undefined}
                  />
                ))}
                <div ref={msgsEndRef} />
              </>
            )}
            </MediaLightboxProvider>
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
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/3gpp,video/webm,video/quicktime,audio/ogg,audio/mpeg,audio/mp4,audio/webm,audio/aac,audio/wav,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) { handleFilesSelected(files); }
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
                        setQuickReplyPreview(substituteQuickReplyVars(q.content));
                        setShowQuickReplies(false);
                        setQuickSearch("");
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
                    Dica: use {"{{nome}}"}, {"{{loja}}"} e {"{{atendente}}"} nas mensagens — viram o nome real na hora de enviar.
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
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={msgText}
              onChange={(e) => setMsgText(e.target.value)}
              placeholder={composerMode === "note" ? "Escreva uma nota interna (só a equipe vê)..." : "Digite uma mensagem..."}
              spellCheck
              lang="pt-BR"
              rows={1}
              data-testid="input-message"
              className="flex-1 min-w-0 resize-none bg-white rounded-2xl px-4 py-2 text-sm border border-border outline-none focus:ring-2 focus:ring-primary/20 max-h-32 overflow-y-auto"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
              onPaste={(e) => {
                if (can(user, "enviar_midia")) {
                  const images = Array.from(e.clipboardData.items)
                    .filter((item) => item.type.startsWith("image/"))
                    .map((item) => item.getAsFile())
                    .filter((f): f is File => f != null);
                  if (images.length > 0) {
                    e.preventDefault();
                    handleFilesSelected(images);
                    return;
                  }
                }
                // Texto colado de Word/sites vem com aspas curvas, espaço
                // sem quebra e caracteres invisíveis — normaliza pra texto
                // limpo antes de ir pro WhatsApp (item 3 do roadmap).
                const text = e.clipboardData.getData("text/plain");
                if (!text) return;
                e.preventDefault();
                const clean = cleanPastedText(text);
                const el = e.currentTarget;
                const start = el.selectionStart;
                const end = el.selectionEnd;
                const next = msgText.slice(0, start) + clean + msgText.slice(end);
                setMsgText(next);
                requestAnimationFrame(() => {
                  const pos = start + clean.length;
                  el.setSelectionRange(pos, pos);
                });
              }}
            />
            {msgText.trim() ? (
              <button type="submit" disabled={sending} data-testid="button-send-message"
                className={`w-10 h-10 rounded-full flex items-center justify-center text-white disabled:opacity-40 transition shrink-0 ${composerMode === "note" ? "bg-amber-500 hover:bg-amber-600" : "bg-primary hover:bg-primary/90"}`}>
                <Send className="w-4 h-4" />
              </button>
            ) : composerMode === "message" && can(user, "enviar_midia") ? (
              <button type="button" onClick={handleStartRecording} disabled={sending || requestingMic}
                title={requestingMic ? "Aguardando o navegador liberar o microfone..." : "Gravar nota de voz"} data-testid="button-record-audio"
                className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white hover:bg-primary/90 disabled:opacity-40 transition shrink-0">
                {requestingMic ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
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

        {/* ── Informações side panel — colapsável fixo (Fase 3a) ───────────── */}
        <aside
          className={`shrink-0 md:border-l border-border bg-white flex-col overflow-hidden ${
            infoCollapsed
              ? "hidden md:flex md:w-12"
              : "fixed inset-0 z-40 md:static md:z-auto flex w-full md:w-80"
          }`}
          data-testid="panel-info"
        >
          {infoCollapsed ? (
            <button
              onClick={() => setInfoCollapsed(false)}
              className="flex flex-col items-center gap-2 py-4 w-full h-full text-muted-foreground hover:text-primary hover:bg-secondary transition"
              title="Mostrar informações do cliente"
              data-testid="button-expand-info"
            >
              <ChevronRight className="w-4 h-4" />
              <Info className="w-4 h-4" />
            </button>
          ) : (
          <>
            <div className="bg-primary px-4 py-3 text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4" />
                <span className="font-semibold text-sm">Informações do cliente</span>
              </div>
              <button onClick={() => setInfoCollapsed(true)} className="p-1 rounded-lg hover:bg-white/20 transition" title="Recolher">
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
            {infoLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !infoContact ? (
              <div className="flex-1 flex items-center justify-center p-6 text-center">
                <p className="text-xs text-muted-foreground">
                  {activeConv && isGroupConv(activeConv)
                    ? "Grupos do WhatsApp não têm ficha de cliente no CRM."
                    : "Não foi possível carregar as informações do cliente."}
                </p>
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
          </>
          )}
        </aside>
        </div>
      )}

      {/* ── File preview modal (um ou vários arquivos) ────────────────────── */}
      {filePreview && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <h3 className="font-bold text-base">
                {filePreview.length > 1
                  ? `Prévia (${filePreview.length})`
                  : filePreview[0].kind === "image" ? "Prévia da foto"
                  : filePreview[0].kind === "video" ? "Prévia do vídeo"
                  : "Enviar documento"}
              </h3>
              <button onClick={handleCancelPreview} className="text-muted-foreground hover:text-foreground transition">
                <X className="w-5 h-5" />
              </button>
            </div>

            {filePreview.length === 1 ? (
              <div className="px-5 pb-3">
                {filePreview[0].previewUrl ? (
                  <img
                    src={filePreview[0].previewUrl}
                    alt="Prévia"
                    className="w-full max-h-64 object-contain rounded-xl bg-secondary/30"
                  />
                ) : (
                  <div className="flex items-center gap-3 p-4 bg-secondary/30 rounded-xl">
                    <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center shrink-0">
                      <FileText className="w-6 h-6 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{filePreview[0].file.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {(filePreview[0].file.size / 1024).toFixed(0)} KB
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="px-5 pb-3 flex flex-wrap gap-2">
                {filePreview.map((item, i) => (
                  <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden bg-secondary/30 border border-border shrink-0">
                    {item.previewUrl ? (
                      <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <FileText className="w-5 h-5 text-primary" />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveFilePreview(item.file)}
                      title="Remover"
                      className="absolute top-0.5 right-0.5 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Adicionar mais arquivos"
                  data-testid="button-add-more-files"
                  className="w-16 h-16 rounded-lg border-2 border-dashed border-border flex items-center justify-center text-muted-foreground hover:bg-secondary/50 transition shrink-0"
                >
                  <Paperclip className="w-5 h-5" />
                </button>
              </div>
            )}

            <div className="px-5 pb-4">
              <input
                autoFocus
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder={filePreview.length > 1 ? "Legenda na última mensagem (opcional)" : "Adicionar legenda (opcional)"}
                data-testid="input-file-caption"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/20"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendFiles(filePreview, caption.trim() || undefined);
                  }
                }}
              />
            </div>

            <div className="flex gap-2 px-5 pb-5">
              <button
                type="button"
                onClick={handleCancelPreview}
                disabled={sending}
                data-testid="button-cancel-file-preview"
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={sending}
                data-testid="button-confirm-file-send"
                onClick={() => void handleSendFiles(filePreview, caption.trim() || undefined)}
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {sendProgress ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Enviando {sendProgress.current}/{sendProgress.total}
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    Enviar
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick reply preview modal: variáveis já substituídas ─────────── */}
      {quickReplyPreview !== null && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <h3 className="font-bold text-base">Prévia da mensagem</h3>
              <button onClick={() => setQuickReplyPreview(null)} className="text-muted-foreground hover:text-foreground transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 pb-3">
              <p className="text-[11px] text-muted-foreground mb-1.5">
                Já com {"{{nome}}"}, {"{{loja}}"} e {"{{atendente}}"} substituídos. Pode ajustar antes de inserir.
              </p>
              <textarea
                autoFocus
                value={quickReplyPreview}
                onChange={(e) => setQuickReplyPreview(e.target.value)}
                data-testid="textarea-quickreply-preview"
                rows={5}
                className="w-full px-3 py-2 rounded-xl border border-border text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
              />
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button
                type="button"
                onClick={() => setQuickReplyPreview(null)}
                data-testid="button-cancel-quickreply-preview"
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="button-confirm-quickreply-preview"
                onClick={() => {
                  const content = quickReplyPreview;
                  setMsgText((prev) => prev ? `${prev} ${content}` : content);
                  setQuickReplyPreview(null);
                  inputRef.current?.focus();
                }}
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition"
              >
                Inserir na mensagem
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
                {finalizeReasonOptions.map((r) => <option key={r} value={r}>{r}</option>)}
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
