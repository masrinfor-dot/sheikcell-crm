import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { api, PERMISSION_KEYS, PERMISSION_LABELS, type SectorSummary, type AttendanceLog, type Sector, type QuickReply } from "@/lib/api";
import { SectorIcon } from "@/components/SectorIcon";
import { ChannelBadge } from "@/components/ChannelBadge";
import { useToast } from "@/hooks/use-toast";
import CrmBoard from "./CrmBoard";
import ChatCenter from "./ChatCenter";
import InternalChat from "./InternalChat";
import DistribuicaoPanel from "./DistribuicaoPanel";
import TaskBoard from "./TaskBoard";
import {
  Smartphone, LogOut, LayoutDashboard, ClipboardList,
  Settings, Users, RefreshCw, Plus, X, Clock, CheckCircle,
  PhoneCall, TrendingUp, Pencil, Kanban, MessageCircle, GitFork, MessagesSquare, ListTodo, MoreHorizontal, ShieldCheck, Zap, Trash2
} from "lucide-react";

type Tab = "dashboard" | "chat" | "equipe" | "tarefas" | "distribuicao" | "crm" | "history" | "users" | "sectors" | "whatsapp" | "quickreplies";

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
  isActive: boolean; sector: Sector | null; sectorId: number | null; createdAt: string;
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
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [summary, setSummary] = useState<SectorSummary[]>([]);
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [userRows, setUserRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [waSessions, setWaSessions] = useState<WASession[] | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [newConnName, setNewConnName] = useState("");

  // Modals
  const [showAddUser, setShowAddUser] = useState(false);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  // Modal de permissões individuais do vendedor
  const [permUser, setPermUser] = useState<UserRow | null>(null);
  const [permDraft, setPermDraft] = useState<Record<string, boolean>>({});
  const [savingPerms, setSavingPerms] = useState(false);
  const [showAddSector, setShowAddSector] = useState(false);
  const [editSector, setEditSector] = useState<Sector | null>(null);

  // Exclusão de usuário com transferência dos atendimentos dele.
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const [deleteTransferTo, setDeleteTransferTo] = useState("");
  const [deletingUser, setDeletingUser] = useState(false);

  const [userForm, setUserForm] = useState({ name: "", email: "", password: "", role: "vendedor", sectorId: 1 });
  const [sectorForm, setSectorForm] = useState({ name: "", description: "", icon: "smartphone", color: "#1a2e6e", isActive: true });

  const fetchAll = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api.admin.summary(), api.admin.logs({ limit: 40 })]);
      setSummary(s);
      setLogs(l);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  const fetchUsersAndSectors = useCallback(async () => {
    try {
      const [u, sec] = await Promise.all([api.admin.users.list(), api.sectors.listAll()]);
      setUserRows(u as UserRow[]);
      setSectors(sec);
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
    const es = new EventSource("/api/chat/events", { withCredentials: true });
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
      es.close();
      if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [fetchAll]);

  useEffect(() => {
    if (tab !== "whatsapp") return;
    fetchWAStatus();
    const iv = setInterval(fetchWAStatus, 2500);
    return () => clearInterval(iv);
  }, [tab, fetchWAStatus]);

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
    setUserForm({ name: "", email: "", password: "", role: "vendedor", sectorId: sectors[0]?.id ?? 1 });
    setShowAddUser(true);
  };
  const openEditUser = (u: UserRow) => {
    setEditUser(u);
    setUserForm({ name: u.name, email: u.email, password: "", role: u.role, sectorId: u.sectorId ?? 1 });
    setShowAddUser(true);
  };
  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editUser) {
        const payload: Parameters<typeof api.admin.users.update>[1] = {
          name: userForm.name, email: userForm.email, role: userForm.role, sectorId: userForm.sectorId,
        };
        if (userForm.password) payload.password = userForm.password;
        await api.admin.users.update(editUser.id, payload);
        toast({ title: "Atendente atualizado!" });
      } else {
        await api.admin.users.create({ ...userForm });
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
    { id: "chat" as Tab, label: "Atendimento", icon: MessageCircle, adminOnly: false },
    { id: "equipe" as Tab, label: "Chat Interno", icon: MessagesSquare, adminOnly: false },
    { id: "tarefas" as Tab, label: "Tarefas", icon: ListTodo, adminOnly: false },
    { id: "distribuicao" as Tab, label: "Distribuição", icon: GitFork, adminOnly: false },
    { id: "crm" as Tab, label: "CRM", icon: Kanban, adminOnly: false },
    { id: "history" as Tab, label: "Histórico", icon: ClipboardList, adminOnly: false },
    { id: "users" as Tab, label: "Usuários", icon: Users, adminOnly: true },
    { id: "sectors" as Tab, label: "Setores", icon: Settings, adminOnly: true },
    { id: "quickreplies" as Tab, label: "Msgs Rápidas", icon: Zap, adminOnly: true },
    { id: "whatsapp" as Tab, label: "WhatsApp", icon: PhoneCall, adminOnly: true },
  ];
  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);
  // Celular: 4 abas principais + "Mais" (painel com o restante)
  const mobilePrimaryTabs = tabs.slice(0, 4);
  const mobileMoreTabs = tabs.slice(4);

  return (
    <div className="min-h-screen bg-background">
      {/* Navbar */}
      <nav className="bg-white border-b border-border sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center">
              <Smartphone className="w-4 h-4 text-white" />
            </div>
            <span className="font-extrabold text-foreground text-sm">Sheikcell</span>
            <span className="text-xs text-muted-foreground ml-1 hidden sm:block">
              {isAdmin ? "— Administrador" : isSupervisor ? "— Supervisor" : ""}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:block">{user?.name}</span>
            <button onClick={() => logout()} data-testid="button-logout"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition">
              <LogOut className="w-3.5 h-3.5" /> Sair
            </button>
          </div>
        </div>
      </nav>

      {/* Left sidebar + content */}
      <div className="flex">
        {/* Sidebar tabs */}
        <aside className="hidden md:block w-52 shrink-0 border-r border-border bg-white sticky top-14 self-start h-[calc(100vh-3.5rem)] overflow-y-auto p-3">
          <div className="flex flex-col gap-1">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setTab(id)} data-testid={`tab-${id}`}
                className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-colors ${
                  tab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}>
                <Icon className="w-4 h-4 shrink-0" />{label}
              </button>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
          {/* O chat ocupa a largura toda; as demais abas ficam na coluna central */}
          <div className={tab === "chat" ? "max-w-full px-0 py-0 md:px-4 md:py-4" : "max-w-5xl mx-auto px-4 py-6"}>

        {/* === DASHBOARD TAB === */}
        {tab === "dashboard" && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Aguardando", value: totalWaiting, icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
                { label: "Em Atendimento", value: totalInProgress, icon: PhoneCall, color: "text-blue-600", bg: "bg-blue-50" },
                { label: "Finalizados Hoje", value: totalDone, icon: TrendingUp, color: "text-green-600", bg: "bg-green-50" },
              ].map(({ label, value, icon: Icon, color, bg }) => (
                <div key={label} className={`shk-card p-5 text-center ${bg}`}>
                  <Icon className={`w-6 h-6 mx-auto mb-1 ${color}`} />
                  <div className={`text-3xl font-extrabold ${color}`}>{loading ? "—" : value}</div>
                  <div className="text-xs text-muted-foreground font-medium mt-0.5">{label}</div>
                </div>
              ))}
            </div>

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
        {tab === "chat" && <ChatCenter />}

        {tab === "equipe" && <InternalChat />}

        {tab === "tarefas" && <TaskBoard />}

        {tab === "distribuicao" && <DistribuicaoPanel />}

        {tab === "crm" && <CrmBoard />}

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
                  {s.sessionKey !== "default" && (
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Remover a conexão "${s.displayName ?? s.sessionKey}"? As conversas dela passam a responder pela conexão principal.`)) return;
                        setWaLoading(true);
                        try {
                          const r = await fetch(`/api/whatsapp/sessions/${s.sessionKey}`, { method: "DELETE", credentials: "include" });
                          if (!r.ok) {
                            const d = await r.json().catch(() => null) as { error?: string } | null;
                            toast({ title: "Erro", description: d?.error ?? "Erro ao remover", variant: "destructive" });
                          } else {
                            toast({ title: "Conexão removida" });
                          }
                          await fetchWAStatus();
                        } finally { setWaLoading(false); }
                      }}
                      disabled={waLoading}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition text-sm disabled:opacity-50">
                      <X className="w-4 h-4" />
                      Remover
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
              <button onClick={() => api.admin.logs({ limit: 40 }).then(setLogs)}
                className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            {logs.length === 0 ? (
              <div className="shk-card p-10 text-center">
                <CheckCircle className="w-10 h-10 mx-auto text-muted-foreground mb-2" />
                <p className="text-muted-foreground text-sm">Nenhum atendimento registrado ainda</p>
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
                      {["Nome", "Email", "Setor", "Perfil", "Status", ""].map((h, i) => (
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
                            {u.id !== user?.id && (
                              <button onClick={() => { setDeleteUser(u); setDeleteTransferTo(""); }}
                                data-testid={`button-delete-user-${u.id}`} title="Excluir usuário"
                                className="p-1.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 rounded-lg transition">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {u.role === "vendedor" && (
                              <button
                                onClick={() => {
                                  const draft: Record<string, boolean> = {};
                                  for (const k of PERMISSION_KEYS) draft[k] = u.permissions?.[k] !== false;
                                  setPermDraft(draft);
                                  setPermUser(u);
                                }}
                                data-testid={`button-perms-user-${u.id}`}
                                title="Permissões do vendedor"
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
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editUser ? "Editar Usuário" : "Novo Usuário"}</h3>
              <button onClick={() => setShowAddUser(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSaveUser} className="space-y-3">
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
              <div>
                <label className="text-xs font-medium mb-1 block">{editUser ? "Nova senha (deixe em branco para manter)" : "Senha *"}</label>
                <input type="password" placeholder="••••••••" required={!editUser} value={userForm.password}
                  onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
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
                  className={`flex flex-col items-center justify-center gap-1 py-3 rounded-xl text-[11px] font-semibold transition ${
                    tab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  <Icon className="w-5 h-5" />
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
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition ${
              tab === id && !showMoreNav ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <Icon className="w-5 h-5" />
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
