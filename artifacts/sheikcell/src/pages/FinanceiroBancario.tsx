import { useState, useEffect, useCallback } from "react";
import {
  api, ApiError, type FinanceBankProviderInfo, type FinanceBankAccount, type FinanceBankTransaction,
  type FinanceBankSale, type ReconciliationMatchRow, type FinanceBankDashboard, type FinanceBankMetrics, type Store,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import ReauthModal from "@/components/ReauthModal";
import {
  Banknote, Plus, X, RefreshCw, CheckCircle2, XCircle, KeyRound, Landmark, CreditCard, ListChecks, LayoutGrid,
  ArrowDownCircle, ArrowUpCircle, PieChart as PieChartIcon,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
  PieChart, Pie, Cell,
} from "recharts";

const PROVIDER_LABELS: Record<string, string> = {
  pagbank: "PagBank", inter: "Banco Inter", itau: "Itaú", asaas: "Asaas", mercado_pago: "Mercado Pago",
  cappta: "Cappta", rede: "Rede", bradesco: "Bradesco", nubank: "Nubank", sicoob: "Sicoob", sicredi: "Sicredi",
};

// Paleta validada (node scripts/validate_palette.js) contra o card branco do
// app — ver skill de dataviz. Entradas/saídas usam o par divergente (azul↔
// vermelho, o "zero" fica no meio); saldo por loja usa 1 matiz só (sem
// identidade a distinguir); forma de pagamento usa os 3 primeiros slots
// categóricos (únicos validados all-pairs).
const COLOR_CREDIT = "#2a78d6"; // azul — entradas
const COLOR_DEBIT = "#e34948"; // vermelho — saídas
const COLOR_SINGLE = "#2a78d6"; // saldo por loja (medida única, sem identidade)
const PAYMENT_COLORS: Record<string, string> = { credito: "#2a78d6", debito: "#eb6834", pix: "#1baf7a" };
const PAYMENT_LABELS: Record<string, string> = { credito: "Crédito", debito: "Débito", pix: "Pix" };
const CHART_GRID = "#e1e0d9";
const CHART_AXIS = "#c3c2b7";
const CHART_MUTED = "#898781";

const PERIODS: { id: Period; label: string }[] = [
  { id: "hoje", label: "Hoje" }, { id: "7d", label: "7 dias" }, { id: "30d", label: "30 dias" },
  { id: "mes", label: "Este mês" }, { id: "mes_anterior", label: "Mês anterior" }, { id: "custom", label: "Personalizado" },
];
type Period = "hoje" | "7d" | "30d" | "mes" | "mes_anterior" | "custom";

function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0); }
function endOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59); }

function periodRange(period: Period, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  switch (period) {
    case "hoje": return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case "7d": { const f = new Date(now); f.setDate(f.getDate() - 6); return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() }; }
    case "mes": return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: endOfDay(now).toISOString() };
    case "mes_anterior": {
      const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const l = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
      return { from: f.toISOString(), to: l.toISOString() };
    }
    case "custom": return {
      from: customFrom ? startOfDay(new Date(customFrom)).toISOString() : startOfDay(now).toISOString(),
      to: customTo ? endOfDay(new Date(customTo)).toISOString() : endOfDay(now).toISOString(),
    };
    case "30d":
    default: { const f = new Date(now); f.setDate(f.getDate() - 29); return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() }; }
  }
}

