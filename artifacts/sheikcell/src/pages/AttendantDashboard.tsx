import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, type QueueEntry, type Sector, type OptionalModule } from "@/lib/api";
import { SectorIcon } from "@/components/SectorIcon";
import { ChannelBadge } from "@/components/ChannelBadge";
import { useToast } from "@/hooks/use-toast";
import { useInternalChatNotifier } from "@/hooks/useInternalChatNotifier";
import CrmBoard from "./CrmBoard";
import ChatCenter from "./ChatCenter";
import InternalChat from "./InternalChat";
import { useChatExpandListener, setAtendimentoTabVisible } from "@/lib/chatWidgetBus";
import TaskBoard from "./TaskBoard";
import Financeiras from "./Financeiras";
import Avaliacao from "./Avaliacao";
import VitrineAparelhos from "./VitrineAparelhos";
import TvBox from "./TvBox";
import PontoGate from "@/components/PontoGate";
import ChangePasswordModal from "@/components/ChangePasswordModal";
import BrandLogo from "@/components/BrandLogo";
import Financeiro from "./Financeiro";
import Sorteios from "./Sorteios";
import Robo from "./Robo";
import RH from "./RH";
import MeuPonto from "./MeuPonto";
import TrainingGate from "@/components/TrainingGate";
import RoutineChecklistGate from "@/components/RoutineChecklistGate";
import Treinamentos from "./Treinamentos";
import Documentos from "./Documentos";
import {
  LogOut, KeyRound, Clock, PhoneCall, CheckCircle,
  ArrowRightLeft, UserPlus, X, RefreshCw, Users, Kanban, MessageCircle, MessagesSquare, ListTodo, Landmark, BadgeDollarSign, GraduationCap, Gift, Bot, UserSearch, ClipboardList, TrendingUp,
  FolderArchive, BookUser, LifeBuoy, Tv, Smartphone, ChevronsRight, ChevronsLeft,
} from "lucide-react";
import Resultados from "./Resultados";
import TeamDirectory from "./TeamDirectory";
import Suporte from "./Suporte";

type MainTab = "queue" | "resultados" | "chat" | "crm" | "tarefas" | "equipe" | "financeiras" | "avaliacao" | "vitrine" | "treinamentos" | "documentos" | "financeiro" | "sorteios" | "robo" | "rh" | "meuponto" | "diretorio" | "suporte" | "tvbox";

// Todas as abas que dependem de módulo — visibilidade decidida por
// moduleGranted() (loja contratou E usuário tem acesso), ver mais abaixo.
// "Suporte" é a única sem módulo, sempre visível.
const MAIN_TABS: { id: MainTab; label: string; icon: typeof PhoneCall; module?: OptionalModule }[] = [
  { id: "queue" as MainTab, label: "Fila", icon: PhoneCall, module: "chat" },
  { id: "chat" as MainTab, label: "Atendimento", icon: MessageCircle, module: "chat" },
  { id: "tarefas" as MainTab, label: "Tarefas", icon: ListTodo, module: "tarefas" },
  { id: "resultados" as MainTab, label: "Resultados", icon: TrendingUp, module: "resultados" },
  { id: "crm" as MainTab, label: "CRM", icon: Kanban, module: "crm" },
  { id: "financeiras" as MainTab, label: "Financeiras", icon: Landmark, module: "financeiras" },
  { id: "avaliacao" as MainTab, label: "Avaliação", icon: BadgeDollarSign, module: "avaliacao" },
  { id: "vitrine" as MainTab, label: "Vitrine Aparelhos", icon: Smartphone, module: "vitrine" },
  { id: "tvbox" as MainTab, label: "TV Box", icon: Tv, module: "tvbox" },
  { id: "treinamentos" as MainTab, label: "Treinamentos", icon: GraduationCap, module: "treinamentos" },
  { id: "documentos" as MainTab, label: "Documentos", icon: FolderArchive, module: "documentos" },
  { id: "diretorio" as MainTab, label: "Diretório", icon: BookUser, module: "diretorio" },
  { id: "financeiro" as MainTab, label: "Financeiro", icon: BadgeDollarSign, module: "financeiro" },
  { id: "sorteios" as MainTab, label: "Sorteios", icon: Gift, module: "sorteios" },
  { id: "robo" as MainTab, label: "Robô", icon: Bot, module: "robo" },
  { id: "rh" as MainTab, label: "RH", icon: UserSearch, module: "rh" },
  { id: "meuponto" as MainTab, label: "Meu Ponto", icon: Clock },
  { id: "suporte" as MainTab, label: "Suporte", icon: LifeBuoy },
];

