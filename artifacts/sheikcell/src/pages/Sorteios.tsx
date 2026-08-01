import { useState, useEffect } from "react";
import { api, type Raffle, type RaffleDraw, type Sector, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Gift, Plus, X, Trash2, Pencil, Play, History, Users, RefreshCw } from "lucide-react";

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

const DEFAULT_TEMPLATE =
  "Parabéns {nome}! 🎉 Você foi sorteado(a) e ganhou {premio} aqui na {loja}. Fale com a gente para combinar a retirada!";

type FormState = {
  name: string; prize: string; storeName: string; messageTemplate: string;
  winnersCount: number; recurrence: "once" | "weekly" | "monthly";
  dayOfWeek: number; dayOfMonth: number; periodDays: string;
  onlyResolved: boolean; surveyRespondedOnly: boolean; excludePreviousWinners: boolean; active: boolean;
  sectorIds: number[]; vendedorIds: number[]; sessionKeys: string[];
  clientTypes: string[];
};

// Tipos de cliente que podem participar (combináveis — vale qualquer um marcado)
const CLIENT_TYPES: { value: string; label: string }[] = [
  { value: "comprou", label: "🛒 Compraram (venda registrada)" },
  { value: "prospeccao", label: "🔎 Em prospecção (atendimento em andamento)" },
  { value: "Venda realizada", label: "Finalizados: venda realizada" },
  { value: "Orçamento enviado", label: "Finalizados: orçamento enviado" },
  { value: "Cliente vai pensar", label: "Finalizados: cliente vai pensar" },
  { value: "Sem interesse", label: "Finalizados: sem interesse" },
  { value: "Sem resposta do cliente", label: "Finalizados: sem resposta" },
  { value: "Dúvida esclarecida", label: "Finalizados: dúvida esclarecida" },
  { value: "Problema resolvido", label: "Finalizados: problema resolvido" },
];

const emptyForm = (): FormState => ({
  name: "", prize: "", storeName: "", messageTemplate: DEFAULT_TEMPLATE,
  winnersCount: 1, recurrence: "once", dayOfWeek: 5, dayOfMonth: 1, periodDays: "",
  onlyResolved: false, surveyRespondedOnly: false, excludePreviousWinners: true, active: true,
  sectorIds: [], vendedorIds: [], sessionKeys: [], clientTypes: [],
});

