import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  api,
  type TenantSummary,
  type SaasContract,
  type SaasInvoice,
  type SaasTicket,
  type SaasOverview,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, LogOut, Plus, Users, MessageSquare, Smartphone, KeyRound, Ban,
  CheckCircle2, DollarSign, FileText, Wrench, Pencil, AlertTriangle, Trash2,
} from "lucide-react";

// Painel do superadmin (dono do sistema): lojistas, financeiro do SaaS
// (mensalidades), contratos de aluguel e chamados de suporte.
// Nenhum dado operacional das lojas aparece aqui.

const brl = (cents: number): string =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
};

// Dias até a renovação (data no formato "YYYY-MM-DD"); null se sem data.
const daysUntil = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const target = new Date(d.slice(0, 10) + "T00:00:00");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
};

// Badge "Renova em X dias" para contratos que renovam nos próximos 30 dias
// (ou já venceram). Contratos distantes não recebem destaque.
const renewalBadge = (renewalDate: string | null | undefined) => {
  const days = daysUntil(renewalDate);
  if (days === null || days > 30) return null;
  if (days < 0) return <Badge variant="destructive">Renovação vencida há {-days} dia{-days === 1 ? "" : "s"}</Badge>;
  if (days === 0) return <Badge variant="destructive">Renova hoje</Badge>;
  return (
    <Badge variant="outline" className="border-amber-500 text-amber-600">
      Renova em {days} dia{days === 1 ? "" : "s"}
    </Badge>
  );
};

type Tab = "lojistas" | "financeiro" | "contratos" | "suporte";

const TABS: { id: Tab; label: string; icon: typeof Building2 }[] = [
  { id: "lojistas", label: "Lojistas", icon: Building2 },
  { id: "financeiro", label: "Financeiro", icon: DollarSign },
  { id: "contratos", label: "Contratos", icon: FileText },
  { id: "suporte", label: "Suporte", icon: Wrench },
];