function formatMoneyShort(cents: number): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}R$ ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}R$ ${(abs / 1_000).toFixed(1)}mil`;
  return `${sign}R$ ${abs.toFixed(0)}`;
}

const STATUS_BADGE: Record<string, string> = {
  nao_configurado: "bg-secondary text-muted-foreground",
  conectado: "bg-emerald-100 text-emerald-700",
  erro: "bg-red-100 text-red-700",
  desconectado: "bg-secondary text-muted-foreground",
};
const STATUS_LABEL: Record<string, string> = {
  nao_configurado: "Não configurado", conectado: "Conectado", erro: "Erro", desconectado: "Desconectado",
};

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type SubTab = "dashboard" | "accounts" | "transactions" | "sales" | "reconciliation";

export default function FinanceiroBancario() {
  const { toast } = useToast();
  const [subTab, setSubTab] = useState<SubTab>("dashboard");
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<FinanceBankProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<FinanceBankAccount[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [dashboard, setDashboard] = useState<FinanceBankDashboard | null>(null);
  const [transactions, setTransactions] = useState<FinanceBankTransaction[]>([]);
  const [sales, setSales] = useState<FinanceBankSale[]>([]);
  const [matches, setMatches] = useState<ReconciliationMatchRow[]>([]);
  const [reconciling, setReconciling] = useState(false);

  // Filtros do dashboard de métricas (período + loja + provedor).
  const [period, setPeriod] = useState<Period>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [filterStoreId, setFilterStoreId] = useState("");
  const [filterProvider, setFilterProvider] = useState("");
  const [metrics, setMetrics] = useState<FinanceBankMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);

  // Modal: nova conta
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [fStoreId, setFStoreId] = useState("");
  const [fProvider, setFProvider] = useState("pagbank");
  const [fKind, setFKind] = useState<"conta" | "maquininha">("conta");
  const [fLabel, setFLabel] = useState("");
  const [savingAccount, setSavingAccount] = useState(false);

  // Modal: credencial da conta
  const [credentialAccount, setCredentialAccount] = useState<FinanceBankAccount | null>(null);
  const [fSecret, setFSecret] = useState("");
  const [savingCredential, setSavingCredential] = useState(false);

  // Reautenticação (ações sensíveis): guarda a MESMA ação pendente, agora
  // recebendo a senha, para reenviar exatamente a mesma requisição — sem
  // duplicar um modal por ação (salvar credencial, excluir conta, confirmar
  // conciliação de valor alto).
  const [reauthRetry, setReauthRetry] = useState<((password: string) => Promise<void>) | null>(null);
  const runWithReauth = useCallback(async (action: (confirmPassword?: string) => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === "REAUTH_REQUIRED") {
        setReauthRetry(() => async (password: string) => {
          await action(password);
          setReauthRetry(null);
        });
        return;
      }
      throw err;
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, a, s, d, t, sa, m] = await Promise.all([
        api.financeBank.providers(), api.financeBank.accounts(), api.stores.list(),
        api.financeBank.dashboard(), api.financeBank.transactions(), api.financeBank.sales(),
        api.financeBank.matches("pending"),
      ]);
      setProviders(p); setAccounts(a); setStores(s); setDashboard(d); setTransactions(t); setSales(sa); setMatches(m);
    } catch {
      toast({ title: "Erro ao carregar dados financeiros", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Métricas do dashboard recarregam sozinhas quando o filtro muda — sem
  // precisar do botão "Atualizar" geral (que recarrega tudo o resto também).
  useEffect(() => {
    const { from, to } = periodRange(period, customFrom, customTo);
    setMetricsLoading(true);
    api.financeBank.metrics({
      storeId: filterStoreId ? Number(filterStoreId) : undefined,
      provider: filterProvider || undefined,
      from, to,
    }).then(setMetrics).catch(() => toast({ title: "Erro ao carregar métricas", variant: "destructive" })).finally(() => setMetricsLoading(false));
  }, [period, customFrom, customTo, filterStoreId, filterProvider, toast]);

  const providerOptions = (kind: "conta" | "maquininha") =>
    providers.filter((p) => (kind === "conta" ? p.isBank : p.isAcquirer));

  const openNewAccount = () => {
    setFStoreId(stores[0] ? String(stores[0].id) : "");
    setFProvider("pagbank");
    setFKind("conta");
    setFLabel("");
    setShowNewAccount(true);
  };

  const handleCreateAccount = async () => {
    if (savingAccount) return;
    const storeId = Number(fStoreId);
    const label = fLabel.trim();
    if (!storeId) { toast({ title: "Escolha a loja", variant: "destructive" }); return; }
    if (!label) { toast({ title: "Dê um nome para a conta", variant: "destructive" }); return; }
    setSavingAccount(true);
    try {
      const account = await api.financeBank.createAccount({ storeId, provider: fProvider, kind: fKind, label });
      setAccounts((prev) => [account, ...prev]);
      setShowNewAccount(false);
      toast({ title: "Conta cadastrada! Agora conecte a credencial. 🔑" });
    } catch (err) {
      toast({ title: "Erro ao cadastrar conta", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingAccount(false);
    }
  };

  const handleToggleActive = async (account: FinanceBankAccount) => {
    try {
      const updated = await api.financeBank.updateAccount(account.id, { isActive: !account.isActive });
      setAccounts((prev) => prev.map((a) => (a.id === account.id ? updated : a)));
    } catch {
      toast({ title: "Erro ao atualizar conta", variant: "destructive" });
    }
  };

  const handleRemoveAccount = async (account: FinanceBankAccount) => {
    if (!confirm(`Excluir a conta "${account.label}"?`)) return;
    try {
      await runWithReauth(async (confirmPassword) => {
        await api.financeBank.removeAccount(account.id, confirmPassword);
        setAccounts((prev) => prev.filter((a) => a.id !== account.id));
      });
    } catch (err) {
      toast({ title: "Erro ao excluir", description: err instanceof Error ? err.message : "Conta tem histórico — desative em vez de excluir", variant: "destructive" });
    }
  };

  const openCredential = (account: FinanceBankAccount) => {
    setCredentialAccount(account);
    setFSecret("");
  };

  const handleSaveCredential = async () => {
    if (!credentialAccount || savingCredential) return;
    const secret = fSecret.trim();
    if (!secret) { toast({ title: "Cole o token/credencial", variant: "destructive" }); return; }
    const accountId = credentialAccount.id;
    setSavingCredential(true);
    try {
      await runWithReauth(async (confirmPassword) => {
        await api.financeBank.saveCredentials(accountId, secret, confirmPassword);
        setAccounts((prev) => prev.map((a) => (a.id === accountId ? { ...a, status: "conectado" } : a)));
        setCredentialAccount(null);
        toast({ title: "Credencial salva e criptografada! 🔒" });
      });
    } catch (err) {
      toast({ title: "Erro ao salvar credencial", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingCredential(false);
    }
  };

  const handleReconcile = async () => {
    if (reconciling) return;
    setReconciling(true);
    try {
      const summary = await api.financeBank.reconcile();
      toast({ title: `Conciliação rodou: ${summary.matched} casadas de ${summary.evaluated} pendentes` });
      const [t, m] = await Promise.all([api.financeBank.transactions(), api.financeBank.matches("pending")]);
      setTransactions(t); setMatches(m);
    } catch (err) {
      toast({ title: "Erro ao rodar conciliação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setReconciling(false);
    }
  };

  const handleConfirmMatch = async (id: number) => {
    try {
      await runWithReauth(async (confirmPassword) => {
        await api.financeBank.confirmMatch(id, confirmPassword);
        setMatches((prev) => prev.filter((m) => m.id !== id));
      });
    } catch { toast({ title: "Erro ao confirmar", variant: "destructive" }); }
  };

  const handleRejectMatch = async (id: number) => {
    try {
      await api.financeBank.rejectMatch(id);
      setMatches((prev) => prev.filter((m) => m.id !== id));
      const t = await api.financeBank.transactions();
      setTransactions(t);
    } catch { toast({ title: "Erro ao rejeitar", variant: "destructive" }); }
  };

  const subTabs: { id: SubTab; label: string; icon: typeof LayoutGrid }[] = [
    { id: "dashboard", label: "Visão Geral", icon: LayoutGrid },
    { id: "accounts", label: "Contas", icon: Landmark },
    { id: "transactions", label: "Extrato", icon: Banknote },
    { id: "sales", label: "Vendas Cartão", icon: CreditCard },
    { id: "reconciliation", label: "Conciliação", icon: ListChecks },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Banknote className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold">Financeiro Bancário</h1>
          <span className="text-xs text-muted-foreground">saldo, extrato e conciliação por loja e conta</span>
        </div>
        <button onClick={loadAll} data-testid="button-refresh-finance-bank"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
          <RefreshCw className="w-3.5 h-3.5" /> Atualizar
        </button>
      </div>

      <div className="flex gap-1 flex-wrap border-b border-border pb-2">
        {subTabs.map((t) => (
          <button key={t.id} onClick={() => setSubTab(t.id)} data-testid={`subtab-finance-bank-${t.id}`}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition ${
              subTab === t.id ? "bg-primary text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/70"
            }`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-24 rounded-xl bg-secondary animate-pulse" />
      ) : (
        <>
          {subTab === "dashboard" && (
            <div className="space-y-4">
              {/* Filtros: período (uma linha de presets) + loja + provedor */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1 flex-wrap">
                  {PERIODS.map((p) => (
                    <button key={p.id} onClick={() => setPeriod(p.id)} data-testid={`period-${p.id}`}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                        period === p.id ? "bg-primary text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/70"
                      }`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {period === "custom" && (
                  <div className="flex items-center gap-1.5">
                    <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} data-testid="input-period-from"
                      className="rounded-lg border px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40" />
                    <span className="text-xs text-muted-foreground">até</span>
                    <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} data-testid="input-period-to"
                      className="rounded-lg border px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                )}
                <select value={filterStoreId} onChange={(e) => setFilterStoreId(e.target.value)} data-testid="select-filter-store"
                  className="rounded-lg border px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                  <option value="">Todas as lojas</option>
                  {stores.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                </select>
                <select value={filterProvider} onChange={(e) => setFilterProvider(e.target.value)} data-testid="select-filter-provider"
                  className="rounded-lg border px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                  <option value="">Todos os provedores</option>
                  {providers.filter((p) => p.configured).map((p) => (
                    <option key={p.provider} value={p.provider}>{PROVIDER_LABELS[p.provider] ?? p.provider}</option>
                  ))}
                </select>
              </div>

              {metricsLoading ? (
                <div className="h-64 rounded-xl bg-secondary animate-pulse" />
              ) : (
                <>
                  {/* Tiles: saldo total (sempre atual) + métricas do período filtrado */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
                      <p className="text-xs text-muted-foreground">Saldo consolidado (atual)</p>
                      <p className="text-xl font-bold text-primary" data-testid="text-total-balance">{formatMoney(dashboard?.totalCents ?? 0)}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-border p-4">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><ArrowUpCircle className="w-3.5 h-3.5 text-emerald-600" /> Entradas no período</p>
                      <p className="text-xl font-bold text-emerald-600" data-testid="text-period-credit">{formatMoney(metrics?.totals.creditCents ?? 0)}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-border p-4">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><ArrowDownCircle className="w-3.5 h-3.5 text-red-600" /> Saídas no período</p>
                      <p className="text-xl font-bold text-red-600" data-testid="text-period-debit">{formatMoney(metrics?.totals.debitCents ?? 0)}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-border p-4">
                      <p className="text-xs text-muted-foreground">Taxa de conciliação</p>
                      <p className="text-xl font-bold" data-testid="text-reconciliation-rate">{metrics?.totals.reconciliationRatePct ?? 0}%</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{metrics?.totals.matchedCount ?? 0} conciliadas · {metrics?.totals.pendingCount ?? 0} pendentes</p>
                    </div>
                  </div>

                  {!metrics || metrics.cashFlowByDay.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-10">Sem movimentações no período selecionado.</p>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Entradas x Saídas por dia — par divergente, zero no meio */}
                      <div className="bg-white rounded-xl border border-border p-4 lg:col-span-2">
                        <p className="text-sm font-semibold mb-2">Entradas x Saídas por dia</p>
                        <ResponsiveContainer width="100%" height={260}>
                          <BarChart data={metrics.cashFlowByDay.map((d) => ({ ...d, debitCentsNeg: -d.debitCents }))} barGap={2} barCategoryGap="20%">
                            <CartesianGrid vertical={false} stroke={CHART_GRID} />
                            <XAxis dataKey="date" tickFormatter={(d: string) => new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                              tick={{ fontSize: 11, fill: CHART_MUTED }} axisLine={{ stroke: CHART_AXIS }} tickLine={false} />
                            <YAxis tickFormatter={formatMoneyShort} tick={{ fontSize: 11, fill: CHART_MUTED }} axisLine={false} tickLine={false} width={70} />
                            <Tooltip
                              formatter={(value: number, name: string) => [formatMoney(Math.abs(value)), name]}
                              labelFormatter={(d: string) => new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}
                              contentStyle={{ borderRadius: 12, border: "1px solid #e1e0d9", fontSize: 12 }}
                              cursor={{ fill: "rgba(11,11,11,0.03)" }}
                            />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <ReferenceLine y={0} stroke={CHART_AXIS} />
                            <Bar dataKey="creditCents" name="Entradas" fill={COLOR_CREDIT} radius={[4, 4, 0, 0]} maxBarSize={22} />
                            <Bar dataKey="debitCentsNeg" name="Saídas" fill={COLOR_DEBIT} radius={[0, 0, 4, 4]} maxBarSize={22} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Saldo por loja — medida única, sem legenda (regra: 1 série não precisa) */}
                      <div className="bg-white rounded-xl border border-border p-4">
                        <p className="text-sm font-semibold mb-2">Saldo do período por loja</p>
                        {metrics.byStore.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-8 text-center">Sem dados.</p>
                        ) : (
                          <ResponsiveContainer width="100%" height={Math.max(120, metrics.byStore.length * 44)}>
                            <BarChart data={metrics.byStore} layout="vertical" margin={{ left: 8, right: 16 }}>
                              <CartesianGrid horizontal={false} stroke={CHART_GRID} />
                              <XAxis type="number" tickFormatter={formatMoneyShort} tick={{ fontSize: 11, fill: CHART_MUTED }} axisLine={false} tickLine={false} />
                              <YAxis type="category" dataKey="storeName" tick={{ fontSize: 12, fill: "#52514e" }} axisLine={false} tickLine={false} width={90} />
                              <Tooltip formatter={(v: number) => formatMoney(v)} contentStyle={{ borderRadius: 12, border: "1px solid #e1e0d9", fontSize: 12 }} cursor={{ fill: "rgba(11,11,11,0.03)" }} />
                              <Bar dataKey="netCents" name="Saldo" fill={COLOR_SINGLE} radius={[0, 4, 4, 0]} maxBarSize={20} />
                            </BarChart>
                          </ResponsiveContainer>
                        )}
                      </div>

                      {/* Vendas por forma de pagamento — categórico, legenda + rótulo (mitiga contraste do aqua) */}
                      <div className="bg-white rounded-xl border border-border p-4">
                        <p className="text-sm font-semibold mb-2 flex items-center gap-1.5"><PieChartIcon className="w-4 h-4 text-muted-foreground" /> Vendas por forma de pagamento</p>
                        {metrics.salesByPaymentMethod.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-8 text-center">Sem vendas de cartão no período.</p>
                        ) : (
                          <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                              <Pie data={metrics.salesByPaymentMethod} dataKey="grossCents" nameKey="paymentMethod"
                                innerRadius={50} outerRadius={80} paddingAngle={2}
                                label={({ paymentMethod, grossCents }: { paymentMethod: string; grossCents: number }) => `${PAYMENT_LABELS[paymentMethod] ?? paymentMethod} ${formatMoneyShort(grossCents)}`}
                                labelLine={false}>
                                {metrics.salesByPaymentMethod.map((entry) => (
                                  <Cell key={entry.paymentMethod} fill={PAYMENT_COLORS[entry.paymentMethod] ?? CHART_MUTED} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(v: number) => formatMoney(v)} contentStyle={{ borderRadius: 12, border: "1px solid #e1e0d9", fontSize: 12 }} />
                              <Legend formatter={(value: string) => PAYMENT_LABELS[value] ?? value} wrapperStyle={{ fontSize: 12 }} />
                            </PieChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Saldo atual por conta (não filtrado por período — é o saldo agora) */}
              <div>
                <p className="text-sm font-semibold mb-2">Saldo atual por conta</p>
                {dashboard && dashboard.accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">Nenhuma conta cadastrada ainda. Vá em "Contas" para começar.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {dashboard?.accounts.map((a) => (
                      <div key={a.accountId} className="bg-white rounded-xl border border-border p-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-muted-foreground">{a.storeName}</span>
                          <span className="text-[10px] bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">{PROVIDER_LABELS[a.provider] ?? a.provider}</span>
                        </div>
                        <p className="text-sm font-semibold mt-1">{a.label}</p>
                        <p className="text-xl font-bold mt-1">{formatMoney(a.balanceCents)}</p>
                        <p className="text-[11px] text-muted-foreground mt-1">Última sincronização: {formatDate(a.lastSyncAt)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {subTab === "accounts" && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={openNewAccount} data-testid="button-new-finance-account"
                  className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
                  <Plus className="w-3.5 h-3.5" /> Nova conta
                </button>
              </div>
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhuma conta cadastrada.</p>
              ) : (
                <div className="space-y-2">
                  {accounts.map((a) => (
                    <div key={a.id} data-testid={`finance-account-${a.id}`} className="bg-white rounded-xl border border-border p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm">{a.label}</p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_BADGE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
                          {!a.isActive && <span className="text-[10px] bg-secondary text-muted-foreground rounded-full px-2 py-0.5">Inativa</span>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {a.storeName} · {PROVIDER_LABELS[a.provider] ?? a.provider} · {a.kind === "maquininha" ? "Maquininha" : "Conta"}
                        </p>
                      </div>
                      <button onClick={() => openCredential(a)} data-testid={`button-credential-${a.id}`}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:bg-primary/10 rounded-lg px-2 py-1.5 transition">
                        <KeyRound className="w-3.5 h-3.5" /> Credencial
                      </button>
                      <button onClick={() => handleToggleActive(a)}
                        className="text-xs font-semibold text-muted-foreground hover:bg-secondary rounded-lg px-2 py-1.5 transition">
                        {a.isActive ? "Desativar" : "Ativar"}
                      </button>
                      <button onClick={() => handleRemoveAccount(a)} data-testid={`button-remove-account-${a.id}`}
                        className="text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg px-2 py-1.5 transition">
                        Excluir
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {subTab === "transactions" && (
            <div className="space-y-2">
              {transactions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhuma movimentação registrada ainda.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-2">Data</th>
                        <th className="text-left px-3 py-2">Conta</th>
                        <th className="text-left px-3 py-2">Descrição</th>
                        <th className="text-right px-3 py-2">Valor</th>
                        <th className="text-left px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((t) => (
                        <tr key={t.id} data-testid={`transaction-row-${t.id}`} className="border-t border-border/50">
                          <td className="px-3 py-2 whitespace-nowrap">{formatDate(t.postedAt)}</td>
                          <td className="px-3 py-2">{t.accountLabel}</td>
                          <td className="px-3 py-2 text-muted-foreground">{t.description ?? "—"}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${t.type === "credit" ? "text-emerald-600" : "text-red-600"}`}>
                            {t.type === "credit" ? "+" : "-"}{formatMoney(Math.abs(t.amountCents))}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              t.reconciliationStatus === "matched" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                            }`}>{t.reconciliationStatus === "matched" ? "Conciliado" : "Pendente"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {subTab === "sales" && (
            <div className="space-y-2">
              {sales.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhuma venda de cartão registrada ainda.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-2">Data</th>
                        <th className="text-left px-3 py-2">Bandeira</th>
                        <th className="text-left px-3 py-2">Forma</th>
                        <th className="text-right px-3 py-2">Bruto</th>
                        <th className="text-right px-3 py-2">Líquido</th>
                        <th className="text-left px-3 py-2">Repasse</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sales.map((s) => (
                        <tr key={s.id} data-testid={`sale-row-${s.id}`} className="border-t border-border/50">
                          <td className="px-3 py-2 whitespace-nowrap">{formatDate(s.soldAt)}</td>
                          <td className="px-3 py-2">{s.cardBrand ?? "—"}</td>
                          <td className="px-3 py-2 capitalize">{s.paymentMethod}{s.installments > 1 ? ` ${s.installments}x` : ""}</td>
                          <td className="px-3 py-2 text-right">{formatMoney(s.grossAmountCents)}</td>
                          <td className="px-3 py-2 text-right font-semibold">{formatMoney(s.netAmountCents)}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              s.repasseStatus === "repassado" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                            }`}>{s.repasseStatus === "repassado" ? "Repassado" : "Pendente"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {subTab === "reconciliation" && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={handleReconcile} disabled={reconciling} data-testid="button-run-reconciliation"
                  className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                  <RefreshCw className={`w-3.5 h-3.5 ${reconciling ? "animate-spin" : ""}`} /> {reconciling ? "Conciliando..." : "Rodar conciliação agora"}
                </button>
              </div>
              {matches.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhuma pendência de revisão manual. 🎉</p>
              ) : (
                <div className="space-y-2">
                  {matches.map((m) => (
                    <div key={m.id} data-testid={`match-row-${m.id}`} className="bg-white rounded-xl border border-border p-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">Transação #{m.bankTransactionId} ↔ {m.matchedType === "acquirer_repasse" ? "Repasse" : m.matchedType === "acquirer_sale" ? "Venda" : "Manual"} #{m.matchedRecordId}</p>
                        <p className="text-xs text-muted-foreground">Casado por {m.matchedBy === "system" ? "sistema" : m.matchedBy} em {formatDate(m.createdAt)}</p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => handleConfirmMatch(m.id)} data-testid={`button-confirm-match-${m.id}`}
                          className="flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 rounded-lg px-2 py-1.5 transition">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Confirmar
                        </button>
                        <button onClick={() => handleRejectMatch(m.id)} data-testid={`button-reject-match-${m.id}`}
                          className="flex items-center gap-1 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg px-2 py-1.5 transition">
                          <XCircle className="w-3.5 h-3.5" /> Rejeitar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Modal: nova conta */}
      {showNewAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3" onClick={() => setShowNewAccount(false)}>
          <div className="bg-card rounded-xl w-full max-w-md shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><Landmark className="w-4 h-4 text-primary" /> Nova conta bancária</span>
              <button onClick={() => setShowNewAccount(false)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Loja</label>
                <select value={fStoreId} onChange={(e) => setFStoreId(e.target.value)} data-testid="select-account-store"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                  <option value="">Selecione...</option>
                  {stores.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Tipo</label>
                <div className="flex gap-1.5 mt-1">
                  <button onClick={() => setFKind("conta")} type="button"
                    className={`flex-1 text-xs font-semibold rounded-lg px-3 py-2 transition ${fKind === "conta" ? "bg-primary text-white" : "bg-secondary text-muted-foreground"}`}>
                    Conta bancária
                  </button>
                  <button onClick={() => setFKind("maquininha")} type="button"
                    className={`flex-1 text-xs font-semibold rounded-lg px-3 py-2 transition ${fKind === "maquininha" ? "bg-primary text-white" : "bg-secondary text-muted-foreground"}`}>
                    Maquininha
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Banco / Gateway / Credenciadora</label>
                <select value={fProvider} onChange={(e) => setFProvider(e.target.value)} data-testid="select-account-provider"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                  {providerOptions(fKind).map((p) => (
                    <option key={p.provider} value={p.provider}>{PROVIDER_LABELS[p.provider] ?? p.provider}{!p.configured ? " (em breve)" : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Nome da conta</label>
                <input value={fLabel} onChange={(e) => setFLabel(e.target.value)} data-testid="input-account-label"
                  placeholder="Ex.: PagBank Loja MT"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <button onClick={handleCreateAccount} disabled={savingAccount} data-testid="button-save-account"
                className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {savingAccount ? "Salvando..." : "Cadastrar conta"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: credencial da conta */}
      {credentialAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3" onClick={() => setCredentialAccount(null)}>
          <div className="bg-card rounded-xl w-full max-w-md shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><KeyRound className="w-4 h-4 text-primary" /> Credencial — {credentialAccount.label}</span>
              <button onClick={() => setCredentialAccount(null)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Cole o token/API key da conta no {PROVIDER_LABELS[credentialAccount.provider] ?? credentialAccount.provider}.
                Fica criptografado no banco — ninguém consegue ler o valor depois de salvo.
              </p>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Token / API Key</label>
                <input type="password" value={fSecret} onChange={(e) => setFSecret(e.target.value)} data-testid="input-account-secret"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <button onClick={handleSaveCredential} disabled={savingCredential} data-testid="button-save-credential"
                className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {savingCredential ? "Salvando..." : "Salvar credencial"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reautenticação: some ao confirmar (a própria ação já fecha) ou ao cancelar */}
      {reauthRetry && (
        <ReauthModal onConfirm={reauthRetry} onClose={() => setReauthRetry(null)} />
      )}
    </div>
  );
}