function formatWait(createdAt: string): string {
  const diff = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}min`;
}

export default function AttendantDashboard() {
  const { user, logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const { toast } = useToast();

  const [mainTab, setMainTab] = useState<MainTab>("queue");

  // Menu lateral minimizável: encolhe pra uma barra só de ícones quando o
  // mouse não está em cima, expande de volta ao passar o mouse — economiza
  // espaço de tela sem esconder a navegação de vez.
  const [sidebarHovered, setSidebarHovered] = useState(false);

  // Some/aparece o balão flutuante global (GlobalChatWidget) conforme a aba
  // Atendimento fica visível ou não — evita o botão dele ficar em cima do
  // botão de enviar do composer, que também encosta no canto direito aqui.
  useEffect(() => {
    setAtendimentoTabVisible(mainTab === "chat" || mainTab === "equipe");
    return () => setAtendimentoTabVisible(false);
  }, [mainTab]);
  const enabledModules = user?.enabledModules ?? null;
  const userModuleAccess = user?.moduleAccess ?? null;
  // Módulos que o SETOR deste vendedor pode ver (item 1h do backlog) — uma
  // restrição a mais, por cima da loja. null = sem restrição (setor de
  // sempre, comportamento inalterado).
  const sectorModules = user?.sector?.enabledModules ?? null;
  // Loja precisa ter contratado o módulo E o setor precisa permitir.
  // Atendimento é o único módulo com default liberado (ausência de config
  // = acesso) — só bloqueia se um admin restringiu explicitamente com
  // "none", ou se o setor não inclui "chat"; os demais exigem grant.
  const moduleGranted = (m: OptionalModule | undefined): boolean => {
    if (!m) return true;
    if (enabledModules != null && !enabledModules.includes(m)) return false;
    if (sectorModules != null && !sectorModules.includes(m)) return false;
    if (m === "chat") return userModuleAccess?.chat !== "none";
    return userModuleAccess != null && m in userModuleAccess;
  };
  // No desktop (md+) o chat interno fica sempre visível numa coluna lateral
  // (ver <InternalChat docked /> abaixo), então nunca é "invisível" lá — só
  // no celular ele soma/some conforme a aba "Equipe" está aberta ou não.
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const h = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  const internalChatUnread = useInternalChatNotifier(user?.id, isDesktop || mainTab === "equipe", moduleGranted("equipe"));
  // Minimizar a coluna do Chat Interno (só desktop) -- pedido explícito do
  // cliente, a coluna "sempre aberta" tomava espaço da tela de Atendimento.
  // Só esconde por CSS (nunca desmonta o InternalChat), senão o contador de
  // não lidas para de atualizar com a coluna minimizada (ver comentário
  // acima sobre isDesktop no useInternalChatNotifier). Lembra a preferência
  // entre sessões.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sheikcell.internalChatSidebarCollapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("sheikcell.internalChatSidebarCollapsed", sidebarCollapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // Alarme de sem resposta clicado em outra aba → volta para o chat.
  useEffect(() => {
    const h = () => setMainTab("chat");
    window.addEventListener("sheikcell:open-chat", h);
    return () => window.removeEventListener("sheikcell:open-chat", h);
  }, []);

  // "Expandir" no widget flutuante global: foca a mesma conversa aqui.
  const [focusConversationId, setFocusConversationId] = useState<number | null>(null);
  const [focusRequestId, setFocusRequestId] = useState(0);
  // Veio do botão "ir para o atendimento" do CRM? Se sim, mostra um botão
  // "Voltar ao CRM" na conversa aberta (ver ChatCenter onBackToCrm).
  const [focusFromCrm, setFocusFromCrm] = useState(false);
  const [focusInternalConversationId, setFocusInternalConversationId] = useState<number | null>(null);
  const [focusInternalRequestId, setFocusInternalRequestId] = useState(0);
  useChatExpandListener(useCallback((req) => {
    if (req.module === "atendimento") {
      setMainTab("chat");
      setFocusConversationId(req.conversationId);
      setFocusRequestId(req.requestId);
      setFocusFromCrm(req.origin === "crm");
    } else {
      setMainTab("equipe");
      setFocusInternalConversationId(req.conversationId);
      // Força remontar o InternalChat (no desktop ele fica sempre montado
      // na coluna lateral, senão o initialConversationId não pegaria de novo).
      setFocusInternalRequestId(req.requestId);
    }
  }, []));
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showTransfer, setShowTransfer] = useState<number | null>(null);
  const [addForm, setAddForm] = useState({ clientName: "", clientContact: "", channel: "manual", notes: "" });
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const sectorId = user?.sectorId ?? 0;
  const sectorInfo = user?.sector;

  const fetchQueue = useCallback(async () => {
    try {
      const data = await api.queue.list({ sectorId });
      setQueue(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [sectorId]);

  useEffect(() => {
    fetchQueue();
    api.sectors.list().then(setSectors).catch(() => {});
    const interval = setInterval(fetchQueue, 5000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const waiting = queue.filter((q) => q.status === "waiting");
  const inProgress = queue.filter((q) => q.status === "in_progress");

  const handleCall = async (id: number) => {
    setActionLoading(id);
    try {
      await api.queue.call(id);
      toast({ title: "Cliente chamado!", description: "Atendimento iniciado." });
      fetchQueue();
    } catch (e: unknown) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Erro ao chamar", variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleComplete = async (id: number) => {
    setActionLoading(id);
    try {
      await api.queue.complete(id);
      toast({ title: "Atendimento finalizado!", description: "Registrado com sucesso." });
      fetchQueue();
    } catch (e: unknown) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Erro ao finalizar", variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemove = async (id: number) => {
    setActionLoading(id);
    try {
      await api.queue.remove(id);
      toast({ title: "Removido da fila" });
      fetchQueue();
    } catch {
      toast({ title: "Erro ao remover", variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleTransfer = async (id: number, targetSectorId: number) => {
    setActionLoading(id);
    try {
      await api.queue.transfer(id, targetSectorId);
      toast({ title: "Transferido com sucesso!" });
      setShowTransfer(null);
      fetchQueue();
    } catch (e: unknown) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Erro ao transferir", variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.queue.add({ ...addForm, sectorId });
      toast({ title: "Cliente adicionado à fila!" });
      setShowAdd(false);
      setAddForm({ clientName: "", clientContact: "", channel: "manual", notes: "" });
      fetchQueue();
    } catch (e: unknown) {
      toast({ title: "Erro", description: e instanceof Error ? e.message : "Erro", variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <PontoGate />
      <TrainingGate />
      <RoutineChecklistGate />
      {/* Navbar */}
      <nav className="bg-white border-b border-border sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <BrandLogo />
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-1.5">
              {sectorInfo && (
                <span
                  className="text-xs font-semibold px-3 py-1 rounded-full text-white"
                  style={{ backgroundColor: sectorInfo.color }}
                  data-testid="badge-sector"
                >
                  <SectorIcon icon={sectorInfo.icon} className="inline w-3 h-3 mr-1" />
                  {sectorInfo.name}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{user?.name}</span>
            </div>
            <button onClick={() => setShowChangePassword(true)} data-testid="button-change-password"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition">
              <KeyRound className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Trocar senha</span>
            </button>
            <button
              onClick={() => logout()}
              data-testid="button-logout"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sair
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
            {/* Vendedor sendo "espiado" por um admin da própria loja — texto
                diferente do "Entrar como" do superadmin (que não aparece aqui,
                já que só admin/supervisor caem no AdminDashboard). */}
            {user.impersonatedBy.role === "superadmin" ? "Voltar ao Painel do Sistema" : "Sair do modo espiar"}
          </button>
        </div>
      )}

      {showChangePassword && (
        <ChangePasswordModal onDone={() => { setShowChangePassword(false); toast({ title: "Senha alterada com sucesso!" }); }}
          onClose={() => setShowChangePassword(false)} />
      )}

      {/* Left sidebar + content */}
      <div className="flex">
        {/* Sidebar tabs */}
        <aside
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
          data-testid="sidebar-attendant"
          className={`hidden md:block ${sidebarHovered ? "w-52" : "w-14"} shrink-0 overflow-x-hidden border-r border-border bg-white sticky top-14 self-start h-[calc(100vh-3.5rem)] overflow-y-auto p-3 transition-[width] duration-200 ease-in-out`}
        >
          <div className="flex flex-col gap-1">
            {MAIN_TABS.filter(({ module }) => moduleGranted(module)).map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setMainTab(id)} title={sidebarHovered ? undefined : label}
                className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-colors whitespace-nowrap ${
                  mainTab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}>
                <Icon className="w-4 h-4 shrink-0" />{sidebarHovered && <span className="truncate">{label}</span>}
              </button>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">

      {/* ChatCenter fica SEMPRE montado (escondido nas outras abas) para o
          alarme de mensagem sem resposta tocar e aparecer em qualquer tela. */}
      <div className={mainTab === "chat" ? "max-w-full px-0 py-0 md:px-4 md:py-4" : "hidden"}>
        <ChatCenter
          focusConversationId={focusConversationId}
          focusRequestId={focusRequestId}
          onBackToCrm={focusFromCrm ? () => { setFocusFromCrm(false); setMainTab("crm"); } : undefined}
        />
      </div>

      {mainTab === "equipe" && moduleGranted("equipe") && (
        <div className="md:hidden h-[calc(var(--vvh,100dvh)-7rem-env(safe-area-inset-bottom))] flex flex-col bg-card">
          <InternalChat key={focusInternalRequestId} docked initialConversationId={focusInternalConversationId} />
        </div>
      )}

      {mainTab === "tarefas" && (
        <div className="max-w-5xl mx-auto px-4 py-6">
          <TaskBoard />
        </div>
      )}

      {mainTab === "resultados" && (
        <div className="max-w-5xl mx-auto px-4 py-6">
          <Resultados />
        </div>
      )}

      {/* Abas de módulo liberadas por usuário (moduleAccess) */}
      {mainTab === "financeiro" && moduleGranted("financeiro") && (
        <div className="max-w-6xl mx-auto px-4 py-6"><Financeiro /></div>
      )}
      {mainTab === "sorteios" && moduleGranted("sorteios") && (
        <div className="max-w-5xl mx-auto px-4 py-6"><Sorteios /></div>
      )}
      {mainTab === "robo" && moduleGranted("robo") && (
        <div className="max-w-6xl mx-auto px-4 py-6"><Robo /></div>
      )}
      {mainTab === "rh" && moduleGranted("rh") && (
        <div className="max-w-6xl mx-auto px-4 py-6"><RH /></div>
      )}
      {mainTab === "meuponto" && <MeuPonto />}

      {mainTab === "treinamentos" && (
        <div className="max-w-3xl mx-auto px-4 py-6">
          <Treinamentos />
        </div>
      )}

      {mainTab === "documentos" && <Documentos />}

      {mainTab === "diretorio" && (
        <div className="max-w-5xl mx-auto px-4 py-6">
          <TeamDirectory />
        </div>
      )}

      {mainTab === "suporte" && (
        <div className="max-w-5xl mx-auto px-4 py-6">
          <Suporte />
        </div>
      )}

      {mainTab === "avaliacao" && (
        <div className="max-w-3xl mx-auto px-4 py-6">
          <Avaliacao />
        </div>
      )}

      {mainTab === "vitrine" && <VitrineAparelhos />}


      {mainTab === "financeiras" && (
        <div className="max-w-6xl mx-auto px-2 md:px-4 py-3 md:py-4">
          <Financeiras />
        </div>
      )}

      {mainTab === "tvbox" && (
        <div className="max-w-6xl mx-auto px-2 md:px-4 py-3 md:py-4">
          <TvBox />
        </div>
      )}

      {mainTab === "crm" && (
        <div className="max-w-3xl mx-auto px-4 py-6">
          <CrmBoard />
        </div>
      )}

      {mainTab === "queue" && <><div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Aguardando", value: waiting.length, icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
            { label: "Em Atendimento", value: inProgress.length, icon: PhoneCall, color: "text-blue-600", bg: "bg-blue-50" },
            { label: "Total na Fila", value: queue.length, icon: Users, color: "text-primary", bg: "bg-blue-50/50" },
          ].map(({ label, value, icon: Icon, color, bg }) => (
            <div key={label} className={`shk-card p-4 text-center ${bg}`}>
              <Icon className={`w-5 h-5 mx-auto mb-1 ${color}`} />
              <div className={`text-2xl font-extrabold ${color}`}>{value}</div>
              <div className="text-xs text-muted-foreground font-medium">{label}</div>
            </div>
          ))}
        </div>

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-foreground">
            Fila — {sectorInfo?.name ?? "Meu Setor"}
          </h2>
          <div className="flex items-center gap-2">
            <button onClick={fetchQueue} className="p-2 rounded-xl text-muted-foreground hover:bg-secondary transition">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowAdd(true)}
              data-testid="button-add-client"
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Adicionar
            </button>
          </div>
        </div>

        {/* In progress first */}
        {inProgress.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-blue-600 mb-2 uppercase tracking-wide">Em Atendimento</p>
            <div className="space-y-3">
              {inProgress.map((entry) => (
                <QueueCard
                  key={entry.id}
                  entry={entry}
                  sectors={sectors.filter((s) => s.id !== sectorId)}
                  onComplete={handleComplete}
                  onTransfer={handleTransfer}
                  onRemove={handleRemove}
                  showTransfer={showTransfer}
                  setShowTransfer={setShowTransfer}
                  actionLoading={actionLoading}
                  variant="in_progress"
                />
              ))}
            </div>
          </div>
        )}

        {/* Waiting queue */}
        <div>
          <p className="text-xs font-semibold text-amber-600 mb-2 uppercase tracking-wide">Aguardando</p>
          {loading ? (
            <div className="shk-card p-8 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : waiting.length === 0 ? (
            <div className="shk-card p-8 text-center">
              <CheckCircle className="w-8 h-8 mx-auto text-green-400 mb-2" />
              <p className="text-sm text-muted-foreground font-medium">Nenhum cliente aguardando</p>
              <p className="text-xs text-muted-foreground mt-1">A fila está vazia 🎉</p>
            </div>
          ) : (
            <div className="space-y-3">
              {waiting.map((entry, idx) => (
                <QueueCard
                  key={entry.id}
                  entry={entry}
                  sectors={sectors.filter((s) => s.id !== sectorId)}
                  position={idx + 1}
                  onCall={handleCall}
                  onRemove={handleRemove}
                  onTransfer={handleTransfer}
                  showTransfer={showTransfer}
                  setShowTransfer={setShowTransfer}
                  actionLoading={actionLoading}
                  variant="waiting"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add client modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-foreground">Adicionar Cliente</h3>
              <button onClick={() => setShowAdd(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome do cliente *</label>
                <input
                  value={addForm.clientName}
                  onChange={(e) => setAddForm({ ...addForm, clientName: e.target.value })}
                  required
                  placeholder="Ex: João da Silva"
                  data-testid="input-client-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Contato (WhatsApp/Instagram)</label>
                <input
                  value={addForm.clientContact}
                  onChange={(e) => setAddForm({ ...addForm, clientContact: e.target.value })}
                  placeholder="Ex: 33 99999-0000"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Canal de entrada</label>
                <select
                  value={addForm.channel}
                  onChange={(e) => setAddForm({ ...addForm, channel: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="manual">Manual / Balcão</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Observação</label>
                <textarea
                  value={addForm.notes}
                  onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                  placeholder="Ex: quer trocar tela do iPhone 13"
                  rows={2}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
                  Cancelar
                </button>
                <button type="submit" data-testid="button-confirm-add" className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition">
                  Adicionar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </>}
        </div>

        {/* Chat Interno — coluna lateral (só desktop), agora minimizável.
            O InternalChat fica SEMPRE montado (só escondido por CSS quando
            minimizado) -- senão o contador de não lidas para de atualizar. */}
        {moduleGranted("equipe") && (
          sidebarCollapsed ? (
            <aside className="hidden md:flex w-10 shrink-0 flex-col items-center border-l border-border bg-card sticky top-14 self-start h-[calc(100vh-3.5rem)] py-3">
              <button
                onClick={() => setSidebarCollapsed(false)}
                data-testid="button-expand-internal-chat-sidebar"
                title="Mostrar Chat Interno"
                className="relative p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition"
              >
                <ChevronsLeft className="w-4 h-4" />
                {internalChatUnread > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none flex items-center justify-center">
                    {internalChatUnread > 99 ? "99+" : internalChatUnread}
                  </span>
                )}
              </button>
              <span className="mt-2 text-[10px] text-muted-foreground [writing-mode:vertical-rl]">Chat Interno</span>
              <div className="hidden">
                <InternalChat key={focusInternalRequestId} docked initialConversationId={focusInternalConversationId} />
              </div>
            </aside>
          ) : (
            <aside className="hidden md:flex w-[300px] xl:w-[360px] shrink-0 flex-col border-l border-border bg-card sticky top-14 self-start h-[calc(100vh-3.5rem)]">
              <div className="flex items-center justify-end px-2 py-1 border-b border-border shrink-0">
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  data-testid="button-collapse-internal-chat-sidebar"
                  title="Minimizar Chat Interno"
                  className="p-1 rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 min-h-0 flex flex-col">
                <InternalChat key={focusInternalRequestId} docked initialConversationId={focusInternalConversationId} />
              </div>
            </aside>
          )
        )}
      </div>

      {/* Barra de navegação inferior — somente celular */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-border flex items-stretch h-[calc(3.5rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]">
        {[...MAIN_TABS.filter(({ module }) => moduleGranted(module)), ...(moduleGranted("equipe") ? [{ id: "equipe" as MainTab, label: "Equipe", icon: MessagesSquare }] : [])].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setMainTab(id)}
            data-testid={`bottomnav-${id}`}
            className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition ${
              mainTab === id ? "text-primary" : "text-muted-foreground"
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
      </nav>
    </div>
  );
}

type QueueCardProps = {
  entry: QueueEntry;
  sectors: Sector[];
  position?: number;
  variant: "waiting" | "in_progress";
  onCall?: (id: number) => void;
  onComplete?: (id: number) => void;
  onRemove?: (id: number) => void;
  onTransfer?: (id: number, sectorId: number) => void;
  showTransfer: number | null;
  setShowTransfer: (id: number | null) => void;
  actionLoading: number | null;
};

function QueueCard({
  entry, sectors, position, variant,
  onCall, onComplete, onRemove, onTransfer,
  showTransfer, setShowTransfer, actionLoading
}: QueueCardProps) {
  const busy = actionLoading === entry.id;

  return (
    <div
      data-testid={`card-client-${entry.id}`}
      className={`shk-card p-4 border-l-4 ${variant === "in_progress" ? "border-l-blue-500" : "border-l-amber-400"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {position && (
            <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-700 font-bold text-sm flex items-center justify-center shrink-0">
              {position}
            </div>
          )}
          {variant === "in_progress" && (
            <div className="w-8 h-8 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <PhoneCall className="w-4 h-4" />
            </div>
          )}
          <div className="min-w-0">
            <p className="font-semibold text-foreground text-sm truncate">{entry.clientName}</p>
            {entry.clientContact && (
              <p className="text-xs text-muted-foreground truncate">{entry.clientContact}</p>
            )}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <ChannelBadge channel={entry.channel} />
              <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                <Clock className="w-3 h-3" />
                {formatWait(entry.createdAt)}
              </span>
            </div>
            {entry.notes && (
              <p className="text-xs text-muted-foreground mt-1 italic truncate">"{entry.notes}"</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {variant === "waiting" && onCall && (
            <button
              onClick={() => onCall(entry.id)}
              disabled={busy}
              data-testid={`button-call-${entry.id}`}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition"
            >
              <PhoneCall className="w-3 h-3" />
              Chamar
            </button>
          )}
          {variant === "in_progress" && onComplete && (
            <button
              onClick={() => onComplete(entry.id)}
              disabled={busy}
              data-testid={`button-complete-${entry.id}`}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-xl text-xs font-semibold hover:bg-green-700 disabled:opacity-50 transition"
            >
              <CheckCircle className="w-3 h-3" />
              Finalizar
            </button>
          )}
          <button
            onClick={() => setShowTransfer(showTransfer === entry.id ? null : entry.id)}
            data-testid={`button-transfer-${entry.id}`}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-xl transition"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
          </button>
          {onRemove && (
            <button
              onClick={() => onRemove(entry.id)}
              disabled={busy}
              data-testid={`button-remove-${entry.id}`}
              className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl transition"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Transfer dropdown */}
      {showTransfer === entry.id && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-xs font-medium text-muted-foreground mb-2">Transferir para:</p>
          <div className="flex flex-wrap gap-2">
            {sectors.map((s) => (
              <button
                key={s.id}
                onClick={() => onTransfer && onTransfer(entry.id, s.id)}
                data-testid={`button-transfer-to-${s.id}`}
                className="text-xs px-3 py-1.5 rounded-xl border border-border hover:bg-secondary transition font-medium"
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