export default function SuperAdminDashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("lojistas");
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [overview, setOverview] = useState<SaasOverview | null>(null);
  const [invoices, setInvoices] = useState<SaasInvoice[]>([]);
  const [contracts, setContracts] = useState<SaasContract[]>([]);
  const [tickets, setTickets] = useState<SaasTicket[]>([]);
  const [template, setTemplate] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Diálogos
  const [createOpen, setCreateOpen] = useState(false);
  const [adminFor, setAdminFor] = useState<TenantSummary | null>(null);
  const [contactFor, setContactFor] = useState<TenantSummary | null>(null);
  const [contractFor, setContractFor] = useState<TenantSummary | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  const [form, setForm] = useState({ name: "", adminName: "", adminEmail: "", adminPassword: "" });
  const [adminForm, setAdminForm] = useState({ name: "", email: "", password: "" });
  const [contactForm, setContactForm] = useState({ contactName: "", contactPhone: "", contactEmail: "" });
  const [contractForm, setContractForm] = useState({ plan: "Mensal", monthlyValue: "", startDate: "", renewalDate: "", notes: "" });
  const [invoiceForm, setInvoiceForm] = useState({ tenantId: "", description: "Mensalidade", amount: "", dueDate: "" });
  const [ticketForm, setTicketForm] = useState({ tenantId: "", title: "", description: "" });

  const fail = (title: string) => (e: unknown) =>
    toast({ title, description: (e as Error).message, variant: "destructive" });

  const loadAll = useCallback(() => {
    Promise.all([
      api.superadmin.listTenants().then((r) => setTenants(r.tenants)),
      api.superadmin.saasOverview().then(setOverview),
      api.superadmin.listInvoices().then((r) => setInvoices(r.invoices)),
      api.superadmin.listContracts().then((r) => setContracts(r.contracts)),
      api.superadmin.listTickets().then((r) => setTickets(r.tickets)),
      api.superadmin.getContractTemplate().then((r) => setTemplate(r.template)),
    ])
      .catch(fail("Erro ao carregar dados"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(loadAll, [loadAll]);

  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      // `after` costuma fechar um Dialog (Radix desmonta o portal com
      // animação). Se o toast novo e o reload da lista de lojistas
      // commitam no mesmo tick que esse unmount, o React tenta remover um
      // nó que o Radix já tirou da árvore sozinho e quebra com
      // "Failed to execute 'removeChild'" (tela em branco). Adiar pro
      // próximo tick deixa o fechamento do Dialog commitar isolado.
      after?.();
      setTimeout(() => {
        toast({ title: ok });
        loadAll();
      }, 0);
    } catch (e) {
      fail("Erro")(e);
    } finally { setBusy(false); }
  };

  const statusBadge = (t: TenantSummary) => {
    if (t.saasStatus === "cancelado") return <Badge variant="outline" className="text-muted-foreground">Cancelado</Badge>;
    if (t.saasStatus === "inadimplente") return <Badge variant="destructive">Inadimplente</Badge>;
    return <Badge variant="secondary" className="text-green-700">Ativo</Badge>;
  };

  const activeTenants = tenants.filter((t) => t.saasStatus !== "cancelado");

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="w-6 h-6 text-primary" />
          <div>
            <h1 className="font-bold leading-tight">Painel do Sistema</h1>
            <p className="text-xs text-muted-foreground">Dono do sistema · {user?.name}</p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={logout} data-testid="button-logout">
          <LogOut className="w-4 h-4" />
        </Button>
      </header>

      <nav className="border-b bg-card px-4 flex gap-1 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 whitespace-nowrap ${tab === id ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            data-testid={`tab-${id}`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </nav>

      <main className="p-4 max-w-6xl mx-auto space-y-4">
        {loading ? (
          <p className="text-muted-foreground text-sm">Carregando...</p>
        ) : (
          <>
            {/* ------------------------------------------------ LOJISTAS */}
            {tab === "lojistas" && (
              <>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-tenant">
                    <Plus className="w-4 h-4 mr-1" /> Nova loja
                  </Button>
                </div>
                {tenants.length === 0 && <p className="text-muted-foreground text-sm">Nenhuma loja cadastrada ainda.</p>}
                {tenants.map((t) => (
                  <Card key={t.id} data-testid={`card-tenant-${t.id}`}>
                    <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0 flex-wrap gap-2">
                      <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                        {t.name}
                        {statusBadge(t)}
                        {!t.isActive && <Badge variant="destructive">Acesso suspenso</Badge>}
                        {t.overdueCount > 0 && (
                          <span className="text-xs text-red-600 flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5" /> {t.overdueCount} mensalidade(s) em atraso
                          </span>
                        )}
                      </CardTitle>
                      <div className="flex gap-2 flex-wrap">
                        <Button size="sm" variant="outline" onClick={() => {
                          setContactFor(t);
                          setContactForm({ contactName: t.contactName ?? "", contactPhone: t.contactPhone ?? "", contactEmail: t.contactEmail ?? "" });
                        }} data-testid={`button-contact-${t.id}`}>
                          <Pencil className="w-4 h-4 mr-1" /> Contato
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setAdminFor(t); setAdminForm({ name: "", email: t.admins[0]?.email ?? "", password: "" }); }} data-testid={`button-admin-${t.id}`}>
                          <KeyRound className="w-4 h-4 mr-1" /> Admin
                        </Button>
                        <Button size="sm" variant={t.isActive ? "destructive" : "default"}
                          onClick={() => run(() => api.superadmin.updateTenant(t.id, { isActive: !t.isActive }), t.isActive ? "Loja suspensa" : "Loja reativada")}
                          data-testid={`button-toggle-${t.id}`}>
                          {t.isActive ? <><Ban className="w-4 h-4 mr-1" /> Suspender</> : <><CheckCircle2 className="w-4 h-4 mr-1" /> Reativar</>}
                        </Button>
                        {t.saasStatus !== "cancelado" ? (
                          <Button size="sm" variant="ghost" className="text-muted-foreground"
                            onClick={() => {
                              if (window.confirm(`Cancelar o contrato da loja "${t.name}"? O acesso dela será suspenso.`))
                                void run(() => api.superadmin.updateTenant(t.id, { saasStatus: "cancelado" }), "Contrato cancelado");
                            }}
                            data-testid={`button-cancel-${t.id}`}>
                            Cancelar contrato
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost"
                            onClick={() => run(() => api.superadmin.updateTenant(t.id, { saasStatus: "ativo", isActive: true }), "Lojista reativado")}
                            data-testid={`button-uncancel-${t.id}`}>
                            Reativar contrato
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground space-y-1">
                      <div className="flex flex-wrap gap-4">
                        <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {t.userCount} usuários</span>
                        <span className="flex items-center gap-1"><MessageSquare className="w-4 h-4" /> {t.conversationCount} conversas</span>
                        <span className="flex items-center gap-1"><Smartphone className="w-4 h-4" /> {t.whatsappCount} WhatsApp</span>
                        <span>Cliente desde {fmtDate(t.createdAt)}</span>
                      </div>
                      <div className="flex flex-wrap gap-4">
                        {t.contactName && <span>Contato: {t.contactName}</span>}
                        {t.contactPhone && <span>Tel: {t.contactPhone}</span>}
                        {t.contactEmail && <span>E-mail: {t.contactEmail}</span>}
                        {t.contract && <span>Plano: {t.contract.plan} · {brl(t.contract.monthlyValueCents)}/mês</span>}
                        {t.admins.length > 0 && <span>Admin: {t.admins.map((a) => `${a.name} (${a.email})`).join(", ")}</span>}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}

            {/* ---------------------------------------------- FINANCEIRO */}
            {tab === "financeiro" && overview && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: "Receita mensal (contratos)", value: brl(overview.mrrCents) },
                    { label: "Recebido neste mês", value: brl(overview.paidMonthCents) },
                    { label: "Em atraso", value: brl(overview.overdueCents), sub: `${overview.overdueCount} mensalidade(s)`, red: overview.overdueCount > 0 },
                    { label: "Recebido no total", value: brl(overview.paidTotalCents) },
                    { label: "Contratos renovando no mês", value: String(overview.renewalsMonthCount ?? 0), sub: "renovação neste mês", red: (overview.renewalsMonthCount ?? 0) > 0 },
                  ].map((s) => (
                    <Card key={s.label}>
                      <CardContent className="pt-4">
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                        <p className={`text-xl font-bold ${s.red ? "text-red-600" : ""}`}>{s.value}</p>
                        {s.sub && <p className="text-xs text-muted-foreground">{s.sub}</p>}
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline"
                    onClick={() => run(async () => {
                      const r = await api.superadmin.generateInvoices();
                      toast({ title: r.created > 0 ? `${r.created} mensalidade(s) gerada(s)` : "Todas as mensalidades do mês já existem" });
                    }, "Pronto")}
                    data-testid="button-generate-invoices">
                    Gerar mensalidades do mês
                  </Button>
                  <Button size="sm" onClick={() => setInvoiceOpen(true)} data-testid="button-create-invoice">
                    <Plus className="w-4 h-4 mr-1" /> Nova mensalidade
                  </Button>
                </div>
                {invoices.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nenhuma mensalidade lançada. Cadastre os contratos e use "Gerar mensalidades do mês".</p>
                ) : (
                  <div className="space-y-2">
                    {invoices.map((inv) => (
                      <Card key={inv.id} data-testid={`card-invoice-${inv.id}`}>
                        <CardContent className="py-3 flex items-center justify-between flex-wrap gap-2">
                          <div>
                            <p className="font-medium text-sm">
                              {inv.tenantName} · {inv.description}
                              {inv.status === "paga" && <Badge variant="secondary" className="ml-2 text-green-700">Paga</Badge>}
                              {inv.status === "cancelada" && <Badge variant="outline" className="ml-2">Cancelada</Badge>}
                              {inv.status === "pendente" && (inv.overdue
                                ? <Badge variant="destructive" className="ml-2">Atrasada</Badge>
                                : <Badge variant="outline" className="ml-2">Pendente</Badge>)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {brl(inv.amountCents)} · vence {fmtDate(inv.dueDate)}
                              {inv.paidAt && ` · paga em ${fmtDate(inv.paidAt)}`}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            {inv.status === "pendente" && (
                              <Button size="sm" onClick={() => run(() => api.superadmin.setInvoiceStatus(inv.id, "paga"), "Mensalidade marcada como paga")} data-testid={`button-pay-${inv.id}`}>
                                <CheckCircle2 className="w-4 h-4 mr-1" /> Marcar paga
                              </Button>
                            )}
                            {inv.status === "paga" && (
                              <Button size="sm" variant="outline" onClick={() => run(() => api.superadmin.setInvoiceStatus(inv.id, "pendente"), "Mensalidade reaberta")}>
                                Reabrir
                              </Button>
                            )}
                            {inv.status === "pendente" && (
                              <Button size="sm" variant="ghost" className="text-muted-foreground"
                                onClick={() => run(() => api.superadmin.setInvoiceStatus(inv.id, "cancelada"), "Mensalidade cancelada")}>
                                Cancelar
                              </Button>
                            )}
                            {inv.status === "cancelada" && (
                              <Button size="sm" variant="ghost" className="text-red-600"
                                onClick={() => { if (window.confirm("Apagar esta mensalidade de vez?")) void run(() => api.superadmin.deleteInvoice(inv.id), "Mensalidade apagada"); }}>
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ----------------------------------------------- CONTRATOS */}
            {tab === "contratos" && (
              <>
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <p className="text-sm text-muted-foreground">
                    {overview?.newContractsMonth ? `${overview.newContractsMonth} contrato(s) novo(s) neste mês.` : "Contrato de aluguel de cada lojista."}
                  </p>
                  <Button size="sm" variant="outline" onClick={() => setTemplateOpen(true)} data-testid="button-template">
                    <FileText className="w-4 h-4 mr-1" /> Modelo base do contrato
                  </Button>
                </div>
                {activeTenants.length === 0 && <p className="text-muted-foreground text-sm">Nenhuma loja ativa.</p>}
                {activeTenants.map((t) => {
                  const c = t.contract;
                  return (
                    <Card key={t.id} data-testid={`card-contract-${t.id}`}>
                      <CardContent className="py-3 flex items-center justify-between flex-wrap gap-2">
                        <div>
                          <p className="font-medium text-sm flex items-center gap-2">
                            {t.name} {statusBadge(t)}
                            {c?.isActive !== false && renewalBadge(c?.renewalDate)}
                          </p>
                          {c ? (
                            <p className="text-xs text-muted-foreground">
                              Plano {c.plan} · {brl(c.monthlyValueCents)}/mês · início {fmtDate(c.startDate)} · renovação {fmtDate(c.renewalDate)}
                              {c.notes ? ` · ${c.notes}` : ""}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">Sem contrato cadastrado.</p>
                          )}
                        </div>
                        <Button size="sm" variant="outline" onClick={() => {
                          setContractFor(t);
                          setContractForm({
                            plan: c?.plan ?? "Mensal",
                            monthlyValue: c ? (c.monthlyValueCents / 100).toFixed(2).replace(".", ",") : "",
                            startDate: c?.startDate ?? "",
                            renewalDate: c?.renewalDate ?? "",
                            notes: c?.notes ?? "",
                          });
                        }} data-testid={`button-edit-contract-${t.id}`}>
                          <Pencil className="w-4 h-4 mr-1" /> {c ? "Editar contrato" : "Cadastrar contrato"}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </>
            )}

            {/* ------------------------------------------------- SUPORTE */}
            {tab === "suporte" && (
              <>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setTicketOpen(true)} data-testid="button-create-ticket">
                    <Plus className="w-4 h-4 mr-1" /> Novo chamado
                  </Button>
                </div>
                {tickets.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nenhum chamado registrado.</p>
                ) : (
                  tickets.map((tk) => (
                    <Card key={tk.id} data-testid={`card-ticket-${tk.id}`}>
                      <CardContent className="py-3 flex items-center justify-between flex-wrap gap-2">
                        <div>
                          <p className="font-medium text-sm flex items-center gap-2">
                            {tk.title}
                            {tk.status === "aberto" && <Badge variant="destructive">Aberto</Badge>}
                            {tk.status === "em_andamento" && <Badge variant="outline">Em andamento</Badge>}
                            {tk.status === "resolvido" && <Badge variant="secondary" className="text-green-700">Resolvido</Badge>}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {tk.tenantName} · aberto em {fmtDate(tk.createdAt)}
                            {tk.resolvedAt && ` · resolvido em ${fmtDate(tk.resolvedAt)}`}
                          </p>
                          {tk.description && <p className="text-xs mt-1">{tk.description}</p>}
                        </div>
                        <div className="flex gap-2">
                          {tk.status === "aberto" && (
                            <Button size="sm" variant="outline" onClick={() => run(() => api.superadmin.updateTicket(tk.id, { status: "em_andamento" }), "Chamado em andamento")}>
                              Iniciar
                            </Button>
                          )}
                          {tk.status !== "resolvido" && (
                            <Button size="sm" onClick={() => run(() => api.superadmin.updateTicket(tk.id, { status: "resolvido" }), "Chamado resolvido")} data-testid={`button-resolve-${tk.id}`}>
                              <CheckCircle2 className="w-4 h-4 mr-1" /> Resolver
                            </Button>
                          )}
                          {tk.status === "resolvido" && (
                            <Button size="sm" variant="ghost" onClick={() => run(() => api.superadmin.updateTicket(tk.id, { status: "aberto" }), "Chamado reaberto")}>
                              Reabrir
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Nova loja */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova loja (lojista)</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome da loja</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Celulares do João" data-testid="input-tenant-name" />
            </div>
            <p className="text-xs text-muted-foreground">Opcional: já criar o admin da loja (ele será obrigado a trocar a senha no primeiro acesso).</p>
            <div>
              <Label>Nome do admin</Label>
              <Input value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} data-testid="input-admin-name" />
            </div>
            <div>
              <Label>E-mail do admin</Label>
              <Input type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} data-testid="input-admin-email" />
            </div>
            <div>
              <Label>Senha inicial</Label>
              <Input type="text" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} data-testid="input-admin-password" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button disabled={busy || !form.name.trim()} data-testid="button-save-tenant"
              onClick={() => run(() => api.superadmin.createTenant({
                name: form.name.trim(),
                adminName: form.adminName.trim() || undefined,
                adminEmail: form.adminEmail.trim() || undefined,
                adminPassword: form.adminPassword || undefined,
              }), "Loja criada", () => { setCreateOpen(false); setForm({ name: "", adminName: "", adminEmail: "", adminPassword: "" }); })}>
              Criar loja
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin da loja */}
      <Dialog open={!!adminFor} onOpenChange={(o) => { if (!o) setAdminFor(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Admin da loja {adminFor?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Cria um novo admin ou, se o e-mail já for de um admin desta loja, reseta a senha dele.
            </p>
            <div>
              <Label>Nome</Label>
              <Input value={adminForm.name} onChange={(e) => setAdminForm({ ...adminForm, name: e.target.value })} data-testid="input-upsert-admin-name" />
            </div>
            <div>
              <Label>E-mail</Label>
              <Input type="email" value={adminForm.email} onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })} data-testid="input-upsert-admin-email" />
            </div>
            <div>
              <Label>Nova senha</Label>
              <Input type="text" value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} data-testid="input-upsert-admin-password" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdminFor(null)}>Cancelar</Button>
            <Button disabled={busy || !adminForm.email.trim() || adminForm.password.length < 6} data-testid="button-save-admin"
              onClick={() => adminFor && run(() => api.superadmin.upsertTenantAdmin(adminFor.id, {
                name: adminForm.name.trim() || undefined,
                email: adminForm.email.trim(),
                password: adminForm.password,
              }), "Admin da loja salvo", () => { setAdminFor(null); setAdminForm({ name: "", email: "", password: "" }); })}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Contato do lojista */}
      <Dialog open={!!contactFor} onOpenChange={(o) => { if (!o) setContactFor(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Contato do lojista · {contactFor?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome do responsável</Label>
              <Input value={contactForm.contactName} onChange={(e) => setContactForm({ ...contactForm, contactName: e.target.value })} data-testid="input-contact-name" />
            </div>
            <div>
              <Label>Telefone</Label>
              <Input value={contactForm.contactPhone} onChange={(e) => setContactForm({ ...contactForm, contactPhone: e.target.value })} data-testid="input-contact-phone" />
            </div>
            <div>
              <Label>E-mail</Label>
              <Input type="email" value={contactForm.contactEmail} onChange={(e) => setContactForm({ ...contactForm, contactEmail: e.target.value })} data-testid="input-contact-email" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContactFor(null)}>Cancelar</Button>
            <Button disabled={busy} data-testid="button-save-contact"
              onClick={() => contactFor && run(() => api.superadmin.updateTenant(contactFor.id, {
                contactName: contactForm.contactName,
                contactPhone: contactForm.contactPhone,
                contactEmail: contactForm.contactEmail,
              }), "Contato salvo", () => setContactFor(null))}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Contrato da loja */}
      <Dialog open={!!contractFor} onOpenChange={(o) => { if (!o) setContractFor(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Contrato · {contractFor?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Plano</Label>
                <Input value={contractForm.plan} onChange={(e) => setContractForm({ ...contractForm, plan: e.target.value })} placeholder="Mensal" data-testid="input-contract-plan" />
              </div>
              <div>
                <Label>Valor mensal (R$)</Label>
                <Input value={contractForm.monthlyValue} onChange={(e) => setContractForm({ ...contractForm, monthlyValue: e.target.value })} placeholder="Ex.: 299,90" data-testid="input-contract-value" />
              </div>
              <div>
                <Label>Início</Label>
                <Input type="date" value={contractForm.startDate} onChange={(e) => setContractForm({ ...contractForm, startDate: e.target.value })} data-testid="input-contract-start" />
              </div>
              <div>
                <Label>Renovação</Label>
                <Input type="date" value={contractForm.renewalDate} onChange={(e) => setContractForm({ ...contractForm, renewalDate: e.target.value })} data-testid="input-contract-renewal" />
              </div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea rows={2} value={contractForm.notes} onChange={(e) => setContractForm({ ...contractForm, notes: e.target.value })} data-testid="input-contract-notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContractFor(null)}>Cancelar</Button>
            <Button disabled={busy} data-testid="button-save-contract"
              onClick={() => {
                if (!contractFor) return;
                const cents = Math.round(Number(contractForm.monthlyValue.replace(/\./g, "").replace(",", ".")) * 100);
                if (!Number.isFinite(cents) || cents < 0) { toast({ title: "Valor mensal inválido", variant: "destructive" }); return; }
                void run(() => api.superadmin.saveContract(contractFor.id, {
                  plan: contractForm.plan,
                  monthlyValueCents: cents,
                  startDate: contractForm.startDate || null,
                  renewalDate: contractForm.renewalDate || null,
                  notes: contractForm.notes || null,
                }), "Contrato salvo", () => setContractFor(null));
              }}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modelo base do contrato */}
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Modelo base do contrato de aluguel</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            Texto padrão usado como base para os contratos dos lojistas. Edite à vontade.
          </p>
          <Textarea rows={14} value={template} onChange={(e) => setTemplate(e.target.value)} data-testid="input-template" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>Fechar</Button>
            <Button disabled={busy} data-testid="button-save-template"
              onClick={() => run(() => api.superadmin.saveContractTemplate(template), "Modelo salvo", () => setTemplateOpen(false))}>
              Salvar modelo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova mensalidade */}
      <Dialog open={invoiceOpen} onOpenChange={setInvoiceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova mensalidade</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Loja</Label>
              <Select value={invoiceForm.tenantId} onValueChange={(v) => setInvoiceForm({ ...invoiceForm, tenantId: v })}>
                <SelectTrigger data-testid="select-invoice-tenant"><SelectValue placeholder="Escolha a loja" /></SelectTrigger>
                <SelectContent>
                  {activeTenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Descrição</Label>
              <Input value={invoiceForm.description} onChange={(e) => setInvoiceForm({ ...invoiceForm, description: e.target.value })} data-testid="input-invoice-description" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Valor (R$)</Label>
                <Input value={invoiceForm.amount} onChange={(e) => setInvoiceForm({ ...invoiceForm, amount: e.target.value })} placeholder="Ex.: 299,90" data-testid="input-invoice-amount" />
              </div>
              <div>
                <Label>Vencimento</Label>
                <Input type="date" value={invoiceForm.dueDate} onChange={(e) => setInvoiceForm({ ...invoiceForm, dueDate: e.target.value })} data-testid="input-invoice-due" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoiceOpen(false)}>Cancelar</Button>
            <Button disabled={busy || !invoiceForm.tenantId || !invoiceForm.dueDate} data-testid="button-save-invoice"
              onClick={() => {
                const cents = Math.round(Number(invoiceForm.amount.replace(/\./g, "").replace(",", ".")) * 100);
                if (!Number.isFinite(cents) || cents <= 0) { toast({ title: "Informe um valor maior que zero", variant: "destructive" }); return; }
                void run(() => api.superadmin.createInvoice({
                  tenantId: Number(invoiceForm.tenantId),
                  description: invoiceForm.description,
                  amountCents: cents,
                  dueDate: invoiceForm.dueDate,
                }), "Mensalidade lançada", () => { setInvoiceOpen(false); setInvoiceForm({ tenantId: "", description: "Mensalidade", amount: "", dueDate: "" }); });
              }}>
              Lançar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Novo chamado */}
      <Dialog open={ticketOpen} onOpenChange={setTicketOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Novo chamado de suporte</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Loja</Label>
              <Select value={ticketForm.tenantId} onValueChange={(v) => setTicketForm({ ...ticketForm, tenantId: v })}>
                <SelectTrigger data-testid="select-ticket-tenant"><SelectValue placeholder="Escolha a loja" /></SelectTrigger>
                <SelectContent>
                  {tenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Título</Label>
              <Input value={ticketForm.title} onChange={(e) => setTicketForm({ ...ticketForm, title: e.target.value })} placeholder="Ex.: WhatsApp desconectando" data-testid="input-ticket-title" />
            </div>
            <div>
              <Label>Descrição</Label>
              <Textarea rows={3} value={ticketForm.description} onChange={(e) => setTicketForm({ ...ticketForm, description: e.target.value })} data-testid="input-ticket-description" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTicketOpen(false)}>Cancelar</Button>
            <Button disabled={busy || !ticketForm.tenantId || !ticketForm.title.trim()} data-testid="button-save-ticket"
              onClick={() => run(() => api.superadmin.createTicket({
                tenantId: Number(ticketForm.tenantId),
                title: ticketForm.title.trim(),
                description: ticketForm.description.trim() || undefined,
              }), "Chamado aberto", () => { setTicketOpen(false); setTicketForm({ tenantId: "", title: "", description: "" }); })}>
              Abrir chamado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