// Aba "Sorteios" (admin): sorteios entre clientes com filtros, recorrência
// e mensagem automática para o ganhador.
export default function Sorteios() {
  const { toast } = useToast();
  const { user } = useAuth();
  // Admin (ou quem tem "sorteios" liberado) gerencia tudo; vendedor comum
  // só cria sorteios entre os próprios clientes.
  const isManager = user?.role === "admin" || !!user?.adminAccess?.includes("sorteios");
  const [raffles, setRaffles] = useState<Raffle[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [vendedores, setVendedores] = useState<User[]>([]);
  const [waSessions, setWaSessions] = useState<{ sessionKey: string; displayName: string | null; phoneNumber: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Raffle | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  const [drawsOf, setDrawsOf] = useState<Raffle | null>(null);
  const [draws, setDraws] = useState<RaffleDraw[]>([]);
  const [eligibleCount, setEligibleCount] = useState<Record<number, number>>({});
  const [runningId, setRunningId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      api.raffles.list(),
      api.sectors.list().catch(() => [] as Sector[]),
      api.admin.users.list().catch(() => []),
      api.chat.waSessions().catch(() => []),
    ]).then(([r, s, u, w]) => {
      setRaffles(r);
      setSectors(s);
      setVendedores(u.filter((x) => x.role === "vendedor" && x.isActive));
      setWaSessions(w);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const openForm = (r?: Raffle) => {
    setEditing(r ?? null);
    setForm(r ? {
      name: r.name, prize: r.prize, storeName: r.storeName ?? "", messageTemplate: r.messageTemplate,
      winnersCount: r.winnersCount, recurrence: r.recurrence,
      dayOfWeek: r.dayOfWeek ?? 5, dayOfMonth: r.dayOfMonth ?? 1,
      periodDays: r.periodDays != null ? String(r.periodDays) : "",
      onlyResolved: r.onlyResolved, surveyRespondedOnly: r.surveyRespondedOnly, excludePreviousWinners: r.excludePreviousWinners, active: r.active,
      sectorIds: r.sectorIds ?? [], vendedorIds: r.vendedorIds ?? [], sessionKeys: r.sessionKeys ?? [],
      clientTypes: r.clientTypes ?? [],
    } : emptyForm());
    setShowForm(true);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        periodDays: form.periodDays.trim() === "" ? null : parseInt(form.periodDays, 10),
        sectorIds: form.sectorIds.length ? form.sectorIds : null,
        vendedorIds: form.vendedorIds.length ? form.vendedorIds : null,
        sessionKeys: form.sessionKeys.length ? form.sessionKeys : null,
        clientTypes: form.clientTypes.length ? form.clientTypes : null,
      };
      if (editing) {
        const upd = await api.raffles.update(editing.id, payload as Partial<Raffle>);
        setRaffles((prev) => prev.map((r) => (r.id === upd.id ? upd : r)));
      } else {
        const created = await api.raffles.create(payload as Partial<Raffle>);
        setRaffles((prev) => [created, ...prev]);
      }
      setShowForm(false);
      toast({ title: editing ? "Sorteio atualizado" : "Sorteio criado" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (r: Raffle) => {
    if (!window.confirm(`Excluir o sorteio "${r.name}" e todo o histórico dele?`)) return;
    try {
      await api.raffles.remove(r.id);
      setRaffles((prev) => prev.filter((x) => x.id !== r.id));
      toast({ title: "Sorteio excluído" });
    } catch {
      toast({ title: "Erro ao excluir", variant: "destructive" });
    }
  };

  const checkEligible = async (r: Raffle) => {
    try {
      const { count } = await api.raffles.eligible(r.id);
      setEligibleCount((prev) => ({ ...prev, [r.id]: count }));
    } catch {
      toast({ title: "Erro ao contar participantes", variant: "destructive" });
    }
  };

  const handleRun = async (r: Raffle) => {
    const n = eligibleCount[r.id];
    const msg = `Sortear agora "${r.name}"?\n\n${n != null ? `${n} cliente(s) participando. ` : ""}O(s) ganhador(es) receberá(ão) a mensagem automática no WhatsApp.`;
    if (!window.confirm(msg)) return;
    setRunningId(r.id);
    try {
      const { draw } = await api.raffles.run(r.id);
      const names = draw.winners.map((w) => w.name || w.phone).join(", ");
      const failed = draw.winners.filter((w) => !w.sent).length;
      toast({
        title: `🎉 Ganhador(es): ${names}`,
        description: failed ? `${failed} mensagem(ns) não foi(ram) entregue(s) — veja o histórico` : "Mensagem enviada pelo WhatsApp!",
      });
      if (drawsOf?.id === r.id) setDraws(await api.raffles.draws(r.id));
    } catch (err) {
      toast({ title: "Erro no sorteio", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setRunningId(null);
    }
  };

  const [resending, setResending] = useState<string | null>(null);
  const handleResend = async (drawId: number, phone: string) => {
    if (!drawsOf || resending) return;
    setResending(`${drawId}:${phone}`);
    try {
      const { sent } = await api.raffles.resend(drawsOf.id, drawId, phone);
      setDraws(await api.raffles.draws(drawsOf.id));
      toast(sent
        ? { title: "Mensagem enviada ao ganhador! 🎉" }
        : { title: "Ainda não foi possível enviar", description: "Confira se o WhatsApp está conectado e tente de novo.", variant: "destructive" });
    } catch (err) {
      toast({ title: "Erro ao reenviar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setResending(null);
    }
  };

  const openDraws = async (r: Raffle) => {
    setDrawsOf(r);
    setDraws([]);
    try { setDraws(await api.raffles.draws(r.id)); } catch { /* toast abaixo já cobre */ }
  };

  const stores = [...new Set(vendedores.map((v) => v.storeName ?? "").filter(Boolean))].sort();

  const toggleNum = (arr: number[], v: number) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  const toggleStr = (arr: string[], v: string) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const recurrenceLabel = (r: Raffle) =>
    r.recurrence === "weekly" ? `Toda ${WEEKDAYS[r.dayOfWeek ?? 0]}` :
    r.recurrence === "monthly" ? `Todo dia ${r.dayOfMonth}` : "Uma vez (manual)";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Gift className="w-5 h-5 text-primary" /> Sorteios
        </h2>
        <button onClick={() => openForm()} data-testid="button-add-raffle"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold hover:opacity-90 transition">
          <Plus className="w-3.5 h-3.5" /> Novo sorteio
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Carregando...</p>
      ) : raffles.length === 0 ? (
        <div className="shk-card p-8 text-center text-sm text-muted-foreground">
          Nenhum sorteio ainda. Crie o primeiro para premiar seus clientes! 🎁
        </div>
      ) : (
        <div className="space-y-3">
          {raffles.map((r) => (
            <div key={r.id} className="shk-card p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-bold text-sm flex items-center gap-2">
                    {r.name}
                    {!r.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">pausado</span>}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">🎁 {r.prize}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {recurrenceLabel(r)} · {r.winnersCount} ganhador{r.winnersCount > 1 ? "es" : ""}
                    {r.periodDays ? ` · clientes dos últimos ${r.periodDays} dias` : ""}
                    {r.onlyResolved ? " · só atendimentos finalizados" : ""}
                    {r.sectorIds?.length ? ` · ${r.sectorIds.length} setor(es)` : ""}
                    {r.vendedorIds?.length ? ` · ${r.vendedorIds.length} vendedor(es)` : ""}
                  </p>
                  <button onClick={() => checkEligible(r)} className="text-[11px] text-primary font-semibold mt-1 flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {eligibleCount[r.id] != null ? `${eligibleCount[r.id]} cliente(s) participando` : "Ver quantos participam"}
                  </button>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => handleRun(r)} disabled={runningId === r.id} data-testid={`button-run-raffle-${r.id}`}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary text-[11px] font-bold hover:bg-primary/20 transition disabled:opacity-50">
                    {runningId === r.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Sortear agora
                  </button>
                  <button onClick={() => openDraws(r)} title="Histórico"
                    className="p-1.5 rounded-lg hover:bg-secondary transition"><History className="w-4 h-4 text-muted-foreground" /></button>
                  <button onClick={() => openForm(r)} title="Editar"
                    className="p-1.5 rounded-lg hover:bg-secondary transition"><Pencil className="w-4 h-4 text-muted-foreground" /></button>
                  <button onClick={() => handleDelete(r)} title="Excluir"
                    className="p-1.5 rounded-lg hover:bg-secondary transition"><Trash2 className="w-4 h-4 text-destructive" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal criar/editar */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editing ? "Editar sorteio" : "Novo sorteio"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <label className="font-semibold">Nome do sorteio</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex.: Sorteio de Natal" className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" data-testid="input-raffle-name" />
              </div>
              <div>
                <label className="font-semibold">Prêmio</label>
                <input value={form.prize} onChange={(e) => setForm({ ...form, prize: e.target.value })}
                  placeholder="Ex.: 1 película 3D grátis" className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
              </div>
              <div>
                <label className="font-semibold">Nome da loja (para a mensagem)</label>
                <input value={form.storeName} onChange={(e) => setForm({ ...form, storeName: e.target.value })}
                  placeholder="Ex.: Sheikcell" className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
              </div>
              <div>
                <label className="font-semibold">Mensagem para o ganhador</label>
                <textarea value={form.messageTemplate} onChange={(e) => setForm({ ...form, messageTemplate: e.target.value })}
                  rows={3} className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                <p className="text-[10px] text-muted-foreground mt-0.5">Use {"{nome}"}, {"{premio}"} e {"{loja}"} — o sistema preenche sozinho.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold">Ganhadores</label>
                  <input type="number" min={1} max={20} value={form.winnersCount}
                    onChange={(e) => setForm({ ...form, winnersCount: parseInt(e.target.value || "1", 10) })} className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                </div>
                <div>
                  <label className="font-semibold">Recorrência</label>
                  <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value as FormState["recurrence"] })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1">
                    <option value="once">Uma vez (sorteio manual)</option>
                    <option value="weekly">Toda semana (automático)</option>
                    <option value="monthly">Todo mês (automático)</option>
                  </select>
                </div>
              </div>
              {form.recurrence === "weekly" && (
                <div>
                  <label className="font-semibold">Dia da semana</label>
                  <select value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: parseInt(e.target.value, 10) })} className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1">
                    {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                  <p className="text-[10px] text-muted-foreground mt-0.5">O sorteio roda sozinho nesse dia, a partir das 10h.</p>
                </div>
              )}
              {form.recurrence === "monthly" && (
                <div>
                  <label className="font-semibold">Dia do mês (1 a 28)</label>
                  <input type="number" min={1} max={28} value={form.dayOfMonth}
                    onChange={(e) => setForm({ ...form, dayOfMonth: parseInt(e.target.value || "1", 10) })} className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                  <p className="text-[10px] text-muted-foreground mt-0.5">O sorteio roda sozinho nesse dia, a partir das 10h.</p>
                </div>
              )}

              <div className="border-t border-border pt-3">
                <p className="font-bold mb-2">{isManager ? "Quem participa (deixe em branco = todos)" : "Quem participa"}</p>
                {!isManager && (
                  <p className="text-[11px] text-muted-foreground mb-2 bg-secondary/60 rounded-lg px-2.5 py-1.5">
                    🎯 O sorteio será feito entre os <b>seus clientes</b> (conversas atendidas por você).
                  </p>
                )}
                {isManager && sectors.length > 0 && (
                  <div className="mb-2">
                    <label className="font-semibold">Setores</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {sectors.map((s) => (
                        <button key={s.id} onClick={() => setForm({ ...form, sectorIds: toggleNum(form.sectorIds, s.id) })}
                          className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${form.sectorIds.includes(s.id) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mb-2">
                  <label className="font-semibold">Tipo de cliente (nenhum marcado = todos)</label>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {CLIENT_TYPES.map((ct) => (
                      <button key={ct.value} onClick={() => setForm({ ...form, clientTypes: toggleStr(form.clientTypes, ct.value) })}
                        data-testid={`toggle-client-type-${ct.value}`}
                        className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${form.clientTypes.includes(ct.value) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                        {ct.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Pode marcar vários: participa quem se encaixa em qualquer um deles.</p>
                </div>
                {isManager && stores.length > 0 && (
                  <div className="mb-2">
                    <label className="font-semibold">Lojas (marca todos os vendedores da loja)</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {stores.map((st) => {
                        const ids = vendedores.filter((v) => (v.storeName ?? "") === st).map((v) => v.id);
                        const allOn = ids.length > 0 && ids.every((id) => form.vendedorIds.includes(id));
                        return (
                          <button key={st} onClick={() => setForm({
                            ...form,
                            vendedorIds: allOn
                              ? form.vendedorIds.filter((id) => !ids.includes(id))
                              : [...new Set([...form.vendedorIds, ...ids])],
                          })}
                            className={`px-2 py-1 rounded-lg border text-[11px] font-bold transition ${allOn ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                            🏪 {st}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {isManager && vendedores.length > 0 && (
                  <div className="mb-2">
                    <label className="font-semibold">Vendedores (clientes atendidos por)</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {vendedores.map((v) => (
                        <button key={v.id} onClick={() => setForm({ ...form, vendedorIds: toggleNum(form.vendedorIds, v.id) })}
                          className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${form.vendedorIds.includes(v.id) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                          {v.name}{v.storeName ? ` · ${v.storeName}` : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {isManager && waSessions.length > 1 && (
                  <div className="mb-2">
                    <label className="font-semibold">Número de WhatsApp (loja)</label>
                    <p className="text-[10px] text-muted-foreground">Marque um ou mais números: só participam clientes que falaram por eles. Nenhum marcado = todos os números.</p>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {waSessions.map((w) => (
                        <button key={w.sessionKey} onClick={() => setForm({ ...form, sessionKeys: toggleStr(form.sessionKeys, w.sessionKey) })}
                          className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition ${form.sessionKeys.includes(w.sessionKey) ? "bg-primary text-white border-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}>
                          {w.displayName || w.phoneNumber || w.sessionKey}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <label className="font-semibold">Só clientes com movimento nos últimos X dias (opcional)</label>
                  <input type="number" min={1} max={365} value={form.periodDays} placeholder="Ex.: 30"
                    onChange={(e) => setForm({ ...form, periodDays: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-border text-sm mt-1" />
                </div>
                <label className="flex items-center gap-2 font-medium mt-2">
                  <input type="checkbox" checked={form.onlyResolved} onChange={(e) => setForm({ ...form, onlyResolved: e.target.checked })} />
                  Só clientes com atendimento finalizado
                </label>
                <label className="flex items-center gap-2 font-medium mt-1.5">
                  <input type="checkbox" checked={form.surveyRespondedOnly} onChange={(e) => setForm({ ...form, surveyRespondedOnly: e.target.checked })} />
                  Só quem respondeu a pesquisa de satisfação
                </label>
                <label className="flex items-center gap-2 font-medium mt-1.5">
                  <input type="checkbox" checked={form.excludePreviousWinners} onChange={(e) => setForm({ ...form, excludePreviousWinners: e.target.checked })} />
                  Não repetir quem já ganhou neste sorteio
                </label>
                <label className="flex items-center gap-2 font-medium mt-1.5">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Sorteio ativo
                </label>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">Cancelar</button>
              <button onClick={handleSave} disabled={saving} data-testid="button-save-raffle"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal histórico */}
      {drawsOf && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-md p-6 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-sm">Histórico — {drawsOf.name}</h3>
              <button onClick={() => setDrawsOf(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            {draws.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum sorteio realizado ainda.</p>
            ) : (
              <div className="space-y-3">
                {draws.map((d) => (
                  <div key={d.id} className="border border-border rounded-xl p-3">
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString("pt-BR")} · {d.eligibleCount} participante(s)
                      {d.periodKey.startsWith("manual") ? " · manual" : " · automático"}
                    </p>
                    <div className="mt-1.5 space-y-1">
                      {d.winners.map((w, i) => (
                        <div key={i} className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold truncate">🏆 {w.name || w.phone}</span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${w.sent ? "bg-green-500/10 text-green-600" : "bg-destructive/10 text-destructive"}`}>
                              {w.sent ? "mensagem enviada" : "envio falhou"}
                            </span>
                            {!w.sent && (
                              <button onClick={() => handleResend(d.id, w.phone)} disabled={resending != null}
                                data-testid={`button-resend-winner-${d.id}-${i}`}
                                className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-primary text-white hover:opacity-90 disabled:opacity-50 transition">
                                {resending === `${d.id}:${w.phone}` ? "Enviando..." : "Reenviar"}
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
