import { useState, useEffect, useCallback } from "react";
import {
  api, canEditModule,
  type TvBoxClient, type TvBoxClientStatus, type TvBoxInvoice, type TvBoxOverview, type TvBoxSettings,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Tv, Plus, X, Pencil, Settings as SettingsIcon, RefreshCw,
  AlertCircle, CheckCircle2, Clock, Ban, History,
} from "lucide-react";

const brl = (cents: number): string =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
};

const CLIENT_STATUS_META: Record<TvBoxClientStatus, { label: string; color: string }> = {
  ativo: { label: "Ativo", color: "bg-green-100 text-green-700 border-green-200" },
  suspenso: { label: "Suspenso", color: "bg-amber-100 text-amber-700 border-amber-200" },
  cancelado: { label: "Cancelado", color: "bg-slate-100 text-slate-500 border-slate-200" },
};

const INVOICE_STATUS_META: Record<TvBoxInvoice["status"], { label: string; color: string }> = {
  pendente: { label: "Pendente", color: "bg-amber-100 text-amber-700 border-amber-200" },
  pago: { label: "Pago", color: "bg-green-100 text-green-700 border-green-200" },
  cancelado: { label: "Cancelado", color: "bg-slate-100 text-slate-500 border-slate-200" },
};

type ClientFormData = {
  name: string; phone: string; monthlyValue: string; dueDay: string; notes: string; status: TvBoxClientStatus;
};
const emptyClientForm: ClientFormData = { name: "", phone: "", monthlyValue: "", dueDay: "10", notes: "", status: "ativo" };

const centsFromInput = (v: string): number => Math.round(Number(v.replace(/\./g, "").replace(",", ".")) * 100);

