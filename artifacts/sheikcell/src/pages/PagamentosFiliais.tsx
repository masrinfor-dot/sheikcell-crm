import { useState, useEffect, useCallback, useMemo } from "react";
import {
  api, canEditModule, type FinanceBankAccount, type FinancePayment,
  type FinancePaymentSummary, type Store,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeftRight, Plus, X, Trash2, CheckCircle2, Circle, Landmark, Filter, FileSpreadsheet,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const CHART_CONFIG: ChartConfig = {
  pago: { label: "Pago", color: "hsl(var(--primary))" },
  aberto: { label: "Em aberto", color: "#d97706" },
};

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

type AllocationRow = { storeId: number; checked: boolean; percent: string; value: string };

const emptyForm = {
  id: null as number | null,
  paymentDate: new Date().toISOString().slice(0, 10),
  description: "",
  supplier: "",
  payingStoreId: null as number | null,
  payingBankAccountId: null as number | null,
  totalAmount: "",
  splitType: "rateada" as "rateada" | "direta",
  directStoreId: null as number | null,
  splitMode: "percent" as "percent" | "value",
};

// Aba "Financeiro > Pagamentos entre Filiais": substitui a planilha que a
// Matriz usava pra registrar pagamentos feitos em nome da rede e ratear
// entre as filiais (banco pagador, filial pagadora, valor, descrição).
export default function PagamentosFiliais() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = (user?.role === "admin" || user?.role === "supervisor") && canEditModule(user, "pagamentos");

  const [stores, setStores] = useState<Store[]>([]);
  const [bankAccounts, setBankAccounts] = useState<FinanceBankAccount[]>([]);
  const [payments, setPayments] = useState<FinancePayment[]>([]);
  const [summary, setSummary] = useState<FinancePaymentSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const [filterStoreId, setFilterStoreId] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<"" | "aberto" | "pago">("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [allocRows, setAllocRows] = useState<AllocationRow[]>([]);
  const [formBankAccounts, setFormBankAccounts] = useState<FinanceBankAccount[]>([]);
  const [saving, setSaving] = useState(false);

  const [showBankForm, setShowBankForm] = useState(false);
  const [bankForm, setBankForm] = useState({ storeId: null as number | null, bankName: "", label: "" });
  const [savingBank, setSavingBank] = useState(false);

  const storeName = useCallback((id: number) => stores.find((s) => s.id === id)?.name ?? "—", [stores]);
  const bankLabel = useCallback((id: number) => {
    const b = bankAccounts.find((x) => x.id === id);
    if (!b) return "—";
    return b.label ? `${b.bankName} (${b.label})` : b.bankName;
  }, [bankAccounts]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.financePayments.list({ storeId: filterStoreId, status: filterStatus || null }),
      api.financePayments.summary(),
    ]).then(([p, s]) => { setPayments(p); setSummary(s); })
      .catch(() => toast({ title: "Erro ao carregar pagamentos", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [filterStoreId, filterStatus, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.stores.list().then(setStores).catch(() => {});
    api.financePayments.bankAccounts.list().then(setBankAccounts).catch(() => {});
  }, []);

  // Recarrega as contas bancárias da filial pagadora escolhida no formulário.
  useEffect(() => {
    if (!showForm || !form.payingStoreId) { setFormBankAccounts([]); return; }
    api.financePayments.bankAccounts.list(form.payingStoreId).then(setFormBankAccounts).catch(() => {});
  }, [showForm, form.payingStoreId]);

  const activeStores = useMemo(() => stores.filter((s) => s.isActive), [stores]);

  const openCreateForm = () => {
    setForm({ ...emptyForm, payingStoreId: activeStores[0]?.id ?? null });
    setAllocRows(activeStores.map((s) => ({
      storeId: s.id, checked: true,
      percent: (100 / Math.max(activeStores.length, 1)).toFixed(2),
      value: "",
    })));
    setShowForm(true);
  };

  const totalAmountNum = Number(form.totalAmount.replace(",", ".")) || 0;
  const checkedRows = allocRows.filter((r) => r.checked);
  const percentSum = checkedRows.reduce((s, r) => s + (Number(r.percent.replace(",", ".")) || 0), 0);
  const valueSum = checkedRows.reduce((s, r) => s + (Number(r.value.replace(",", ".")) || 0), 0);

  const handleSave = async () => {
    if (saving) return;
    if (!form.description.trim()) { toast({ title: "Informe a descrição", variant: "destructive" }); return; }
    const payingStoreId = form.payingStoreId;
    const payingBankAccountId = form.payingBankAccountId;
    if (!payingStoreId || !payingBankAccountId) { toast({ title: "Selecione a filial e o banco pagador", variant: "destructive" }); return; }
    if (!totalAmountNum || totalAmountNum <= 0) { toast({ title: "Informe o valor total", variant: "destructive" }); return; }

    let allocations: { storeId: number; percent?: number | null; amount?: number | null }[];
    if (form.splitType === "direta") {
      const directStoreId = form.directStoreId;
      if (!directStoreId) { toast({ title: "Selecione a filial de destino", variant: "destructive" }); return; }
      allocations = [{ storeId: directStoreId, amount: totalAmountNum, percent: 1 }];
    } else {
      if (checkedRows.length === 0) { toast({ title: "Selecione ao menos uma filial no rateio", variant: "destructive" }); return; }
      if (form.splitMode === "value" && Math.abs(valueSum - totalAmountNum) > 0.01) {
        toast({ title: "A soma dos valores por filial precisa bater com o valor total", variant: "destructive" }); return;
      }
      allocations = checkedRows.map((r) => ({
        storeId: r.storeId,
        percent: form.splitMode === "percent" ? (Number(r.percent.replace(",", ".")) || 0) / 100 : null,
        amount: form.splitMode === "value" ? (Number(r.value.replace(",", ".")) || 0) : null,
      }));
    }

    setSaving(true);
    try {
      const created = await api.financePayments.create({
        paymentDate: form.paymentDate,
        description: form.description.trim(),
        supplier: form.supplier.trim() || undefined,
        payingBankAccountId,
        payingStoreId,
        splitType: form.splitType,
        splitMode: form.splitMode,
        totalAmount: totalAmountNum,
        allocations,
      });
      setPayments((prev) => [created, ...prev]);
      setShowForm(false);
      toast({ title: "Pagamento lançado" });
      load();
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const toggleStatus = async (p: FinancePayment) => {
    const nextStatus = p.status === "pago" ? "aberto" : "pago";
    try {
      const updated = await api.financePayments.update(p.id, { status: nextStatus });
      setPayments((prev) => prev.map((x) => x.id === p.id ? updated : x));
      load();
    } catch { toast({ title: "Erro ao atualizar status", variant: "destructive" }); }
  };

  const handleDelete = async (p: FinancePayment) => {
    if (!window.confirm(`Excluir o lançamento "${p.description}"?`)) return;
    try {
      await api.financePayments.remove(p.id);
      setPayments((prev) => prev.filter((x) => x.id !== p.id));
      load();
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const handleSaveBank = async () => {
    if (savingBank) return;
    const bankStoreId = bankForm.storeId;
    if (!bankStoreId || !bankForm.bankName.trim()) { toast({ title: "Selecione a filial e informe o banco", variant: "destructive" }); return; }
    setSavingBank(true);
    try {
      const created = await api.financePayments.bankAccounts.create({
        storeId: bankStoreId, bankName: bankForm.bankName.trim(), label: bankForm.label.trim() || undefined,
      });
      setBankAccounts((prev) => [...prev, created]);
      setBankForm({ storeId: bankStoreId, bankName: "", label: "" });
      toast({ title: "Conta bancária cadastrada" });
    } catch (err) {
      toast({ title: "Erro ao cadastrar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSavingBank(false); }
  };

  const totals = payments.reduce((t, p) => ({
    pago: t.pago + (p.status === "pago" ? num(p.totalAmount) : 0),
    aberto: t.aberto + (p.status === "aberto" ? num(p.totalAmount) : 0),
  }), { pago: 0, aberto: 0 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-primary" /> Pagamentos entre Filiais
        </h2>
        <div className="flex items-center gap-2">
          <a href={api.financePayments.exportUrl({ storeId: filterStoreId, status: filterStatus || null })}
            download="pagamentos-entre-filiais.xlsx" data-testid="button-export-excel"
            className="flex items-center gap-1 px-3 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary">
            <FileSpreadsheet className="w-3.5 h-3.5" /> Exportar Excel
          </a>
          {canManage && (
            <button onClick={() => setShowBankForm(true)} data-testid="button-manage-bank-accounts"
              className="flex items-center gap-1 px-3 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary">
              <Landmark className="w-3.5 h-3.5" /> Contas bancárias
            </button>
          )}
          {canManage && (
            <button onClick={openCreateForm} data-testid="button-new-payment"
              className="flex items-center gap-1 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
              <Plus className="w-3.5 h-3.5" /> Novo pagamento
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Registre aqui os pagamentos feitos por uma filial (normalmente a Matriz) em nome da rede e o rateio entre
        as filiais beneficiadas — substitui a planilha de controle de pagamentos.
      </p>

      {/* ─── Cards de totais ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="shk-card p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase">Pago no filtro atual</p>
          <p className="text-xl font-extrabold text-primary mt-1">{brl(totals.pago)}</p>
        </div>
        <div className="shk-card p-4">
          <p className="text-[10px] font-bold text-muted-foreground uppercase">Em aberto no filtro atual</p>
          <p className="text-xl font-extrabold text-amber-600 mt-1">{brl(totals.aberto)}</p>
        </div>
        {summary && summary.stores.slice(0, 2).map((s) => (
          <div key={s.storeId} className="shk-card p-4">
            <p className="text-[10px] font-bold text-muted-foreground uppercase truncate">{s.storeName}</p>
            <p className="text-sm font-bold mt-1">{brl(s.pago)} <span className="text-[10px] text-muted-foreground font-normal">pago</span></p>
            <p className="text-[10px] text-amber-600">{brl(s.aberto)} em aberto</p>
          </div>
        ))}
      </div>

      {summary && summary.stores.length > 0 && (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="shk-card p-4 overflow-x-auto">
            <p className="font-bold text-sm mb-3">Recebido por filial (rateio)</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border">
                  <th className="py-2 pr-2">Filial</th>
                  <th className="py-2 pr-2 text-right">Pago</th>
                  <th className="py-2 pr-2 text-right">Em aberto</th>
                </tr>
              </thead>
              <tbody>
                {summary.stores.map((s) => (
                  <tr key={s.storeId} className="border-b border-border/50">
                    <td className="py-2 pr-2 font-semibold">{s.storeName}</td>
                    <td className="py-2 pr-2 text-right text-primary font-bold">{brl(s.pago)}</td>
                    <td className="py-2 pr-2 text-right text-amber-600">{brl(s.aberto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="shk-card p-4" data-testid="chart-payments-by-store">
            <p className="font-bold text-sm mb-3">Pago vs. em aberto por filial</p>
            <ChartContainer config={CHART_CONFIG} className="w-full aspect-auto h-56">
              <BarChart data={summary.stores.map((s) => ({ name: s.storeName, pago: s.pago, aberto: s.aberto }))}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10 }}
                  interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} width={40} />
                <ChartTooltip content={<ChartTooltipContent formatter={(v) => brl(Number(v))} />} />
                <Bar dataKey="pago" fill="var(--color-pago)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="aberto" fill="var(--color-aberto)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </div>
        </div>
      )}

      {/* ─── Filtros ─── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-muted-foreground" />
        <select value={filterStoreId ?? ""} onChange={(e) => setFilterStoreId(e.target.value ? Number(e.target.value) : null)}
          data-testid="select-filter-store" className="px-3 py-2 rounded-xl border border-border text-xs">
          <option value="">Todas as filiais</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as "" | "aberto" | "pago")}
          data-testid="select-filter-status" className="px-3 py-2 rounded-xl border border-border text-xs">
          <option value="">Todos os status</option>
          <option value="aberto">Em aberto</option>
          <option value="pago">Pago</option>
        </select>
      </div>

      {/* ─── Tabela de pagamentos ─── */}
      <div className="shk-card p-4 overflow-x-auto">
        <p className="font-bold text-sm mb-3">Lançamentos {loading && <span className="text-[10px] text-muted-foreground font-normal">carregando...</span>}</p>
        {!loading && payments.length === 0 && (
          <p className="text-xs text-muted-foreground">Nenhum pagamento lançado com esse filtro.</p>
        )}
        {payments.length > 0 && (
          <table className="w-full text-xs" data-testid="table-finance-payments">
            <thead>
              <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border">
                <th className="py-2 pr-2">Data</th>
                <th className="py-2 pr-2">Descrição</th>
                <th className="py-2 pr-2">Fornecedor</th>
                <th className="py-2 pr-2">Banco / Filial pagadora</th>
                <th className="py-2 pr-2">Rateio</th>
                <th className="py-2 pr-2 text-right">Valor</th>
                <th className="py-2 pr-2">Status</th>
                {canManage && <th className="py-2 pr-2" />}
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/40" data-testid={`payment-row-${p.id}`}>
                  <td className="py-2 pr-2 whitespace-nowrap">{new Date(p.paymentDate).toLocaleDateString("pt-BR")}</td>
                  <td className="py-2 pr-2 font-semibold max-w-[180px] truncate" title={p.description}>{p.description}</td>
                  <td className="py-2 pr-2 text-muted-foreground">{p.supplier ?? "—"}</td>
                  <td className="py-2 pr-2 whitespace-nowrap">{bankLabel(p.payingBankAccountId)}<br /><span className="text-muted-foreground">{storeName(p.payingStoreId)}</span></td>
                  <td className="py-2 pr-2">
                    {p.allocations.map((a) => (
                      <div key={a.storeId} className="whitespace-nowrap">{storeName(a.storeId)}: <b>{brl(num(a.amount))}</b></div>
                    ))}
                  </td>
                  <td className="py-2 pr-2 text-right font-bold text-primary whitespace-nowrap">{brl(num(p.totalAmount))}</td>
                  <td className="py-2 pr-2">
                    <button onClick={() => canManage && toggleStatus(p)} disabled={!canManage}
                      data-testid={`button-toggle-status-${p.id}`}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold ${p.status === "pago" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                      {p.status === "pago" ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                      {p.status === "pago" ? "Pago" : "Em aberto"}
                    </button>
                  </td>
                  {canManage && (
                    <td className="py-2 pr-2">
                      <button onClick={() => handleDelete(p)} title="Excluir" className="p-1.5 rounded-lg hover:bg-red-50 text-red-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Modal: novo pagamento ─── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg p-6 my-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">Novo pagamento</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Data</label>
                  <input type="date" value={form.paymentDate} onChange={(e) => setForm((f) => ({ ...f, paymentDate: e.target.value }))}
                    data-testid="input-payment-date" className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Valor total (R$)</label>
                  <input type="text" inputMode="decimal" value={form.totalAmount} onChange={(e) => setForm((f) => ({ ...f, totalAmount: e.target.value }))}
                    placeholder="0,00" data-testid="input-payment-total" className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Descrição</label>
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Ex.: Compra de peças" data-testid="input-payment-description" className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Fornecedor (opcional)</label>
                <input value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))}
                  data-testid="input-payment-supplier" className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Filial pagadora</label>
                  <select value={form.payingStoreId ?? ""} onChange={(e) => setForm((f) => ({ ...f, payingStoreId: e.target.value ? Number(e.target.value) : null, payingBankAccountId: null }))}
                    data-testid="select-paying-store" className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    <option value="">Selecione</option>
                    {activeStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Banco pagador</label>
                  <select value={form.payingBankAccountId ?? ""} onChange={(e) => setForm((f) => ({ ...f, payingBankAccountId: e.target.value ? Number(e.target.value) : null }))}
                    data-testid="select-paying-bank" className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    <option value="">Selecione</option>
                    {formBankAccounts.map((b) => <option key={b.id} value={b.id}>{b.label ? `${b.bankName} (${b.label})` : b.bankName}</option>)}
                  </select>
                  {form.payingStoreId && formBankAccounts.length === 0 && (
                    <p className="text-[10px] text-amber-600 mt-1">Nenhuma conta cadastrada pra essa filial ainda.</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="radio" checked={form.splitType === "rateada"} onChange={() => setForm((f) => ({ ...f, splitType: "rateada" }))} />
                  Rateada entre filiais
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="radio" checked={form.splitType === "direta"} onChange={() => setForm((f) => ({ ...f, splitType: "direta" }))} />
                  Direta (100% pra uma filial)
                </label>
              </div>

              {form.splitType === "direta" ? (
                <div>
                  <label className="text-xs font-medium mb-1 block">Filial de destino</label>
                  <select value={form.directStoreId ?? ""} onChange={(e) => setForm((f) => ({ ...f, directStoreId: e.target.value ? Number(e.target.value) : null }))}
                    data-testid="select-direct-store" className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    <option value="">Selecione</option>
                    {activeStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="radio" checked={form.splitMode === "percent"} onChange={() => setForm((f) => ({ ...f, splitMode: "percent" }))} />
                      Por %
                    </label>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="radio" checked={form.splitMode === "value"} onChange={() => setForm((f) => ({ ...f, splitMode: "value" }))} />
                      Por valor (R$)
                    </label>
                  </div>
                  <div className="rounded-xl border border-border divide-y divide-border">
                    {allocRows.map((row, i) => (
                      <div key={row.storeId} className="flex items-center gap-2 px-3 py-2">
                        <input type="checkbox" checked={row.checked}
                          onChange={(e) => setAllocRows((rows) => rows.map((r, idx) => idx === i ? { ...r, checked: e.target.checked } : r))} />
                        <span className="flex-1 text-xs font-medium">{storeName(row.storeId)}</span>
                        {form.splitMode === "percent" ? (
                          <input type="text" inputMode="decimal" disabled={!row.checked} value={row.percent}
                            onChange={(e) => setAllocRows((rows) => rows.map((r, idx) => idx === i ? { ...r, percent: e.target.value } : r))}
                            className="w-20 px-2 py-1 rounded-lg border border-border text-xs text-right disabled:opacity-40" />
                        ) : (
                          <input type="text" inputMode="decimal" disabled={!row.checked} value={row.value}
                            onChange={(e) => setAllocRows((rows) => rows.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r))}
                            className="w-24 px-2 py-1 rounded-lg border border-border text-xs text-right disabled:opacity-40" />
                        )}
                        <span className="text-[10px] text-muted-foreground w-4">{form.splitMode === "percent" ? "%" : ""}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {form.splitMode === "percent"
                      ? `Soma: ${percentSum.toFixed(2)}% (não precisa fechar em 100% exato — os centavos são ajustados automaticamente)`
                      : `Soma: ${brl(valueSum)} de ${brl(totalAmountNum)}`}
                  </p>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button onClick={handleSave} disabled={saving} data-testid="button-save-payment"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {saving ? "Salvando..." : "Salvar pagamento"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: contas bancárias ─── */}
      {showBankForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-md p-6 my-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">Contas bancárias por filial</h3>
              <button onClick={() => setShowBankForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <div className="rounded-xl border border-border divide-y divide-border">
                {bankAccounts.length === 0 && <p className="text-xs text-muted-foreground p-3">Nenhuma conta cadastrada ainda.</p>}
                {bankAccounts.map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <div>
                      <p className="font-semibold">{b.bankName}{b.label ? ` (${b.label})` : ""}</p>
                      <p className="text-muted-foreground">{storeName(b.storeId)}</p>
                    </div>
                    <button onClick={() => api.financePayments.bankAccounts.update(b.id, { isActive: !b.isActive })
                      .then((upd) => setBankAccounts((prev) => prev.map((x) => x.id === b.id ? upd : x)))}
                      className={`px-2 py-1 rounded-lg text-[10px] font-semibold ${b.isActive ? "bg-green-100 text-green-700" : "bg-secondary text-muted-foreground"}`}>
                      {b.isActive ? "Ativa" : "Inativa"}
                    </button>
                  </div>
                ))}
              </div>
              <div className="pt-2 border-t border-border space-y-2">
                <p className="text-xs font-semibold">Nova conta</p>
                <select value={bankForm.storeId ?? ""} onChange={(e) => setBankForm((f) => ({ ...f, storeId: e.target.value ? Number(e.target.value) : null }))}
                  data-testid="select-bank-store" className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  <option value="">Selecione a filial</option>
                  {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={bankForm.bankName} onChange={(e) => setBankForm((f) => ({ ...f, bankName: e.target.value }))}
                  placeholder="Nome do banco (ex.: Itaú, Inter, PagSeguro)" data-testid="input-bank-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                <input value={bankForm.label} onChange={(e) => setBankForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Apelido (opcional, ex.: Maquininha loja)" data-testid="input-bank-label"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                <button onClick={handleSaveBank} disabled={savingBank} data-testid="button-save-bank"
                  className="w-full px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                  {savingBank ? "Salvando..." : "Adicionar conta"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
