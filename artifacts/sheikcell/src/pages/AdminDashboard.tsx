import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { api, PERMISSION_KEYS, PERMISSION_LABELS, MODULE_LABELS, USER_GRANTABLE_MODULES, type SectorSummary, type AttendanceLog, type Sector, type QuickReply, type Store, type DashboardAttention, type InternalConversation, type OptionalModule, type UserGrantableModule, type UserModuleAccess } from "@/lib/api";
import { SectorIcon } from "@/components/SectorIcon";
import { ChannelBadge } from "@/components/ChannelBadge";
import { useToast } from "@/hooks/use-toast";
import { useInternalChatNotifier } from "@/hooks/useInternalChatNotifier";
import { useChatExpandListener, setAtendimentoTabVisible } from "@/lib/chatWidgetBus";
import { acquireSharedEventSource, releaseSharedEventSource } from "@/lib/sharedEventSource";

const CHAT_EVENTS_URL = "/api/chat/events";
import CrmBoard from "./CrmBoard";
import ChatCenter from "./ChatCenter";
import Financeiras from "./Financeiras";
import Avaliacao from "./Avaliacao";
import Questionarios from "./Questionarios";
import RotinasProdutividade from "./RotinasProdutividade";
import Treinamentos from "./Treinamentos";
import Documentos from "./Documentos";
import EquipeOnline from "@/components/EquipeOnline";
import RH from "./RH";
import MeuPonto from "./MeuPonto";
import TeamDirectory from "./TeamDirectory";
import Suporte from "./Suporte";
import Sorteios from "./Sorteios";
import Robo from "./Robo";
import Financeiro from "./Financeiro";
import ChangePasswordModal from "@/components/ChangePasswordModal";
import ChecklistGate from "@/components/ChecklistGate";
import PontoGate from "@/components/PontoGate";
import TrainingGate from "@/components/TrainingGate";
import RoutineChecklistGate from "@/components/RoutineChecklistGate";
import InternalChat from "./InternalChat";
import TaskBoard from "./TaskBoard";
import SystemBoard from "./SystemBoard";
import ConfiguracoesAparencia from "./ConfiguracoesAparencia";
import ConfiguracoesIntegracoes from "./ConfiguracoesIntegracoes";
import BrandLogo from "@/components/BrandLogo";
import {
  Smartphone, LogOut, LayoutDashboard, ClipboardList,
  Settings, Users, RefreshCw, Plus, X, Clock, CheckCircle,
  PhoneCall, TrendingUp, Pencil, Kanban, MessageCircle, MessagesSquare, ListTodo, MoreHorizontal, ShieldCheck, Zap, Trash2, Landmark, BadgeDollarSign, GraduationCap, UserSearch, Gift, Bot, KeyRound, UserX, UserCheck,
  AlertTriangle, WifiOff,
  FolderArchive, Headphones, ShoppingBag, BarChart3, SlidersHorizontal, Palette, ChevronDown, Wrench,
  ArrowRight, Filter, BookUser, LifeBuoy, FileBarChart2, Plug, Tv, ListChecks,
} from "lucide-react";
import Resultados from "./Resultados";
import Relatorios from "./Relatorios";
import TvBox from "./TvBox";

type Tab = "dashboard" | "resultados" | "relatorios" | "chat" | "equipe" | "tarefas" | "financeiras" | "avaliacao" | "questionarios" | "treinamentos" | "documentos" | "rh" | "meuponto" | "sorteios" | "robo" | "financeiro" | "crm" | "history" | "users" | "sectors" | "whatsapp" | "quickreplies" | "aparencia" | "integracoes" | "sistema" | "diretorio" | "suporte" | "tvbox" | "rotinas";

// Categorias colapsáveis do menu lateral — cada aba pertence a um único grupo.
type TabGroup = { key: string; label: string; icon: typeof LayoutDashboard; tabIds: Tab[] };
const TAB_GROUPS: TabGroup[] = [
  { key: "atendimento", label: "Atendimento", icon: Headphones, tabIds: ["dashboard", "chat", "equipe", "crm"] },
  { key: "vendas", label: "Vendas e Serviços", icon: ShoppingBag, tabIds: ["avaliacao", "financeiras", "tvbox"] },
  { key: "gestao", label: "Gestão", icon: BarChart3, tabIds: ["resultados", "relatorios", "tarefas", "documentos", "history", "suporte", "rotinas"] },
  { key: "pessoas", label: "Pessoas", icon: Users, tabIds: ["diretorio", "meuponto", "rh", "treinamentos", "questionarios", "sorteios", "users"] },
  { key: "administracao", label: "Administração", icon: Settings, tabIds: ["financeiro", "sectors", "quickreplies", "whatsapp", "robo"] },
  { key: "configuracoes", label: "Configurações", icon: SlidersHorizontal, tabIds: ["aparencia", "integracoes"] },
  { key: "sistema", label: "Sistema (Dev)", icon: Wrench, tabIds: ["sistema"] },
];

type WASession = {
  sessionKey: string;
  displayName: string | null;
  mode: "baileys" | "meta" | null;
  status: "connected" | "qr" | "connecting" | "reconnecting" | "disconnected" | "unconfigured" | "error" | "unknown";
  phoneNumber: string | null;
  phoneId: string | null;
  qrDataUrl: string | null;
  lastHeartbeatAt: string | null;
  errorMessage: string | null;
  bridgeAvailable: boolean;
};

type UserRow = {
  id: number; name: string; email: string; role: string;
  isActive: boolean; sector: Sector | null; sectorId: number | null; storeName?: string | null; extension?: string | null; adminAccess?: string[] | null; moduleAccess?: UserModuleAccess | null; accessHours?: { start: string; end: string; days: number[] } | null; allowedSessionKeys?: string[] | null; createdAt: string;
  permissions?: Record<string, boolean> | null;
};

