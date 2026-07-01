import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, type SectorSummary, type AttendanceLog, type Sector } from "@/lib/api";
import { SectorIcon } from "@/components/SectorIcon";
import { ChannelBadge } from "@/components/ChannelBadge";
import { useToast } from "@/hooks/use-toast";
import CrmBoard from "./CrmBoard";
import ChatCenter from "./ChatCenter";
import InternalChat from "./InternalChat";
import DistribuicaoPanel from "./DistribuicaoPanel";
import {
  Smartphone, LogOut, LayoutDashboard, ClipboardList,
  Settings, Users, RefreshCw, Plus, X, Clock, CheckCircle,
  PhoneCall, TrendingUp, Pencil, Kanban, MessageCircle, GitFork, MessagesSquare
} from "lucide-react";

type Tab = "dashboard" | "chat" | "equipe" | "distribuicao" | "crm" | "history" | "users" | "sectors" | "whatsapp";

type WAStatus = {
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
  const [waStatus, setWaStatus] = useState<WAStatus>({ mode: null, status: "unknown", phoneNumber: null, phoneId: null, qrDataUrl: null, lastHeartbeatAt: null, errorMessage: null, bridgeAvailable: false });
  const [waLoading, setWaLoading] = useState(false);

  // Modals
  const [showAddUser, setShowAddUser] = useState(false);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [showAddSector, setShowAddSector] = useState(false);
  const [editSector, setEditSector] = useState<Sector | null>(null);

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
      const r = await fetch("/api/whatsapp/status", { credentials: "include" });
      if (r.ok) setWaStatus(await r.json() as WAStatus);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchAll();
    if (user?.role === "admin") fetchUsersAndSectors();
    fetchWAStatus();
    const iv = setInterval(fetchAll, 8000);
    return () => clearInterval(iv);
  }, [fetchAll, fetchUsersAndSectors, fetchWAStatus, user?.role]);

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

  const allTabs = [
    { id: "dashboard" as Tab, label: "Visão Geral", icon: LayoutDashboard, adminOnly: false },
    { id: "chat" as Tab, label: "Atendimento", icon: MessageCircle, adminOnly: false },
    { id: "equipe" as Tab, label: "Chat Interno", icon: MessagesSquare, adminOnly: false },
    { id: "distribuicao" as Tab, label: "Distribuição", icon: GitFork, adminOnly: false },
    { id: "crm" as Tab, label: "CRM", icon: Kanban, adminOnly: false },
    { id: "history" as Tab, label: "Histórico", icon: ClipboardList, adminOnly: false },
    { id: "users" as Tab, label: "Usuários", icon: Users, adminOnly: true },
    { id: "sectors" as Tab, label: "Setores", icon: Settings, adminOnly: true },
    { id: "whatsapp" as Tab, label: "WhatsApp", icon: PhoneCall, adminOnly: true },
  ];
  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);

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
        <aside className="w-52 shrink-0 border-r border-border bg-white sticky top-14 self-start h-[calc(100vh-3.5rem)] overflow-y-auto p-3">
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
        <div className="flex-1 min-w-0">
          <div className="max-w-5xl mx-auto px-4 py-6">

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

        {tab === "distribuicao" && <DistribuicaoPanel />}

        {tab === "crm" && <CrmBoard />}

        {/* === WHATSAPP TAB === */}
        {tab === "whatsapp" && (
          <div className="max-w-lg mx-auto space-y-6">
            {/* Status card */}
            <div className="shk-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-foreground">WhatsApp</h2>
                <div className="flex items-center gap-2">
                  {waStatus.status === "connected" && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                      Conectado
                    </span>
                  )}
                  {waStatus.status === "qr" && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
                      <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                      Aguardando QR
                    </span>
                  )}
                  {(waStatus.status === "connecting" || waStatus.status === "reconnecting") && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                      {waStatus.status === "reconnecting" ? "Reconectando…" : "Conectando…"}
                    </span>
                  )}
                  {(waStatus.status === "disconnected" || waStatus.status === "error") && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                      <span className="w-2 h-2 rounded-full bg-red-500" />
                      Desconectado
                    </span>
                  )}
                  {(waStatus.status === "unconfigured" || waStatus.status === "unknown") && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
                      <span className="w-2 h-2 rounded-full bg-gray-400" />
                      {waStatus.status === "unknown" ? "Verificando…" : "Não configurado"}
                    </span>
                  )}
                </div>
              </div>

              <div className="text-sm text-muted-foreground mb-4 space-y-1">
                {waStatus.phoneNumber && (
                  <p>Número: <span className="font-semibold text-foreground">+{waStatus.phoneNumber.replace(/^\+/, "")}</span></p>
                )}
                {waStatus.mode && (
                  <p className="text-xs">Modo: <span className="font-mono text-foreground">{waStatus.mode === "baileys" ? "Baileys (WebSocket)" : "Meta Cloud API"}</span></p>
                )}
                {waStatus.lastHeartbeatAt && (
                  <p className="text-xs text-muted-foreground">
                    Última conexão confirmada:{" "}
                    <span className="font-medium text-foreground">
                      {new Date(waStatus.lastHeartbeatAt).toLocaleString("pt-BR", {
                        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
                      })}
                    </span>
                  </p>
                )}
                {waStatus.errorMessage && (
                  <p className="text-xs text-red-600 mt-1">{waStatus.errorMessage}</p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button onClick={handleWARefresh} disabled={waLoading}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition text-sm disabled:opacity-50">
                  <RefreshCw className={`w-4 h-4 ${waLoading ? "animate-spin" : ""}`} />
                  Verificar status
                </button>
                {(waStatus.status === "disconnected" || waStatus.status === "error") && (
                  <button
                    onClick={async () => {
                      setWaLoading(true);
                      try {
                        await fetch("/api/whatsapp/reset", { method: "POST", credentials: "include" });
                        await fetchWAStatus();
                      } finally { setWaLoading(false); }
                    }}
                    disabled={waLoading}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition text-sm disabled:opacity-50">
                    <RefreshCw className="w-4 h-4" />
                    Reconectar / Novo QR
                  </button>
                )}
              </div>
            </div>

            {/* QR code panel */}
            {waStatus.status === "qr" && waStatus.qrDataUrl && (
              <div className="shk-card p-6 text-center">
                <p className="text-sm font-semibold text-foreground mb-4">
                  Escaneie o QR code com o WhatsApp
                </p>
                <img src={waStatus.qrDataUrl} alt="QR WhatsApp" className="mx-auto w-56 h-56 rounded-xl border border-border" />
                <p className="text-xs text-muted-foreground mt-3">
                  Abra o WhatsApp → Menu → <strong>Aparelhos conectados</strong> → <strong>Conectar um aparelho</strong>
                </p>
              </div>
            )}

            {/* QR waiting (no QR yet) */}
            {waStatus.status === "qr" && !waStatus.qrDataUrl && (
              <div className="shk-card p-6 text-center">
                <RefreshCw className="w-10 h-10 mx-auto text-blue-500 mb-3 animate-spin" />
                <p className="text-sm font-semibold text-foreground mb-1">Gerando QR code…</p>
                <p className="text-xs text-muted-foreground">Aguarde alguns segundos</p>
              </div>
            )}

            {/* Connected */}
            {waStatus.status === "connected" && (
              <div className="shk-card p-6 text-center">
                <CheckCircle className="w-10 h-10 mx-auto text-green-500 mb-3" />
                <p className="text-sm font-semibold text-foreground mb-1">WhatsApp conectado!</p>
                <p className="text-xs text-muted-foreground mb-4">
                  Sessão salva no banco de dados — reconexão automática após restart.<br />
                  Mensagens recebidas aparecem automaticamente no <strong>Atendimento</strong>.
                </p>
                <button
                  onClick={async () => {
                    if (!window.confirm("Desconectar este número? A sessão atual será encerrada e um novo QR code será gerado para conectar outro número.")) return;
                    setWaLoading(true);
                    try {
                      await fetch("/api/whatsapp/reset", { method: "POST", credentials: "include" });
                      await fetchWAStatus();
                    } finally { setWaLoading(false); }
                  }}
                  disabled={waLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition text-sm disabled:opacity-50">
                  <PhoneCall className="w-4 h-4" />
                  Desconectar / Trocar número
                </button>
              </div>
            )}

            {/* Reconnecting / Connecting */}
            {(waStatus.status === "connecting" || waStatus.status === "reconnecting") && (
              <div className="shk-card p-6 text-center border-amber-200 bg-amber-50">
                <RefreshCw className="w-10 h-10 mx-auto text-amber-500 mb-3 animate-spin" />
                <p className="text-sm font-semibold text-foreground mb-1">
                  {waStatus.status === "reconnecting" ? "Reconectando…" : "Conectando ao WhatsApp…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {waStatus.phoneNumber
                    ? <>Último número: <strong>+{waStatus.phoneNumber.replace(/^\+/, "")}</strong><br /></>
                    : null}
                  A reconexão é automática — aguarde ou clique em "Verificar status".
                </p>
              </div>
            )}

            {/* Disconnected / Error */}
            {(waStatus.status === "disconnected" || waStatus.status === "error") && (
              <div className="shk-card p-6 text-center border-red-200 bg-red-50">
                <PhoneCall className="w-10 h-10 mx-auto text-red-400 mb-3" />
                <p className="text-sm font-semibold text-foreground mb-1">Sessão encerrada</p>
                <p className="text-xs text-muted-foreground mb-3">
                  {waStatus.errorMessage ?? "A sessão foi encerrada ou expirou."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Clique em <strong>Reconectar / Novo QR</strong> para escanear o QR code novamente.
                </p>
              </div>
            )}

            {/* Not yet known */}
            {waStatus.status === "unknown" && (
              <div className="shk-card p-6 text-center">
                <RefreshCw className="w-10 h-10 mx-auto text-muted-foreground mb-3 animate-spin" />
                <p className="text-sm text-muted-foreground">Verificando status da conexão…</p>
              </div>
            )}

            {/* Info */}
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 text-xs text-blue-800">
              <strong>Sessão persistida no banco de dados</strong> — após escanear o QR uma vez, a sessão
              é salva automaticamente e o servidor reconecta sozinho após reinicializações. Nenhuma
              credencial de terceiros necessária.
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
                        {["Cliente", "Setor", "Atendente", "Canal", "Resultado", "Espera", "Atend.", "Hora"].map((h) => (
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
                          <button onClick={() => openEditUser(u)} data-testid={`button-edit-user-${u.id}`}
                            className="p-1.5 text-muted-foreground hover:text-primary hover:bg-blue-50 rounded-lg transition">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
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
    </div>
  );
}