export default function TvBox() {
  const { user } = useAuth();
  const canEdit = canEditModule(user, "tvbox");
  const { toast } = useToast();

  const [clients, setClients] = useState<TvBoxClient[]>([]);
  const [overview, setOverview] = useState<TvBoxOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<TvBoxClient | null>(null);
  const [form, setForm] = useState<ClientFormData>(emptyClientForm);
  const [saving, setSaving] = useState(false);

  const [detailClient, setDetailClient] = useState<TvBoxClient | null>(null);
  const [invoices, setInvoices] = useState<TvBoxInvoice[]>([]);

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<TvBoxSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [c, o] = await Promise.all([api.tvbox.clients.list(), api.tvbox.overview()]);
      setClients(c);
      setOverview(o);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setLoading(true); void fetchAll(); }, [fetchAll]);

  const openAdd = () => { setEditTarget(null); setForm(emptyClientForm); setShowForm(true); };
  const openEdit = (c: TvBoxClient) => {
    setEditTarget(c);
    setForm({
      name: c.name, phone: c.phone,
      monthlyValue: (c.monthlyValueCents / 100).toFixed(2).replace(".", ","),
      dueDay: String(c.dueDay), notes: c.notes ?? "", status: c.status,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || saving) return;
    const monthlyValueCents = centsFromInput(form.monthlyValue);
    const dueDay = Number(form.dueDay);
    if (!Number.isFinite(monthlyValueCents) || monthlyValueCents <= 0) {
      toast({ title: "Valor da mensalidade inválido", variant: "destructive" }); return;
    }
    if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 28) {
      toast({ title: "Dia de vencimento deve ser entre 1 e 28", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      if (editTarget) {
        const updated = await api.tvbox.clients.update(editTarget.id, {
          name: form.name.trim(), phone: form.phone.trim(), monthlyValueCents, dueDay,
          notes: form.notes.trim(), status: form.status,
        });
        setClients((prev) => prev.map((c) => c.id === editTarget.id ? { ...c, ...updated } : c));
        toast({ title: "Cliente atualizado!" });
      } else {
        const created = await api.tvbox.clients.create({
          name: form.name.trim(), phone: form.phone.trim(), monthlyValueCents, dueDay, notes: form.notes.trim(),
        });
        setClients((prev) => [...prev, { ...created, pendingInvoice: null, overdue: false, daysLate: 0 }].sort((a, b) => a.name.localeCompare(b.name)));
        toast({ title: "Cliente cadastrado!" });
      }
      setShowForm(false);
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const openDetail = async (c: TvBoxClient) => {
    setDetailClient(c);
    setInvoices([]);
    try { setInvoices(await api.tvbox.invoices.list(c.id)); } catch { /* modal fica vazio */ }
  };

  const markInvoice = async (inv: TvBoxInvoice, status: "pago" | "cancelado") => {
    try {
      const updated = await api.tvbox.invoices.update(inv.id, status);
      setInvoices((prev) => prev.map((i) => i.id === inv.id ? updated : i));
      void fetchAll();
      toast({ title: status === "pago" ? "Fatura marcada como paga" : "Fatura cancelada" });
    } catch { toast({ title: "Erro ao atualizar fatura", variant: "destructive" }); }
  };

  const openSettings = async () => {
    setShowSettings(true);
    setSettings(null);
    try { setSettings(await api.tvbox.settings.get()); }
    catch { toast({ title: "Erro ao carregar configurações", variant: "destructive" }); }
  };

  const saveSettings = async () => {
    if (!settings || savingSettings) return;
    setSavingSettings(true);
    try {
      const updated = await api.tvbox.settings.update(settings);
      setSettings(updated);
      toast({ title: "Configurações salvas!" });
      setShowSettings(false);
    } catch { toast({ title: "Erro ao salvar configurações", variant: "destructive" }); }
    finally { setSavingSettings(false); }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const { created } = await api.tvbox.invoices.generate();
      toast({ title: created > 0 ? `${created} fatura(s) gerada(s)` : "Nenhuma fatura nova (já geradas este mês)" });
      void fetchAll();
    } catch { toast({ title: "Erro ao gerar faturas", variant: "destructive" }); }
    finally { setGenerating(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-bold text-foreground flex items-center gap-2">
            <Tv className="w-5 h-5 text-primary" /> TV Box
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Assinantes da TV Box (Uni TV): mensalidade, vencimento e cobrança automática</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && (
            <button onClick={openSettings} data-testid="button-tvbox-settings"
              className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-xl text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
              <SettingsIcon className="w-3.5 h-3.5" /> Mensagens
            </button>
          )}
          {canEdit && (
            <button onClick={handleGenerate} disabled={generating} data-testid="button-tvbox-generate"
              className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-xl text-xs font-semibold text-muted-foreground hover:bg-secondary transition disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${generating ? "animate-spin" : ""}`} /> Gerar faturas do mês
            </button>
          )}
          {canEdit && (
            <button onClick={openAdd} data-testid="button-tvbox-add"
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
              <Plus className="w-3.5 h-3.5" /> Novo cliente
            </button>
          )}
        </div>
      </div>

      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Clientes ativos", value: String(overview.activeClients), color: "text-foreground" },
            { label: "Pendente", value: brl(overview.pendingCents), sub: `${overview.pendingCount} fatura(s)`, color: "text-amber-600" },
            { label: "Atrasado", value: brl(overview.overdueCents), sub: `${overview.overdueCount} fatura(s)`, color: "text-red-600" },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="bg-white rounded-xl border border-border p-3 text-center">
              <p className={`text-lg font-bold ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
              {sub && <p className="text-[10px] text-muted-foreground/70">{sub}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-muted-foreground">Carregando...</div>
        ) : clients.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">
            <Tv className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-semibold">Nenhum cliente cadastrado ainda</p>
            {canEdit && <p className="text-xs mt-1">Clique em "Novo cliente" para começar.</p>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-2.5 font-semibold">Cliente</th>
                  <th className="px-4 py-2.5 font-semibold">Mensalidade</th>
                  <th className="px-4 py-2.5 font-semibold">Vencimento</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-secondary/30 transition" data-testid={`tvbox-client-${c.id}`}>
                    <td className="px-4 py-2.5">
                      <p className="font-semibold truncate max-w-[220px]">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{c.phone}</p>
                    </td>
                    <td className="px-4 py-2.5">{brl(c.monthlyValueCents)}</td>
                    <td className="px-4 py-2.5">dia {c.dueDay}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 items-start">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${CLIENT_STATUS_META[c.status].color}`}>
                          {CLIENT_STATUS_META[c.status].label}
                        </span>
                        {c.overdue && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 border border-red-200">
                            <AlertCircle className="w-2.5 h-2.5" /> Atrasado {c.daysLate}d
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openDetail(c)} title="Histórico de faturas" data-testid={`button-tvbox-history-${c.id}`}
                          className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
                          <History className="w-3.5 h-3.5" />
                        </button>
                        {canEdit && (
                          <button onClick={() => openEdit(c)} title="Editar" data-testid={`button-tvbox-edit-${c.id}`}
                            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: novo/editar cliente */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editTarget ? "Editar cliente" : "Novo cliente"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome *</label>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  data-testid="input-tvbox-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Telefone (WhatsApp) *</label>
                <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="(11) 91234-5678" data-testid="input-tvbox-phone"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Mensalidade (R$) *</label>
                  <input required value={form.monthlyValue} onChange={(e) => setForm({ ...form, monthlyValue: e.target.value })}
                    placeholder="Ex.: 39,90" data-testid="input-tvbox-value"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Dia do vencimento *</label>
                  <input required type="number" min={1} max={28} value={form.dueDay}
                    onChange={(e) => setForm({ ...form, dueDay: e.target.value })} data-testid="input-tvbox-dueday"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
              </div>
              {editTarget && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as TvBoxClientStatus })}
                    data-testid="select-tvbox-status"
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    {(Object.keys(CLIENT_STATUS_META) as TvBoxClientStatus[]).map((s) => (
                      <option key={s} value={s}>{CLIENT_STATUS_META[s].label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs font-medium mb-1 block">Observações</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2} className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
                  Cancelar
                </button>
                <button type="submit" disabled={saving} data-testid="button-tvbox-save"
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
                  {saving ? "Salvando..." : editTarget ? "Salvar" : "Cadastrar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: histórico de faturas */}
      {detailClient && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDetailClient(null)}>
          <div className="shk-card w-full max-w-md p-5 max-h-[90vh] overflow-y-auto space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-bold text-sm">{detailClient.name}</h3>
                <p className="text-xs text-muted-foreground">{detailClient.phone} · {brl(detailClient.monthlyValueCents)}/mês · dia {detailClient.dueDay}</p>
              </div>
              <button onClick={() => setDetailClient(null)}><X className="w-5 h-5 text-muted-foreground shrink-0" /></button>
            </div>
            <div className="space-y-2">
              {invoices.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">Nenhuma fatura ainda.</p>
              )}
              {invoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between gap-2 border border-border rounded-xl px-3 py-2" data-testid={`tvbox-invoice-${inv.id}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{brl(inv.amountCents)}</p>
                    <p className="text-[11px] text-muted-foreground">Vencimento {fmtDate(inv.dueDate)}{inv.status === "pago" && inv.paidAt ? ` · pago em ${fmtDate(inv.paidAt)}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${INVOICE_STATUS_META[inv.status].color}`}>
                      {inv.overdue ? <Clock className="w-2.5 h-2.5" /> : inv.status === "pago" ? <CheckCircle2 className="w-2.5 h-2.5" /> : null}
                      {inv.overdue ? "Atrasada" : INVOICE_STATUS_META[inv.status].label}
                    </span>
                    {canEdit && inv.status === "pendente" && (
                      <>
                        <button onClick={() => markInvoice(inv, "pago")} title="Marcar como pago" data-testid={`button-tvbox-invoice-pay-${inv.id}`}
                          className="p-1 rounded-lg hover:bg-green-50 text-green-600">
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                        <button onClick={() => markInvoice(inv, "cancelado")} title="Cancelar fatura" data-testid={`button-tvbox-invoice-cancel-${inv.id}`}
                          className="p-1 rounded-lg hover:bg-red-50 text-red-400">
                          <Ban className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modal: configurações de mensagem */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowSettings(false)}>
          <div className="shk-card w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold flex items-center gap-2"><SettingsIcon className="w-4 h-4 text-primary" /> Mensagens automáticas</h3>
              <button onClick={() => setShowSettings(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            {!settings ? (
              <div className="h-40 rounded-xl bg-secondary/40 animate-pulse" />
            ) : (
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={settings.enabled}
                    onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} />
                  Enviar lembrete e cobrança automaticamente
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium mb-1 block">Lembrete: dias antes do vencimento</label>
                    <input type="number" min={1} max={27} value={settings.reminderDaysBefore}
                      onChange={(e) => setSettings({ ...settings, reminderDaysBefore: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block">Cobrança: intervalo entre reenvios (dias)</label>
                    <input type="number" min={1} max={30} value={settings.overdueMessageIntervalDays}
                      onChange={(e) => setSettings({ ...settings, overdueMessageIntervalDays: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Placeholders disponíveis: <code>{"{nome}"}</code>, <code>{"{valor}"}</code>, <code>{"{vencimento}"}</code>, <code>{"{dias}"}</code>
                </p>
                <div>
                  <label className="text-xs font-medium mb-1 block">Mensagem de lembrete (antes do vencimento)</label>
                  <textarea value={settings.reminderMessageTemplate} rows={4}
                    onChange={(e) => setSettings({ ...settings, reminderMessageTemplate: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Mensagem de cobrança (após o vencimento)</label>
                  <textarea value={settings.chargeMessageTemplate} rows={4}
                    onChange={(e) => setSettings({ ...settings, chargeMessageTemplate: e.target.value })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => setShowSettings(false)}
                    className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
                    Cancelar
                  </button>
                  <button onClick={saveSettings} disabled={savingSettings} data-testid="button-tvbox-settings-save"
                    className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
                    {savingSettings ? "Salvando..." : "Salvar"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