function formatDuration(sec: number | null): string {
  if (!sec) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}min ${sec % 60}s`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const ICONS = ["smartphone", "headphones", "wrench", "dollar-sign", "users", "shopping-bag"];

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("dashboard");
  const internalChatUnread = useInternalChatNotifier(user?.id, tab === "equipe");

  // Some/aparece o balão flutuante global (GlobalChatWidget) conforme a aba
  // Atendimento fica visível ou não — evita o botão dele ficar em cima do
  // botão de enviar do composer, que também encosta no canto direito aqui.
  useEffect(() => {
    setAtendimentoTabVisible(tab === "chat" || tab === "equipe");
    return () => setAtendimentoTabVisible(false);
  }, [tab]);

  // Alarme de sem resposta clicado em outra aba → volta para o chat.
  useEffect(() => {
    const h = () => setTab("chat");
    window.addEventListener("sheikcell:open-chat", h);
    return () => window.removeEventListener("sheikcell:open-chat", h);
  }, []);

  // "Expandir" no widget flutuante global: foca a mesma conversa aqui.
  const [focusConversationId, setFocusConversationId] = useState<number | null>(null);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [focusInternalConversationId, setFocusInternalConversationId] = useState<number | null>(null);
  const [focusInternalRequestId, setFocusInternalRequestId] = useState(0);
  useChatExpandListener(useCallback((req) => {
    if (req.module === "atendimento") {
      setTab("chat");
      setFocusConversationId(req.conversationId);
      setFocusRequestId(req.requestId);
    } else {
      setTab("equipe");
      setFocusInternalConversationId(req.conversationId);
      // Força remontar o InternalChat mesmo se a aba "equipe" já estava
      // aberta (senão o initialConversationId não teria efeito de novo).
      setFocusInternalRequestId(req.requestId);
    }
  }, []));
  const [summary, setSummary] = useState<SectorSummary[]>([]);
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  // Filtros do histórico de atendimentos
  const [logFilters, setLogFilters] = useState({ search: "", days: 0, sectorId: 0, attendantId: 0, outcome: "", reason: "" });
  const [logAttendants, setLogAttendants] = useState<{ id: number; name: string }[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [newStoreName, setNewStoreName] = useState("");
  const [userRows, setUserRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [waSessions, setWaSessions] = useState<WASession[] | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [newConnName, setNewConnName] = useState("");
  // Visão Geral "viva": o que precisa de atenção agora e prévia do chat
  // interno — tudo que hoje só aparece entrando em cada aba.
  const [attention, setAttention] = useState<DashboardAttention | null>(null);
  const [internalPreview, setInternalPreview] = useState<InternalConversation[]>([]);

  // Modals
  const [showAddUser, setShowAddUser] = useState(false);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  // Seções colapsáveis do formulário de usuário — só "Dados básicos" abre por
  // padrão (formulário completo era grande demais pra caber sem dar scroll/
  // reduzir o zoom da tela).
  const [openUserSections, setOpenUserSections] = useState<Set<string>>(new Set(["basico"]));
  const toggleUserSection = (key: string) => setOpenUserSections((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // Modal de permissões individuais do vendedor
  const [permUser, setPermUser] = useState<UserRow | null>(null);
  const [permDraft, setPermDraft] = useState<Record<string, boolean>>({});
  const [savingPerms, setSavingPerms] = useState(false);
  const [showAddSector, setShowAddSector] = useState(false);
  const [editSector, setEditSector] = useState<Sector | null>(null);

  // Exclusão de usuário com transferência dos atendimentos dele.
  const [deactivateUser, setDeactivateUser] = useState<UserRow | null>(null);
  const [deactTransferTo, setDeactTransferTo] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const [deleteTransferTo, setDeleteTransferTo] = useState("");
  const [deletingUser, setDeletingUser] = useState(false);

  const [userForm, setUserForm] = useState<{ name: string; email: string; password: string; role: string; sectorId: number; storeName: string; extension: string; adminAccess: string[]; moduleAccess: UserModuleAccess; ahEnabled: boolean; ahStart: string; ahEnd: string; ahDays: number[]; waEnabled: boolean; waKeys: string[] }>({ name: "", email: "", password: "", role: "vendedor", sectorId: 1, storeName: "", extension: "", adminAccess: [], moduleAccess: {}, ahEnabled: false, ahStart: "08:00", ahEnd: "18:00", ahDays: [1, 2, 3, 4, 5, 6], waEnabled: false, waKeys: [] });
  const [sectorForm, setSectorForm] = useState({ name: "", description: "", icon: "smartphone", color: "#1a2e6e", isActive: true });

  const fetchAll = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api.admin.summary(), api.admin.logs({ limit: 40 })]);
      setSummary(s);
      setLogs(l);
    } catch { /* silent */ } finally { setLoading(false); }
    // Independente do resto: se essa consulta falhar (ex.: supervisor sem
    // acesso a alguma tabela), o resto da Visão Geral segue funcionando.
    api.admin.dashboardAttention().then(setAttention).catch(() => {});
  }, []);

  const fetchLogs = useCallback(async (f: typeof logFilters) => {
    try {
      const l = await api.admin.logs({
        limit: 200,
        days: f.days || undefined,
        sectorId: f.sectorId || undefined,
        attendantId: f.attendantId || undefined,
        outcome: f.outcome || undefined,
        reason: f.reason || undefined,
        search: f.search.trim() || undefined,
      });
      setLogs(l);
      // Acumula vendedores conhecidos para o filtro (união dos resultados)
      setLogAttendants((prev) => {
        const map = new Map(prev.map((a) => [a.id, a.name]));
        for (const log of l) if (log.attendantId && log.attendantName) map.set(log.attendantId, log.attendantName);
        return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch { /* silent */ }
  }, []);

  // Rebusca o histórico quando os filtros mudam (busca por texto com atraso)
  useEffect(() => {
    if (tab !== "history") return;
    const t = setTimeout(() => fetchLogs(logFilters), logFilters.search ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, logFilters]);

  const fetchUsersAndSectors = useCallback(async () => {
    try {
      const [u, sec, st] = await Promise.all([api.admin.users.list(), api.sectors.listAll(), api.stores.list(true)]);
      setUserRows(u as UserRow[]);
      setSectors(sec);
      setStores(st);
    } catch { /* silent */ }
  }, []);

  const fetchWAStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/whatsapp/sessions", { credentials: "include" });
      if (r.ok) setWaSessions(await r.json() as WASession[]);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchAll();
    if (user?.role === "admin") fetchUsersAndSectors();
    fetchWAStatus();
    const iv = setInterval(fetchAll, 8000);
    return () => clearInterval(iv);
  }, [fetchAll, fetchUsersAndSectors, fetchWAStatus, user?.role]);

  // ── Real-time Visão Geral: refresh the summary the moment CRM, chat or queue
  // state changes, instead of waiting for the 8s poll. Debounced so a burst of
  // events triggers a single refetch.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const es = acquireSharedEventSource(CHAT_EVENTS_URL);
    const scheduleRefresh = () => {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        fetchAll();
      }, 500);
    };
    const events = [
      "crm_contact_created", "crm_contact_updated", "crm_contact_deleted",
      "conversation_new", "conversation_updated",
    ];
    for (const ev of events) es.addEventListener(ev, scheduleRefresh);
    return () => {
      for (const ev of events) es.removeEventListener(ev, scheduleRefresh);
      releaseSharedEventSource(CHAT_EVENTS_URL);
      if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [fetchAll]);

  useEffect(() => {
    if (tab !== "whatsapp") return;
    fetchWAStatus();
    const iv = setInterval(fetchWAStatus, 2500);
    return () => clearInterval(iv);
  }, [tab, fetchWAStatus]);

  // Prévia do chat interno e saldo bancário na Visão Geral: só busca quando a
  // aba está aberta (dados leves, mas sem motivo pra puxar isso sempre).
  // O saldo bancário é melhor esforço — quem não tem acesso ao módulo
  // (Financeiro Bancário é adminOnly) simplesmente não vê o card.
  useEffect(() => {
    if (tab !== "dashboard") return;
    let cancelled = false;
    api.internalChat.conversations()
      .then((list) => { if (!cancelled) setInternalPreview(list.filter((c) => c.unreadCount > 0)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tab, user?.role]);

  const handleWARefresh = async () => {
    setWaLoading(true);
    try {
      await fetchWAStatus();
      toast({ title: "Status atualizado!" });
    } catch {
      toast({ title: "Erro", variant: "destructive" });
    } finally { setWaLoading(false); }
  };

  const totalWaiting = summary.reduce((a, s) => a + s.waiting, 0);
  const totalInProgress = summary.reduce((a, s) => a + s.inProgress, 0);
  const totalDone = summary.reduce((a, s) => a + s.completedToday, 0);

  // ---- User handlers ----
  const openAddUser = () => {
    setEditUser(null);
    setUserForm({ name: "", email: "", password: "", role: "vendedor", sectorId: sectors[0]?.id ?? 1, storeName: "", extension: "", adminAccess: [], moduleAccess: {}, ahEnabled: false, ahStart: "08:00", ahEnd: "18:00", ahDays: [1, 2, 3, 4, 5, 6], waEnabled: false, waKeys: [] });
    setOpenUserSections(new Set(["basico"]));
    setShowAddUser(true);
  };
  const openEditUser = (u: UserRow) => {
    setEditUser(u);
    setUserForm({ name: u.name, email: u.email, password: "", role: u.role, sectorId: u.sectorId ?? 1, storeName: u.storeName ?? "", extension: u.extension ?? "", adminAccess: u.adminAccess ?? [], moduleAccess: u.moduleAccess ?? {}, ahEnabled: !!u.accessHours, ahStart: u.accessHours?.start ?? "08:00", ahEnd: u.accessHours?.end ?? "18:00", ahDays: u.accessHours?.days?.length ? u.accessHours.days : [1, 2, 3, 4, 5, 6], waEnabled: !!u.allowedSessionKeys, waKeys: u.allowedSessionKeys ?? [] });
    setOpenUserSections(new Set(["basico"]));
    setShowAddUser(true);
  };
  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editUser) {
        const payload: Parameters<typeof api.admin.users.update>[1] = {
          name: userForm.name, email: userForm.email, role: userForm.role, sectorId: userForm.sectorId,
          storeName: userForm.storeName,
          extension: userForm.extension,
          adminAccess: userForm.role === "admin" ? null : userForm.adminAccess,
          moduleAccess: userForm.role === "admin" ? null : userForm.moduleAccess,
          accessHours: userForm.role === "vendedor" && userForm.ahEnabled
            ? { start: userForm.ahStart, end: userForm.ahEnd, days: userForm.ahDays }
            : null,
          allowedSessionKeys: userForm.role === "vendedor" && userForm.waEnabled ? userForm.waKeys : null,
        };
        if (userForm.password) payload.password = userForm.password;
        await api.admin.users.update(editUser.id, payload);
        toast({ title: "Atendente atualizado!" });
      } else {
        await api.admin.users.create({
          name: userForm.name, email: userForm.email, password: userForm.password, role: userForm.role, sectorId: userForm.sectorId,
          storeName: userForm.storeName, extension: userForm.extension,
          adminAccess: userForm.role === "admin" ? null : userForm.adminAccess,
          moduleAccess: userForm.role === "admin" ? null : userForm.moduleAccess,
          accessHours: userForm.role === "vendedor" && userForm.ahEnabled
            ? { start: userForm.ahStart, end: userForm.ahEnd, days: userForm.ahDays }
            : null,
          allowedSessionKeys: userForm.role === "vendedor" && userForm.waEnabled ? userForm.waKeys : null,
        });
        toast({ title: "Atendente criado!" });
      }
      setShowAddUser(false);
      fetchUsersAndSectors();
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  // ---- Sector handlers ----
  const openAddSector = () => {
    setEditSector(null);
    setSectorForm({ name: "", description: "", icon: "smartphone", color: "#1a2e6e", isActive: true });
    setShowAddSector(true);
  };
  const openEditSector = (s: Sector) => {
    setEditSector(s);
    setSectorForm({ name: s.name, description: s.description ?? "", icon: s.icon, color: s.color, isActive: s.isActive });
    setShowAddSector(true);
  };
  const handleSaveSector = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editSector) {
        await api.sectors.update(editSector.id, sectorForm);
        toast({ title: "Setor atualizado!" });
      } else {
        await api.sectors.create(sectorForm);
        toast({ title: "Setor criado!" });
      }
      setShowAddSector(false);
      fetchUsersAndSectors();
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const isAdmin = user?.role === "admin";
  const isSupervisor = user?.role === "supervisor";
  const [showMoreNav, setShowMoreNav] = useState(false);

  // Categorias do menu lateral colapsadas pelo admin — lembradas no navegador.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("sheikcell:sidebar-collapsed");
      return raw ? JSON.parse(raw) as Record<string, boolean> : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("sheikcell:sidebar-collapsed", JSON.stringify(collapsedGroups)); } catch { /* silent */ }
  }, [collapsedGroups]);
  const toggleGroup = (key: string) => setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  // ── Mensagens rápidas (aba de configuração) ──
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [qrForm, setQrForm] = useState<{ id: number | null; title: string; content: string; sectorId: string } | null>(null);
  const [savingQr, setSavingQr] = useState(false);
  useEffect(() => {
    if (tab === "quickreplies") api.chat.quickReplies.list().then(setQuickReplies).catch(() => {});
  }, [tab]);
  const saveQuickReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qrForm || savingQr) return;
    setSavingQr(true);
    try {
      const data = {
        title: qrForm.title, content: qrForm.content,
        sectorId: qrForm.sectorId ? Number(qrForm.sectorId) : null,
      };
      const saved = qrForm.id
        ? await api.chat.quickReplies.update(qrForm.id, data)
        : await api.chat.quickReplies.create(data);
      setQuickReplies((prev) => qrForm.id
        ? prev.map((q) => q.id === saved.id ? saved : q)
        : [...prev, saved].sort((a, b) => a.title.localeCompare(b.title)));
      setQrForm(null);
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSavingQr(false); }
  };
  const deleteQuickReply = async (id: number) => {
    if (!confirm("Excluir esta mensagem rápida?")) return;
    try {
      await api.chat.quickReplies.remove(id);
      setQuickReplies((prev) => prev.filter((q) => q.id !== id));
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const allTabs = [
    { id: "dashboard" as Tab, label: "Visão Geral", icon: LayoutDashboard, adminOnly: false },
    { id: "resultados" as Tab, label: "Resultados", icon: TrendingUp, adminOnly: false, module: "resultados" as OptionalModule },
    { id: "relatorios" as Tab, label: "Relatórios", icon: FileBarChart2, adminOnly: true, module: "relatorios" as OptionalModule },
    { id: "chat" as Tab, label: "Atendimento", icon: MessageCircle, adminOnly: false, module: "chat" as OptionalModule },
    { id: "equipe" as Tab, label: "Chat Interno", icon: MessagesSquare, adminOnly: false, module: "equipe" as OptionalModule },
    { id: "tarefas" as Tab, label: "Tarefas", icon: ListTodo, adminOnly: false, module: "tarefas" as OptionalModule },
    { id: "crm" as Tab, label: "CRM", icon: Kanban, adminOnly: false, module: "crm" as OptionalModule },
    { id: "financeiro" as Tab, label: "Financeiro", icon: BadgeDollarSign, adminOnly: true, module: "financeiro" as OptionalModule },
    { id: "financeiras" as Tab, label: "Financeiras", icon: Landmark, adminOnly: false, module: "financeiras" as OptionalModule },
    { id: "avaliacao" as Tab, label: "Avaliação de Usados", icon: BadgeDollarSign, adminOnly: false, module: "avaliacao" as OptionalModule },
    { id: "tvbox" as Tab, label: "TV Box", icon: Tv, adminOnly: false, module: "tvbox" as OptionalModule },
    { id: "questionarios" as Tab, label: "Questionários", icon: ClipboardList, adminOnly: true, module: "questionarios" as OptionalModule },
    { id: "rotinas" as Tab, label: "Rotinas e Produtividade", icon: ListChecks, adminOnly: true, module: "rotinas" as OptionalModule },
    { id: "treinamentos" as Tab, label: "Treinamentos", icon: GraduationCap, adminOnly: false, module: "treinamentos" as OptionalModule },
    { id: "documentos" as Tab, label: "Documentos", icon: FolderArchive, adminOnly: false, module: "documentos" as OptionalModule },
    { id: "diretorio" as Tab, label: "Diretório", icon: BookUser, adminOnly: false, module: "diretorio" as OptionalModule },
    { id: "suporte" as Tab, label: "Suporte", icon: LifeBuoy, adminOnly: false },
    { id: "rh" as Tab, label: "RH", icon: UserSearch, adminOnly: true, module: "rh" as OptionalModule },
    { id: "meuponto" as Tab, label: "Meu Ponto", icon: Clock, adminOnly: false },
    { id: "sorteios" as Tab, label: "Sorteios", icon: Gift, adminOnly: true, module: "sorteios" as OptionalModule },
    { id: "robo" as Tab, label: "Robô", icon: Bot, adminOnly: true, module: "robo" as OptionalModule },
    { id: "history" as Tab, label: "Histórico", icon: ClipboardList, adminOnly: false, module: "history" as OptionalModule },
    { id: "users" as Tab, label: "Usuários", icon: Users, adminOnly: true },
    { id: "sectors" as Tab, label: "Setores", icon: Settings, adminOnly: true },
    { id: "quickreplies" as Tab, label: "Msgs Rápidas", icon: Zap, adminOnly: true },
    { id: "whatsapp" as Tab, label: "WhatsApp", icon: PhoneCall, adminOnly: true },
    { id: "aparencia" as Tab, label: "Aparência", icon: Palette, adminOnly: true },
    { id: "integracoes" as Tab, label: "Integrações", icon: Plug, adminOnly: true },
    { id: "sistema" as Tab, label: "Sistema (Dev)", icon: Wrench, adminOnly: true },
  ];
  // Aba de admin aparece para admin OU para quem recebeu a função no cadastro
  const granted = user?.adminAccess ?? [];
  // Módulo opcional não contratado pela loja: some do menu (e a API já
  // bloqueia direto, ver requireModule no backend).
  const enabledModules = user?.enabledModules ?? null;
  // Módulo restrito por USUÁRIO (admin sempre vê tudo; Atendimento nunca
  // entra nessa granularidade — ver lib/moduleAccess.ts no backend).
  const userModuleAccess = user?.moduleAccess ?? null;
  const moduleGranted = (m: OptionalModule | undefined): boolean =>
    !m || m === "chat" || isAdmin || (userModuleAccess != null && m in userModuleAccess);
  const tabs = allTabs.filter((t) =>
    (!t.adminOnly || isAdmin || granted.includes(t.id)) &&
    (!t.module || enabledModules == null || enabledModules.includes(t.module)) &&
    moduleGranted(t.module));
  // Celular: 4 abas principais + "Mais" (painel com o restante)
  const mobilePrimaryTabs = tabs.slice(0, 4);
  const mobileMoreTabs = tabs.slice(4);

  return (
    <div className="min-h-screen bg-background">
      {/* Navbar */}
      <nav className="bg-white border-b border-border sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <BrandLogo subtitle={isAdmin ? "— Administrador" : isSupervisor ? "— Supervisor" : undefined} />
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:block">{user?.name}</span>
            <button onClick={() => setShowChangePassword(true)} data-testid="button-change-password"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition">
              <KeyRound className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Trocar senha</span>
            </button>
            <button onClick={() => logout()} data-testid="button-logout"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition">
              <LogOut className="w-3.5 h-3.5" /> Sair
            </button>
          </div>
        </div>
      </nav>
      {user?.impersonatedBy && (
        <div className="bg-amber-500 text-white text-xs sm:text-sm px-4 py-2 flex items-center justify-center gap-3 flex-wrap sticky top-14 z-20">
          <span>Você (<strong>{user.impersonatedBy.name}</strong>) está atuando como <strong>{user.name}</strong></span>
          <button
            onClick={async () => { await api.auth.stopImpersonation(); window.location.href = "/"; }}
            data-testid="button-stop-impersonation"
            className="underline font-semibold hover:no-underline"
          >
            Voltar ao Painel do Sistema
          </button>
        </div>
      )}
      <PontoGate />
      <ChecklistGate />
      {showChangePassword && (
        <ChangePasswordModal onDone={() => { setShowChangePassword(false); toast({ title: "Senha alterada com sucesso!" }); }}
          onClose={() => setShowChangePassword(false)} />
      )}
      <TrainingGate />
      <RoutineChecklistGate />

      {/* Left sidebar + content */}
      <div className="flex">
        {/* Sidebar tabs */}
        <aside className="hidden md:block w-56 shrink-0 border-r border-border bg-white sticky top-14 self-start h-[calc(100vh-3.5rem)] overflow-y-auto p-3">
          <div className="flex flex-col gap-3">
            {TAB_GROUPS.map((group) => {
              // Segue a ordem definida em group.tabIds (não a ordem de allTabs).
              const groupTabs = group.tabIds
                .map((id) => tabs.find((t) => t.id === id))
                .filter((t): t is typeof tabs[number] => !!t);
              if (groupTabs.length === 0) return null;
              const collapsed = !!collapsedGroups[group.key];
              return (
                <div key={group.key}>
                  <button onClick={() => toggleGroup(group.key)} data-testid={`group-toggle-${group.key}`}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wide text-muted-foreground hover:text-foreground transition">
                    <group.icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="flex-1 text-left truncate">{group.label}</span>
                    <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                  </button>
                  {!collapsed && (
                    <div className="flex flex-col gap-1 mt-1">
                      {groupTabs.map(({ id, label, icon: Icon }) => (
                        <button key={id} onClick={() => setTab(id)} data-testid={`tab-${id}`}
                          className={`flex items-center gap-2 w-full pl-6 pr-3 py-2 rounded-lg text-xs font-semibold text-left transition-colors ${
                            tab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                          }`}>
                          <Icon className="w-4 h-4 shrink-0" />{label}
                          {id === "equipe" && internalChatUnread > 0 && (
                            <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center" data-testid="badge-internal-chat-unread">
                              {internalChatUnread > 99 ? "99+" : internalChatUnread}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
          {/* O chat e o Chat Interno ocupam a largura toda; as demais abas ficam na coluna central */}
          <div className={tab === "chat" || tab === "equipe" ? "max-w-full px-0 py-0 md:px-4 md:py-4" : "max-w-5xl mx-auto px-4 py-6"}>

        {/* === RESULTADOS TAB === */}
        {tab === "resultados" && <Resultados />}
        {tab === "relatorios" && <Relatorios />}

        {/* === DASHBOARD TAB === */}
        {tab === "dashboard" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Aguardando", value: totalWaiting, icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
                { label: "Em Atendimento", value: totalInProgress, icon: PhoneCall, color: "text-blue-600", bg: "bg-blue-50" },
                { label: "Finalizados Hoje", value: totalDone, icon: TrendingUp, color: "text-green-600", bg: "bg-green-50" },
                { label: "Tempo Médio", value: formatDuration(attention?.avgServiceSeconds ?? null), icon: Clock, color: "text-foreground", bg: "bg-secondary/60" },
              ].map(({ label, value, icon: Icon, color, bg }) => (
                <div key={label} className={`shk-card p-5 text-center ${bg}`}>
                  <Icon className={`w-6 h-6 mx-auto mb-1 ${color}`} />
                  <div className={`text-3xl font-extrabold ${color}`}>{loading ? "—" : value}</div>
                  <div className="text-xs text-muted-foreground font-medium mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {(() => {
              const waitingTooLong = attention?.waitingTooLong ?? [];
              const overdueTasks = attention?.overdueTasks ?? [];
              const pontoFlagged = attention?.pontoFlagged ?? [];
              const attentionCount = waitingTooLong.length + overdueTasks.length + pontoFlagged.length;
              const disconnectedWA = (waSessions ?? []).filter((s) => s.status === "disconnected" || s.status === "unconfigured");
              return (
                <div className="grid lg:grid-cols-3 gap-4 items-start">
                  <div className="lg:col-span-2 shk-card p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-bold text-foreground flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />Precisa de atenção agora
                      </h2>
                      {attentionCount > 0 && (
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{attentionCount} {attentionCount === 1 ? "item" : "itens"}</span>
                      )}
                    </div>
                    {attentionCount === 0 && disconnectedWA.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">Tudo em dia — nenhum cliente esperando, nenhuma tarefa atrasada. 🎉</p>
                    ) : (
                      <div className="divide-y divide-border">
                        {waitingTooLong.map((c) => (
                          <button key={`w-${c.id}`} onClick={() => setTab("chat")} data-testid={`attention-waiting-${c.id}`}
                            className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-secondary/40 rounded-lg px-2 -mx-2 transition">
                            <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0"><Clock className="w-4 h-4" /></div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold truncate">{c.name} <span className="font-normal text-muted-foreground">sem resposta{c.waitingMinutes != null ? ` há ${c.waitingMinutes} min` : ""}</span></p>
                              <p className="text-xs text-muted-foreground truncate">{c.sectorName ?? "Sem setor"}</p>
                            </div>
                          </button>
                        ))}
                        {overdueTasks.map((t) => (
                          <button key={`t-${t.id}`} onClick={() => setTab("tarefas")} data-testid={`attention-task-${t.id}`}
                            className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-secondary/40 rounded-lg px-2 -mx-2 transition">
                            <div className="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0"><ListTodo className="w-4 h-4" /></div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold truncate">{t.title}</p>
                              <p className="text-xs text-muted-foreground truncate">
                                {t.assigneeName ?? "Sem responsável"} · atrasada {t.daysOverdue != null && t.daysOverdue > 0 ? `há ${t.daysOverdue}d` : "hoje"}
                              </p>
                            </div>
                          </button>
                        ))}
                        {pontoFlagged.map((p) => (
                          <button key={`ponto-${p.id}`} onClick={() => setTab("rh")} data-testid={`attention-ponto-${p.id}`}
                            className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-secondary/40 rounded-lg px-2 -mx-2 transition">
                            <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0"><Smartphone className="w-4 h-4" /></div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold truncate">{p.employeeName} <span className="font-normal text-muted-foreground">— ponto duplicado, revisar</span></p>
                              <p className="text-xs text-muted-foreground truncate">{p.flagReason ?? "Duas fotos em pouco tempo"}</p>
                            </div>
                          </button>
                        ))}
                        {disconnectedWA.map((s) => (
                          <button key={`wa-${s.sessionKey}`} onClick={() => setTab("whatsapp")} data-testid={`attention-wa-${s.sessionKey}`}
                            className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-secondary/40 rounded-lg px-2 -mx-2 transition">
                            <div className="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0"><WifiOff className="w-4 h-4" /></div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold truncate">{s.displayName ?? (s.sessionKey === "default" ? "Principal" : s.sessionKey)} desconectado</p>
                              <p className="text-xs text-muted-foreground truncate">Reconectar para não perder mensagens</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-4">
                    <div className="shk-card p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="font-bold text-foreground flex items-center gap-2 text-sm">
                          <MessagesSquare className="w-4 h-4 text-primary" />Chat Interno
                        </h2>
                        {internalChatUnread > 0 && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600">{internalChatUnread}</span>}
                      </div>
                      {internalPreview.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">Nenhuma mensagem não lida.</p>
                      ) : (
                        <div className="space-y-1">
                          {internalPreview.slice(0, 4).map((c) => (
                            <button key={c.id} onClick={() => setTab("equipe")} data-testid={`internal-preview-${c.id}`}
                              className="w-full flex items-center gap-2 py-1.5 text-left hover:bg-secondary/40 rounded-lg px-2 -mx-2 transition">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-semibold truncate">{c.name}</p>
                                <p className="text-[11px] text-muted-foreground truncate">{c.lastMessage ?? ""}</p>
                              </div>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500 text-white shrink-0">{c.unreadCount}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {(() => {
                      const funnel = attention?.funnel;
                      const total = funnel ? funnel.potential + funnel.active : 0;
                      const conversionRate = funnel && total > 0 ? Math.round((funnel.active / total) * 100) : null;
                      return (
                        <button onClick={() => setTab("chat")} data-testid="attention-funnel" className="shk-card p-5 text-left hover:bg-secondary/20 transition">
                          <h2 className="font-bold text-foreground flex items-center gap-2 text-sm mb-3">
                            <Filter className="w-4 h-4 text-violet-600" />Qualidade do funil
                          </h2>
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-center flex-1">
                              <div className="text-2xl font-extrabold text-violet-600">{loading ? "—" : funnel?.potential ?? 0}</div>
                              <div className="text-[11px] text-muted-foreground">Potencial<br />(só bot)</div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                            <div className="text-center flex-1">
                              <div className="text-2xl font-extrabold text-blue-600">{loading ? "—" : funnel?.active ?? 0}</div>
                              <div className="text-[11px] text-muted-foreground">Ativo<br />(humano)</div>
                            </div>
                          </div>
                          {conversionRate !== null && (
                            <p className="text-xs text-muted-foreground text-center mt-3 pt-2 border-t border-border">
                              {conversionRate}% dos contatos em aberto já viraram atendimento humano
                            </p>
                          )}
                        </button>
                      );
                    })()}

                  </div>
                </div>
              );
            })()}

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-bold text-foreground">Setores</h2>
                <button onClick={fetchAll} className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {summary.map(({ sector, waiting, inProgress, completedToday, totalAttendants, busyAttendants }) => (
                  <div key={sector.id} className="shk-card p-5" data-testid={`card-sector-${sector.id}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: sector.color + "20" }}>
                        <SectorIcon icon={sector.icon} className="w-5 h-5" style={{ color: sector.color }} />
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-sm text-foreground truncate">{sector.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{sector.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mb-3 text-xs text-muted-foreground">
                      <Users className="w-3.5 h-3.5" />
                      <span>
                        <span className="font-semibold text-foreground">{busyAttendants}</span>/{totalAttendants} atendente{totalAttendants !== 1 ? "s" : ""} ativo{busyAttendants !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center border-t border-border pt-3">
                      <div>
                        <div className="text-lg font-extrabold text-amber-600">{waiting}</div>
                        <div className="text-xs text-muted-foreground">Aguard.</div>
                      </div>
                      <div>
                        <div className="text-lg font-extrabold text-blue-600">{inProgress}</div>
                        <div className="text-xs text-muted-foreground">Atend.</div>
                      </div>
                      <div>
                        <div className="text-lg font-extrabold text-green-600">{completedToday}</div>
                        <div className="text-xs text-muted-foreground">Finalizados</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* === CRM TAB === */}
        {/* ChatCenter fica SEMPRE montado (escondido nas outras abas) para o
            alarme de mensagem sem resposta tocar e aparecer em qualquer tela. */}
        <div className={tab === "chat" ? "" : "hidden"}>
          <ChatCenter focusConversationId={focusConversationId} focusRequestId={focusRequestId} />
        </div>

        {tab === "equipe" && (
          <InternalChat key={focusInternalRequestId} initialConversationId={focusInternalConversationId} />
        )}

        {tab === "tarefas" && <TaskBoard />}

        {tab === "crm" && <CrmBoard />}

        {tab === "financeiras" && <Financeiras />}

        {tab === "avaliacao" && <Avaliacao />}

        {tab === "tvbox" && <TvBox />}

        {tab === "questionarios" && <Questionarios />}

        {tab === "rotinas" && <RotinasProdutividade />}

        {tab === "treinamentos" && <Treinamentos />}

        {tab === "documentos" && <Documentos />}

        {tab === "diretorio" && <TeamDirectory />}

        {tab === "suporte" && <Suporte />}

        {tab === "rh" && <RH />}

        {tab === "meuponto" && <MeuPonto />}

        {tab === "sorteios" && <Sorteios />}

        {tab === "robo" && <Robo />}

        {tab === "financeiro" && <Financeiro />}

        {tab === "aparencia" && <ConfiguracoesAparencia />}
        {tab === "integracoes" && <ConfiguracoesIntegracoes />}

        {tab === "sistema" && <SystemBoard />}

        {/* === WHATSAPP TAB === */}
        {tab === "whatsapp" && (
          <div className="max-w-lg mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-foreground">Conexões WhatsApp</h2>
              <button onClick={handleWARefresh} disabled={waLoading}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition text-sm disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${waLoading ? "animate-spin" : ""}`} />
                Atualizar
              </button>
            </div>

            {waSessions === null && (
              <div className="shk-card p-6 text-center">
                <RefreshCw className="w-10 h-10 mx-auto text-muted-foreground mb-3 animate-spin" />
                <p className="text-sm text-muted-foreground">Verificando conexões…</p>
              </div>
            )}

            {waSessions?.map((s) => (
              <div key={s.sessionKey} className="shk-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Smartphone className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-bold text-foreground truncate">
                      {s.displayName ?? (s.sessionKey === "default" ? "Principal" : s.sessionKey)}
                    </span>
                    <button
                      title="Renomear"
                      onClick={async () => {
                        const name = window.prompt("Novo nome da conexão:", s.displayName ?? "");
                        if (!name?.trim()) return;
                        await fetch(`/api/whatsapp/sessions/${s.sessionKey}/rename`, {
                          method: "POST", credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ displayName: name.trim() }),
                        });
                        fetchWAStatus();
                      }}
                      className="p-1 text-muted-foreground hover:text-foreground rounded transition shrink-0">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.status === "connected" && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                        <span className="w-2 h-2 rounded-full bg-green-500" />Conectado
                      </span>
                    )}
                    {s.status === "qr" && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
                        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />Aguardando QR
                      </span>
                    )}
                    {(s.status === "connecting" || s.status === "reconnecting") && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                        {s.status === "reconnecting" ? "Reconectando…" : "Conectando…"}
                      </span>
                    )}
                    {(s.status === "disconnected" || s.status === "error" || s.status === "unconfigured") && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                        <span className="w-2 h-2 rounded-full bg-red-500" />Desconectado
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-sm text-muted-foreground mb-3 space-y-1">
                  {s.phoneNumber && (
                    <p>Número: <span className="font-semibold text-foreground">+{s.phoneNumber.replace(/^\+/, "")}</span></p>
                  )}
                  {s.lastHeartbeatAt && (
                    <p className="text-xs">
                      Última conexão:{" "}
                      <span className="font-medium text-foreground">
                        {new Date(s.lastHeartbeatAt).toLocaleString("pt-BR", {
                          day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
                        })}
                      </span>
                    </p>
                  )}
                  {s.errorMessage && <p className="text-xs text-red-600">{s.errorMessage}</p>}
                </div>

                {/* QR code */}
                {s.status === "qr" && s.qrDataUrl && (
                  <div className="text-center mb-3">
                    <img src={s.qrDataUrl} alt={`QR WhatsApp ${s.sessionKey}`} className="mx-auto w-52 h-52 rounded-xl border border-border" />
                    <p className="text-xs text-muted-foreground mt-2">
                      WhatsApp → Menu → <strong>Aparelhos conectados</strong> → <strong>Conectar um aparelho</strong>
                    </p>
                  </div>
                )}
                {s.status === "qr" && !s.qrDataUrl && (
                  <div className="text-center mb-3">
                    <RefreshCw className="w-8 h-8 mx-auto text-blue-500 mb-2 animate-spin" />
                    <p className="text-xs text-muted-foreground">Gerando QR code…</p>
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={async () => {
                      if (s.status === "connected" && !window.confirm("Desconectar este número? Um novo QR code será gerado.")) return;
                      setWaLoading(true);
                      try {
                        await fetch("/api/whatsapp/reset", {
                          method: "POST", credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ session: s.sessionKey }),
                        });
                        await fetchWAStatus();
                      } finally { setWaLoading(false); }
                    }}
                    disabled={waLoading}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition text-sm disabled:opacity-50">
                    <RefreshCw className="w-4 h-4" />
                    {s.status === "connected" ? "Desconectar / Trocar número" : "Reconectar / Novo QR"}
                  </button>
                  {(
                    <button
                      onClick={async () => {
                        const msg = s.sessionKey === "default"
                          ? "Excluir esta conexão? O QR code atual é apagado, o número é desvinculado e um novo QR será gerado para conectar outro WhatsApp."
                          : `Remover a conexão "${s.displayName ?? s.sessionKey}"? As conversas dela passam a responder pela conexão principal.`;
                        if (!window.confirm(msg)) return;
                        setWaLoading(true);
                        try {
                          const r = await fetch(`/api/whatsapp/sessions/${s.sessionKey}`, { method: "DELETE", credentials: "include" });
                          if (!r.ok) {
                            const d = await r.json().catch(() => null) as { error?: string } | null;
                            toast({ title: "Erro", description: d?.error ?? "Erro ao remover", variant: "destructive" });
                          } else {
                            toast(s.sessionKey === "default"
                              ? { title: "Conexão excluída", description: "Aguarde o novo QR code para conectar outro WhatsApp." }
                              : { title: "Conexão removida" });
                          }
                          await fetchWAStatus();
                        } finally { setWaLoading(false); }
                      }}
                      disabled={waLoading}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition text-sm disabled:opacity-50">
                      <X className="w-4 h-4" />
                      {s.sessionKey === "default" ? "Excluir conexão" : "Remover"}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Add connection */}
            <div className="shk-card p-5">
              <p className="text-sm font-semibold text-foreground mb-2">Adicionar novo número</p>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const name = newConnName.trim();
                  if (!name) return;
                  setWaLoading(true);
                  try {
                    const r = await fetch("/api/whatsapp/sessions", {
                      method: "POST", credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ displayName: name }),
                    });
                    const d = await r.json().catch(() => null) as { error?: string } | null;
                    if (!r.ok) {
                      toast({ title: "Erro", description: d?.error ?? "Erro ao criar conexão", variant: "destructive" });
                    } else {
                      toast({ title: "Conexão criada!", description: "Aguarde o QR code aparecer para escanear." });
                      setNewConnName("");
                    }
                    await fetchWAStatus();
                  } finally { setWaLoading(false); }
                }}
                className="flex items-center gap-2">
                <input
                  value={newConnName}
                  onChange={(e) => setNewConnName(e.target.value)}
                  placeholder="Nome da conexão (ex.: Vendas, Suporte)"
                  className="flex-1 px-3 py-2 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button type="submit" disabled={waLoading || !newConnName.trim()}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">
                  <Plus className="w-4 h-4" />
                  Adicionar
                </button>
              </form>
              <p className="text-xs text-muted-foreground mt-2">
                Cada conexão é um número de WhatsApp diferente. Depois de criar, escaneie o QR code com o celular do número desejado.
              </p>
            </div>

            {/* Info */}
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 text-xs text-blue-800">
              <strong>Sessões salvas no banco de dados</strong> — após escanear o QR uma vez, cada conexão
              reconecta sozinha após reinicializações. As respostas de cada conversa saem sempre pelo
              número que o cliente chamou.
            </div>
          </div>
        )}

        {/* === HISTORY TAB === */}
        {tab === "history" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Histórico de Atendimentos</h2>
              <button onClick={() => fetchLogs(logFilters)}
                className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            {/* Filtros do histórico */}
            <div className="shk-card p-3 flex flex-wrap items-center gap-2">
              <input value={logFilters.search} data-testid="input-history-search"
                onChange={(e) => setLogFilters({ ...logFilters, search: e.target.value })}
                placeholder="Buscar cliente ou telefone..."
                className="px-3 py-1.5 rounded-lg border border-border text-xs w-48 focus:outline-none focus:ring-2 focus:ring-primary/30" />
              <select value={logFilters.days} onChange={(e) => setLogFilters({ ...logFilters, days: Number(e.target.value) })}
                data-testid="select-history-days" className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                <option value={0}>Todo o período</option>
                <option value={1}>Hoje</option>
                <option value={7}>Últimos 7 dias</option>
                <option value={30}>Últimos 30 dias</option>
                <option value={90}>Últimos 90 dias</option>
              </select>
              <select value={logFilters.sectorId} onChange={(e) => setLogFilters({ ...logFilters, sectorId: Number(e.target.value) })}
                data-testid="select-history-sector" className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                <option value={0}>Todos os setores</option>
                {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={logFilters.attendantId} onChange={(e) => setLogFilters({ ...logFilters, attendantId: Number(e.target.value) })}
                data-testid="select-history-attendant" className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                <option value={0}>Todos os vendedores</option>
                {logAttendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select value={logFilters.outcome} onChange={(e) => setLogFilters({ ...logFilters, outcome: e.target.value })}
                data-testid="select-history-outcome" className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                <option value="">Todos os resultados</option>
                <option value="completed">Finalizado</option>
                <option value="transferred">Transferido</option>
              </select>
              <select value={logFilters.reason} onChange={(e) => setLogFilters({ ...logFilters, reason: e.target.value })}
                data-testid="select-history-reason" className="px-2 py-1.5 rounded-lg border border-border text-xs bg-white">
                <option value="">Todos os motivos</option>
                {["Venda realizada","Orçamento enviado","Cliente vai pensar","Sem interesse","Sem resposta do cliente","Dúvida esclarecida","Problema resolvido","Outro"].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              {(logFilters.search || logFilters.days || logFilters.sectorId || logFilters.attendantId || logFilters.outcome || logFilters.reason) ? (
                <button onClick={() => setLogFilters({ search: "", days: 0, sectorId: 0, attendantId: 0, outcome: "", reason: "" })}
                  data-testid="button-history-clear" className="text-xs text-primary font-semibold hover:underline">Limpar filtros</button>
              ) : null}
              <span className="ml-auto text-[11px] text-muted-foreground">{logs.length} resultado{logs.length === 1 ? "" : "s"}{logs.length === 200 ? " (máx.)" : ""}</span>
            </div>
            {logs.length === 0 ? (
              <div className="shk-card p-10 text-center">
                <CheckCircle className="w-10 h-10 mx-auto text-muted-foreground mb-2" />
                <p className="text-muted-foreground text-sm">Nenhum atendimento encontrado com esses filtros</p>
              </div>
            ) : (
              <div className="shk-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50">
                      <tr>
                        {["Cliente", "Setor", "Atendente", "Canal", "Resultado", "Motivo", "Espera", "Atend.", "Hora"].map((h) => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log, i) => (
                        <tr key={log.id} className={i % 2 === 0 ? "bg-white" : "bg-secondary/20"} data-testid={`row-log-${log.id}`}>
                          <td className="px-4 py-3 font-medium">{log.clientName}</td>
                          <td className="px-4 py-3 text-muted-foreground">{log.sectorName}</td>
                          <td className="px-4 py-3 text-muted-foreground">{log.attendantName ?? "—"}</td>
                          <td className="px-4 py-3"><ChannelBadge channel={log.channel} /></td>
                          <td className="px-4 py-3">
                            <span className={log.outcome === "completed" ? "shk-badge-done" : log.outcome === "transferred" ? "shk-badge-progress" : "shk-badge-waiting"}>
                              {log.outcome === "completed" ? "Finalizado" : log.outcome === "transferred" ? "Transferido" : log.outcome ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{log.resolutionReason ?? "—"}</td>
                          <td className="px-4 py-3 text-muted-foreground">{formatDuration(log.waitTimeSeconds)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{formatDuration(log.serviceTimeSeconds)}</td>
                          <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(log.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* === USERS TAB === */}
        {tab === "users" && (
          <div className="space-y-4">
            <EquipeOnline />
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Usuários</h2>
              <button onClick={openAddUser} data-testid="button-add-user"
                className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
                <Plus className="w-3.5 h-3.5" /> Novo Usuário
              </button>
            </div>
            <div className="shk-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50">
                    <tr>
                      {["Nome", "Email", "Setor", "Loja", "Perfil", "Status", ""].map((h, i) => (
                        <th key={i} className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {userRows.map((u, i) => (
                      <tr key={u.id} className={i % 2 === 0 ? "bg-white" : "bg-secondary/20"} data-testid={`row-user-${u.id}`}>
                        <td className="px-4 py-3 font-medium">{u.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                        <td className="px-4 py-3 text-muted-foreground">{u.sector?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground" data-testid={`user-store-${u.id}`}>{u.storeName || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={
                            u.role === "admin" ? "shk-badge-progress" :
                            u.role === "supervisor" ? "shk-badge-done" :
                            "shk-badge-waiting"
                          }>
                            {u.role === "admin" ? "Admin" :
                             u.role === "supervisor" ? "Supervisor" :
                             "Vendedor"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={u.isActive ? "shk-badge-done" : "shk-badge-waiting"}>
                            {u.isActive ? "Ativo" : "Inativo"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEditUser(u)} data-testid={`button-edit-user-${u.id}`}
                              className="p-1.5 text-muted-foreground hover:text-primary hover:bg-blue-50 rounded-lg transition">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {u.id !== user?.id && u.isActive && (
                              <button onClick={() => { setDeactivateUser(u); setDeactTransferTo(""); }}
                                data-testid={`button-deactivate-user-${u.id}`} title="Inativar usuário"
                                className="p-1.5 text-muted-foreground hover:text-amber-600 hover:bg-amber-50 rounded-lg transition">
                                <UserX className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {u.id !== user?.id && !u.isActive && (
                              <button
                                onClick={async () => {
                                  try {
                                    await api.admin.users.update(u.id, { isActive: true });
                                    toast({ title: "Usuário reativado", description: `${u.name} pode entrar no sistema novamente.` });
                                    fetchUsersAndSectors();
                                  } catch (err) {
                                    toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                                  }
                                }}
                                data-testid={`button-reactivate-user-${u.id}`} title="Reativar usuário"
                                className="p-1.5 text-muted-foreground hover:text-green-600 hover:bg-green-50 rounded-lg transition">
                                <UserCheck className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {u.id !== user?.id && (
                              <button onClick={() => { setDeleteUser(u); setDeleteTransferTo(""); }}
                                data-testid={`button-delete-user-${u.id}`} title="Excluir usuário"
                                className="p-1.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 rounded-lg transition">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(u.role === "vendedor" || u.role === "supervisor") && (
                              <button
                                onClick={() => {
                                  const draft: Record<string, boolean> = {};
                                  for (const k of PERMISSION_KEYS) draft[k] = u.permissions?.[k] !== false;
                                  setPermDraft(draft);
                                  setPermUser(u);
                                }}
                                data-testid={`button-perms-user-${u.id}`}
                                title="Permissões e abas"
                                className="p-1.5 text-muted-foreground hover:text-primary hover:bg-blue-50 rounded-lg transition">
                                <ShieldCheck className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* === SECTORS TAB === */}
        {tab === "quickreplies" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">Mensagens Rápidas</h2>
                <p className="text-xs text-muted-foreground">Respostas prontas que os vendedores inserem no chat com um clique (botão ⚡ na conversa).</p>
              </div>
              <button onClick={() => setQrForm({ id: null, title: "", content: "", sectorId: "" })} data-testid="button-add-quickreply"
                className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition shrink-0">
                <Plus className="w-3.5 h-3.5" /> Nova Mensagem
              </button>
            </div>
            {quickReplies.length === 0 ? (
              <div className="shk-card p-8 text-center text-sm text-muted-foreground">
                Nenhuma mensagem rápida ainda. Crie a primeira — ex.: saudação, horário de funcionamento, formas de pagamento.
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {quickReplies.map((q) => (
                  <div key={q.id} className="shk-card p-4 flex items-start gap-3" data-testid={`card-quickreply-${q.id}`}>
                    <div className="w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
                      <Zap className="w-4 h-4 text-amber-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate">{q.title}</p>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">{q.content}</p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {q.sectorId ? (sectors.find((s) => s.id === q.sectorId)?.name ?? "Setor") : "Todos os setores"}
                      </p>
                    </div>
                    <button onClick={() => setQrForm({ id: q.id, title: q.title, content: q.content, sectorId: q.sectorId ? String(q.sectorId) : "" })}
                      data-testid={`button-edit-quickreply-${q.id}`}
                      className="p-2 rounded-lg hover:bg-secondary transition shrink-0"><Pencil className="w-4 h-4 text-muted-foreground" /></button>
                    <button onClick={() => deleteQuickReply(q.id)} data-testid={`button-delete-quickreply-${q.id}`}
                      className="p-2 rounded-lg hover:bg-red-50 transition shrink-0"><Trash2 className="w-4 h-4 text-red-500" /></button>
                  </div>
                ))}
              </div>
            )}
            {qrForm && (
              <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setQrForm(null)}>
                <form onSubmit={saveQuickReply} onClick={(e) => e.stopPropagation()}
                  className="bg-white rounded-2xl p-5 w-full max-w-md space-y-3 shadow-xl">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-sm">{qrForm.id ? "Editar mensagem rápida" : "Nova mensagem rápida"}</h3>
                    <button type="button" onClick={() => setQrForm(null)} className="p-1 rounded hover:bg-secondary"><X className="w-4 h-4" /></button>
                  </div>
                  <input value={qrForm.title} onChange={(e) => setQrForm({ ...qrForm, title: e.target.value })}
                    placeholder="Título (ex.: Saudação)" required maxLength={80} data-testid="input-quickreply-title"
                    className="w-full border border-border rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
                  <textarea value={qrForm.content} onChange={(e) => setQrForm({ ...qrForm, content: e.target.value })}
                    placeholder="Texto da mensagem que será inserido no chat" required rows={4} maxLength={2000} data-testid="input-quickreply-content"
                    className="w-full border border-border rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none" />
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Variáveis disponíveis: <code className="bg-secondary px-1 rounded">{"{{nome}}"}</code> (contato),{" "}
                    <code className="bg-secondary px-1 rounded">{"{{loja}}"}</code> (unidade do atendente) e{" "}
                    <code className="bg-secondary px-1 rounded">{"{{atendente}}"}</code>. São trocadas pelo valor real ao usar a mensagem no Atendimento.
                  </p>
                  <select value={qrForm.sectorId} onChange={(e) => setQrForm({ ...qrForm, sectorId: e.target.value })}
                    data-testid="select-quickreply-sector"
                    className="w-full border border-border rounded-xl px-3 py-2 text-sm outline-none bg-white">
                    <option value="">Todos os setores</option>
                    {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button type="submit" disabled={savingQr} data-testid="button-save-quickreply"
                    className="w-full py-2.5 bg-primary text-white rounded-xl text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
                    {savingQr ? "Salvando..." : "Salvar"}
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {tab === "sectors" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Setores</h2>
              <button onClick={openAddSector} data-testid="button-add-sector"
                className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
                <Plus className="w-3.5 h-3.5" /> Novo Setor
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              {sectors.map((sector) => (
                <div key={sector.id} className="shk-card p-4 flex items-center gap-4" data-testid={`card-sector-config-${sector.id}`}>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: sector.color + "20" }}>
                    <SectorIcon icon={sector.icon} className="w-6 h-6" style={{ color: sector.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm truncate">{sector.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{sector.description ?? "—"}</p>
                  </div>
                  <span className={sector.isActive ? "shk-badge-done" : "shk-badge-waiting"}>
                    {sector.isActive ? "Ativo" : "Inativo"}
                  </span>
                  <button onClick={() => openEditSector(sector)} data-testid={`button-edit-sector-${sector.id}`}
                    className="p-1.5 text-muted-foreground hover:text-primary hover:bg-blue-50 rounded-lg transition">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* ===== Lojas da Rede ===== */}
            <div className="flex items-center justify-between pt-4">
              <h2 className="font-bold">Lojas da Rede</h2>
            </div>
            <div className="shk-card p-4 space-y-3">
              <p className="text-xs text-muted-foreground">As lojas cadastradas aqui aparecem como opção no cadastro de vendedores e de clientes.</p>
              <form className="flex gap-2" onSubmit={async (e) => {
                e.preventDefault();
                const name = newStoreName.trim();
                if (!name) return;
                try {
                  const st = await api.stores.create(name);
                  setStores((prev) => [...prev, st].sort((a, b) => a.name.localeCompare(b.name)));
                  setNewStoreName("");
                } catch (err) {
                  toast({ title: err instanceof Error ? err.message : "Erro ao cadastrar loja", variant: "destructive" });
                }
              }}>
                <input value={newStoreName} onChange={(e) => setNewStoreName(e.target.value)}
                  placeholder="Nome da loja (ex.: Loja Centro)" data-testid="input-new-store"
                  className="flex-1 px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <button type="submit" data-testid="button-add-store"
                  className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
                  <Plus className="w-3.5 h-3.5" /> Cadastrar
                </button>
              </form>
              {stores.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">Nenhuma loja cadastrada ainda.</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2">
                  {stores.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2" data-testid={`store-row-${s.id}`}>
                      <span className={`text-sm font-medium flex-1 truncate ${s.isActive ? "" : "line-through text-muted-foreground"}`}>{s.name}</span>
                      <span className={s.isActive ? "shk-badge-done" : "shk-badge-waiting"}>{s.isActive ? "Ativa" : "Inativa"}</span>
                      <button onClick={async () => {
                        const novo = prompt("Novo nome da loja:", s.name);
                        if (!novo || !novo.trim() || novo.trim() === s.name) return;
                        try {
                          const upd = await api.stores.update(s.id, { name: novo.trim() });
                          setStores((prev) => prev.map((x) => x.id === s.id ? upd : x));
                        } catch (err) { toast({ title: err instanceof Error ? err.message : "Erro", variant: "destructive" }); }
                      }} data-testid={`button-rename-store-${s.id}`}
                        className="p-1.5 text-muted-foreground hover:text-primary hover:bg-blue-50 rounded-lg transition">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={async () => {
                        try {
                          const upd = await api.stores.update(s.id, { isActive: !s.isActive });
                          setStores((prev) => prev.map((x) => x.id === s.id ? upd : x));
                        } catch { /* silent */ }
                      }} data-testid={`button-toggle-store-${s.id}`}
                        className={`text-[11px] font-semibold px-2 py-1 rounded-lg transition ${s.isActive ? "text-red-600 hover:bg-red-50" : "text-green-600 hover:bg-green-50"}`}>
                        {s.isActive ? "Desativar" : "Reativar"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
          </div>
        </div>
      </div>

      {/* ===== PERMISSIONS MODAL ===== */}
      {permUser && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold">Permissões</h3>
              <button onClick={() => setPermUser(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              O que <span className="font-semibold text-foreground">{permUser.name}</span> pode fazer:
            </p>
            <div className="space-y-1 max-h-[50vh] overflow-y-auto">
              {PERMISSION_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-secondary/50 cursor-pointer text-sm" data-testid={`perm-${k}`}>
                  <input
                    type="checkbox"
                    checked={permDraft[k] !== false}
                    onChange={(e) => setPermDraft((d) => ({ ...d, [k]: e.target.checked }))}
                    className="w-4 h-4 accent-[var(--primary)] shrink-0"
                  />
                  <span>{PERMISSION_LABELS[k]}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setPermUser(null)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button
                disabled={savingPerms}
                data-testid="button-save-perms"
                onClick={async () => {
                  setSavingPerms(true);
                  try {
                    await api.admin.users.update(permUser.id, { permissions: permDraft });
                    toast({ title: "Permissões salvas", description: `Permissões de ${permUser.name} atualizadas.` });
                    setPermUser(null);
                    fetchUsersAndSectors();
                  } catch {
                    toast({ title: "Erro", description: "Não foi possível salvar as permissões.", variant: "destructive" });
                  } finally {
                    setSavingPerms(false);
                  }
                }}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white hover:bg-primary/90 transition disabled:opacity-50">
                {savingPerms ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== DEACTIVATE USER MODAL ===== */}
      {deactivateUser && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-amber-600">Inativar usuário</h3>
              <button onClick={() => { if (!deactivating) setDeactivateUser(null); }}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              <span className="font-semibold text-foreground">{deactivateUser.name}</span> não vai mais
              conseguir entrar no sistema, mas o histórico dele fica guardado e você pode reativar quando quiser.
              Escolha para quem vão os atendimentos em andamento:
            </p>
            <div>
              <label className="text-xs font-medium mb-1 block">Transferir para</label>
              <select value={deactTransferTo} onChange={(e) => setDeactTransferTo(e.target.value)}
                data-testid="select-deactivate-transfer"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                <option value="">— Ninguém (voltam para a fila) —</option>
                {userRows.filter((u) => u.id !== deactivateUser.id && u.isActive).map((u) => (
                  <option key={u.id} value={String(u.id)}>{u.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setDeactivateUser(null)} disabled={deactivating}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition disabled:opacity-50">
                Cancelar
              </button>
              <button
                disabled={deactivating}
                data-testid="button-confirm-deactivate-user"
                onClick={async () => {
                  setDeactivating(true);
                  try {
                    const r = await api.admin.users.deactivate(deactivateUser.id, deactTransferTo ? Number(deactTransferTo) : null);
                    toast({
                      title: "Usuário inativado",
                      description: r.transferredConversations > 0
                        ? `${r.transferredConversations} atendimento(s) ${deactTransferTo ? "transferido(s)" : "devolvido(s) para a fila"}.`
                        : `${deactivateUser.name} foi inativado.`,
                    });
                    setDeactivateUser(null);
                    fetchUsersAndSectors();
                  } catch (err) {
                    toast({ title: "Erro ao inativar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                  } finally {
                    setDeactivating(false);
                  }
                }}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 transition disabled:opacity-50">
                {deactivating ? "Inativando..." : "Inativar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== DELETE USER MODAL ===== */}
      {deleteUser && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-red-600">Excluir usuário</h3>
              <button onClick={() => { if (!deletingUser) setDeleteUser(null); }}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              <span className="font-semibold text-foreground">{deleteUser.name}</span> será excluído
              de forma permanente. Escolha para quem vão os atendimentos, tarefas e clientes dele:
            </p>
            <div>
              <label className="text-xs font-medium mb-1 block">Transferir para</label>
              <select value={deleteTransferTo} onChange={(e) => setDeleteTransferTo(e.target.value)}
                data-testid="select-delete-transfer"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                <option value="">— Ninguém (conversas voltam para a fila) —</option>
                {userRows.filter((u) => u.id !== deleteUser.id && u.isActive).map((u) => (
                  <option key={u.id} value={String(u.id)}>{u.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setDeleteUser(null)} disabled={deletingUser}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition disabled:opacity-50">
                Cancelar
              </button>
              <button
                disabled={deletingUser}
                data-testid="button-confirm-delete-user"
                onClick={async () => {
                  setDeletingUser(true);
                  try {
                    const r = await api.admin.users.remove(deleteUser.id, deleteTransferTo ? Number(deleteTransferTo) : null);
                    toast({
                      title: "Usuário excluído",
                      description: r.transferredConversations > 0
                        ? `${r.transferredConversations} atendimento(s) ${deleteTransferTo ? "transferido(s)" : "devolvido(s) para a fila"}.`
                        : `${deleteUser.name} foi removido.`,
                    });
                    setDeleteUser(null);
                    fetchUsersAndSectors();
                  } catch (err) {
                    toast({ title: "Erro ao excluir", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                  } finally {
                    setDeletingUser(false);
                  }
                }}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50">
                {deletingUser ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== USER MODAL ===== */}
      {showAddUser && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg md:max-w-2xl p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editUser ? "Editar Usuário" : "Novo Usuário"}</h3>
              <button onClick={() => setShowAddUser(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSaveUser} className="space-y-4">
              {/* Dados básicos */}
              <div>
                <button type="button" onClick={() => toggleUserSection("basico")} data-testid="usersection-toggle-basico"
                  className="flex items-center gap-2 w-full py-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground hover:text-foreground transition">
                  <span className="flex-1 text-left">Dados básicos</span>
                  <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${openUserSections.has("basico") ? "" : "-rotate-90"}`} />
                </button>
                {openUserSections.has("basico") && (
                  <div className="space-y-3 mt-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium mb-1 block">Nome *</label>
                        <input required placeholder="João da Silva" value={userForm.name}
                          onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Email *</label>
                        <input required type="email" placeholder="joao@sheikcell.com" value={userForm.email}
                          onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium mb-1 block">{editUser ? "Nova senha (deixe em branco para manter)" : "Senha *"}</label>
                      <input type="password" placeholder="••••••••" required={!editUser} value={userForm.password}
                        onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium mb-1 block">Perfil</label>
                        <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                          <option value="vendedor">Vendedor</option>
                          <option value="supervisor">Supervisor</option>
                          <option value="admin">Administrador</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Setor</label>
                        <select value={userForm.sectorId} onChange={(e) => setUserForm({ ...userForm, sectorId: Number(e.target.value) })}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                          {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Acesso e restrições (só vendedor) */}
              {userForm.role === "vendedor" && (
                <div className="pt-3 border-t border-border">
                  <button type="button" onClick={() => toggleUserSection("acesso")} data-testid="usersection-toggle-acesso"
                    className="flex items-center gap-2 w-full py-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground hover:text-foreground transition">
                    <span className="flex-1 text-left">Acesso e restrições</span>
                    <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${openUserSections.has("acesso") ? "" : "-rotate-90"}`} />
                  </button>
                  {openUserSections.has("acesso") && (
                  <div className="space-y-3 mt-2">
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium mb-1">
                      <input type="checkbox" checked={userForm.ahEnabled} data-testid="toggle-access-hours"
                        onChange={(e) => setUserForm({ ...userForm, ahEnabled: e.target.checked })} />
                      Limitar horário de acesso
                    </label>
                    {userForm.ahEnabled && (
                      <div className="space-y-2 mt-1.5 p-2.5 rounded-xl bg-secondary/50 border border-border">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">Das</span>
                          <input type="time" value={userForm.ahStart} data-testid="input-access-start"
                            onChange={(e) => setUserForm({ ...userForm, ahStart: e.target.value })}
                            className="px-2 py-1 rounded-lg border border-border text-xs bg-white" />
                          <span className="text-[11px] text-muted-foreground">às</span>
                          <input type="time" value={userForm.ahEnd} data-testid="input-access-end"
                            onChange={(e) => setUserForm({ ...userForm, ahEnd: e.target.value })}
                            className="px-2 py-1 rounded-lg border border-border text-xs bg-white" />
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {(["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const).map((d, i) => (
                            <button type="button" key={d} data-testid={`toggle-access-day-${i}`}
                              onClick={() => setUserForm({ ...userForm, ahDays: userForm.ahDays.includes(i) ? userForm.ahDays.filter((x) => x !== i) : [...userForm.ahDays, i] })}
                              className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${userForm.ahDays.includes(i) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground bg-white hover:bg-secondary"}`}>
                              {d}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground">Fora desse horário o vendedor não consegue entrar nem usar o sistema (horário de Brasília).</p>
                      </div>
                    )}
                  </div>
                  {waSessions && waSessions.length > 1 && (
                    <div>
                      <label className="flex items-center gap-2 text-xs font-medium mb-1">
                        <input type="checkbox" checked={userForm.waEnabled} data-testid="toggle-wa-restriction"
                          onChange={(e) => setUserForm({ ...userForm, waEnabled: e.target.checked })} />
                        Restringir a linhas de WhatsApp específicas
                      </label>
                      {userForm.waEnabled && (
                        <div className="space-y-2 mt-1.5 p-2.5 rounded-xl bg-secondary/50 border border-border">
                          <div className="flex flex-wrap gap-1.5">
                            {waSessions.map((s) => (
                              <button type="button" key={s.sessionKey} data-testid={`toggle-wa-session-${s.sessionKey}`}
                                onClick={() => setUserForm({ ...userForm, waKeys: userForm.waKeys.includes(s.sessionKey) ? userForm.waKeys.filter((k) => k !== s.sessionKey) : [...userForm.waKeys, s.sessionKey] })}
                                className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${userForm.waKeys.includes(s.sessionKey) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground bg-white hover:bg-secondary"}`}>
                                {s.displayName || s.sessionKey}
                              </button>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">Esse vendedor só vê e responde conversas dessas linhas de WhatsApp. Nenhuma marcada = não vê conversa nenhuma.</p>
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                  )}
                </div>
              )}

              {/* Permissões (não-admin) */}
              {userForm.role !== "admin" && (
                <div className="pt-3 border-t border-border">
                  <button type="button" onClick={() => toggleUserSection("permissoes")} data-testid="usersection-toggle-permissoes"
                    className="flex items-center gap-2 w-full py-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground hover:text-foreground transition">
                    <span className="flex-1 text-left">Permissões</span>
                    <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${openUserSections.has("permissoes") ? "" : "-rotate-90"}`} />
                  </button>
                  {openUserSections.has("permissoes") && (
                  <div className="space-y-3 mt-2">
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <input type="checkbox" checked={userForm.adminAccess.includes("whatsapp")} data-testid="toggle-admin-access-whatsapp"
                        onChange={(e) => setUserForm({ ...userForm, adminAccess: e.target.checked ? ["whatsapp"] : [] })} />
                      Gerenciar conexão do WhatsApp
                    </label>
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block">Módulos e nível de acesso</label>
                    <p className="text-[10px] text-muted-foreground mb-2">Só os módulos que a loja já contratou aparecem aqui. Sem marcar, o usuário não vê a aba.</p>
                    <div className="space-y-1">
                      {USER_GRANTABLE_MODULES.filter((m) => user?.enabledModules == null || user.enabledModules.includes(m)).map((m) => {
                        const level = userForm.moduleAccess[m];
                        const setLevel = (v: "view" | "edit" | undefined) => {
                          const next = { ...userForm.moduleAccess };
                          if (v) next[m] = v; else delete next[m];
                          setUserForm({ ...userForm, moduleAccess: next });
                        };
                        return (
                          <div key={m} className="flex items-center justify-between gap-2 py-1">
                            <span className="text-xs text-foreground">{MODULE_LABELS[m]}</span>
                            <div className="flex gap-1 shrink-0">
                              {([[undefined, "Sem acesso"], ["view", "Visualizar"], ["edit", "Ver + editar"]] as const).map(([v, label]) => (
                                <button type="button" key={label} data-testid={`module-access-${m}-${v ?? "none"}`}
                                  onClick={() => setLevel(v)}
                                  className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${(level ?? undefined) === v ? "bg-primary text-white border-primary" : "border-border text-muted-foreground bg-white hover:bg-secondary"}`}>
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  </div>
                  )}
                </div>
              )}

              {/* Outras informações */}
              <div className="pt-3 border-t border-border">
                <button type="button" onClick={() => toggleUserSection("outras")} data-testid="usersection-toggle-outras"
                  className="flex items-center gap-2 w-full py-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground hover:text-foreground transition">
                  <span className="flex-1 text-left">Outras informações</span>
                  <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${openUserSections.has("outras") ? "" : "-rotate-90"}`} />
                </button>
                {openUserSections.has("outras") && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Loja (para redes de lojas)</label>
                  <select value={userForm.storeName} onChange={(e) => setUserForm({ ...userForm, storeName: e.target.value })}
                    data-testid="select-user-store"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">Sem loja</option>
                    {stores.filter((s) => s.isActive || s.name === userForm.storeName).map((s) => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                    {userForm.storeName && !stores.some((s) => s.name === userForm.storeName) && (
                      <option value={userForm.storeName}>{userForm.storeName}</option>
                    )}
                  </select>
                  <p className="text-[10px] text-muted-foreground mt-1">Cadastre as lojas na aba Setores → Lojas da Rede.</p>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Ramal (opcional)</label>
                  <input value={userForm.extension} onChange={(e) => setUserForm({ ...userForm, extension: e.target.value })}
                    placeholder="Ex.: 1042" maxLength={20} data-testid="input-user-extension"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  <p className="text-[10px] text-muted-foreground mt-1">Aparece no Diretório interno de contatos.</p>
                </div>
                </div>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAddUser(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">Cancelar</button>
                <button type="submit" data-testid="button-confirm-save-user"
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition">
                  {editUser ? "Salvar" : "Criar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== SECTOR MODAL ===== */}
      {showAddSector && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editSector ? "Editar Setor" : "Novo Setor"}</h3>
              <button onClick={() => setShowAddSector(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSaveSector} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome *</label>
                <input required placeholder="Ex: Pós-venda" value={sectorForm.name}
                  onChange={(e) => setSectorForm({ ...sectorForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Descrição</label>
                <input placeholder="Descrição curta" value={sectorForm.description}
                  onChange={(e) => setSectorForm({ ...sectorForm, description: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Ícone</label>
                <select value={sectorForm.icon} onChange={(e) => setSectorForm({ ...sectorForm, icon: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  {ICONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Cor</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={sectorForm.color}
                    onChange={(e) => setSectorForm({ ...sectorForm, color: e.target.value })}
                    className="w-10 h-10 rounded-xl border border-border cursor-pointer" />
                  <span className="text-sm text-muted-foreground">{sectorForm.color}</span>
                </div>
              </div>
              {editSector && (
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="sectorActive" checked={sectorForm.isActive}
                    onChange={(e) => setSectorForm({ ...sectorForm, isActive: e.target.checked })}
                    className="w-4 h-4 rounded" />
                  <label htmlFor="sectorActive" className="text-sm font-medium">Setor ativo</label>
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAddSector(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">Cancelar</button>
                <button type="submit" data-testid="button-confirm-save-sector"
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition">
                  {editSector ? "Salvar" : "Criar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Barra de navegação inferior — somente celular */}
      {showMoreNav && (
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setShowMoreNav(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="absolute bottom-0 inset-x-0 bg-white rounded-t-2xl border-t border-border p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-xs font-semibold text-muted-foreground mb-3">Mais opções</p>
            <div className="grid grid-cols-3 gap-2">
              {mobileMoreTabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => { setTab(id); setShowMoreNav(false); }}
                  data-testid={`bottomnav-more-${id}`}
                  className={`relative flex flex-col items-center justify-center gap-1 py-3 rounded-xl text-[11px] font-semibold transition ${
                    tab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  <span className="relative">
                    <Icon className="w-5 h-5" />
                    {id === "equipe" && internalChatUnread > 0 && (
                      <span className="absolute -top-1.5 -right-2.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none flex items-center justify-center">
                        {internalChatUnread > 99 ? "99+" : internalChatUnread}
                      </span>
                    )}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-border flex items-stretch h-[calc(3.5rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]">
        {mobilePrimaryTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { setTab(id); setShowMoreNav(false); }}
            data-testid={`bottomnav-${id}`}
            className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition ${
              tab === id && !showMoreNav ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <span className="relative">
              <Icon className="w-5 h-5" />
              {id === "equipe" && internalChatUnread > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none flex items-center justify-center" data-testid="badge-internal-chat-unread-mobile">
                  {internalChatUnread > 99 ? "99+" : internalChatUnread}
                </span>
              )}
            </span>
            {label}
          </button>
        ))}
        {mobileMoreTabs.length > 0 && (
          <button
            onClick={() => setShowMoreNav((v) => !v)}
            data-testid="bottomnav-more"
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition ${
              showMoreNav || mobileMoreTabs.some((t) => t.id === tab) ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <MoreHorizontal className="w-5 h-5" />
            Mais
          </button>
        )}
      </nav>
    </div>
  );
}
