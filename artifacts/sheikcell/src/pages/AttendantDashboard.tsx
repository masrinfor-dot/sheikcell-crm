import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { api, type QueueEntry, type Sector } from "@/lib/api";
import { SectorIcon } from "@/components/SectorIcon";
import { ChannelBadge } from "@/components/ChannelBadge";
import { useToast } from "@/hooks/use-toast";
import CrmBoard from "./CrmBoard";
import {
  Smartphone, LogOut, Clock, PhoneCall, CheckCircle,
  ArrowRightLeft, UserPlus, X, RefreshCw, Users, Kanban
} from "lucide-react";

type MainTab = "queue" | "crm";

function formatWait(createdAt: string): string {
  const diff = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}min`;
}

export default function AttendantDashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();

  const [mainTab, setMainTab] = useState<MainTab>("queue");
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
      {/* Navbar */}
      <nav className="bg-white border-b border-border sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center">
              <Smartphone className="w-4 h-4 text-white" />
            </div>
            <span className="font-extrabold text-foreground text-sm">Sheikcell</span>
          </div>
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

      {/* Sub-tabs */}
      <div className="bg-white border-b border-border">
        <div className="max-w-3xl mx-auto px-4 flex gap-1">
          {([
            { id: "queue" as MainTab, label: "Fila de Atendimento", icon: PhoneCall },
            { id: "crm"   as MainTab, label: "CRM",                 icon: Kanban   },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setMainTab(id)}
              className={`flex items-center gap-1.5 px-4 py-3.5 text-xs font-semibold border-b-2 transition-colors ${
                mainTab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}>
              <Icon className="w-3.5 h-3.5" />{label}
            </button>
          ))}
        </div>
      </div>

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
