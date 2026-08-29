import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  api,
  type TenantSummary,
  type SaasContract,
  type SaasInvoice,
  type SaasTicket,
  type TicketMessage,
  type TicketStatus,
  type TicketPriority,
  type TicketCategory,
  type SaasOverview,
  type SaasAttention,
  type AttentionItem,
  type SuperadminAuditEntry,
  type OptionalModule,
  type Plan,
  type LimitField,
  type PlanUsage,
  OPTIONAL_MODULES,
  MODULE_LABELS,
  MODULE_PACKAGES,
  LIMIT_FIELDS,
  LIMIT_LABELS,
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
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import ChangePasswordModal from "@/components/ChangePasswordModal";
import {
  Building2, LogOut, Plus, KeyRound, Ban,
  CheckCircle2, DollarSign, FileText, Wrench, Pencil, AlertTriangle, Trash2,
  Bug, HelpCircle, Sparkles, Clock, Send, LogIn, LayoutGrid, UserCog,
  LayoutDashboard, Search, MoreVertical, WifiOff, HardHat, ArrowRight, History,
  Gauge,
} from "lucide-react";

// Compara duas listas de módulos ignorando ordem (usado pra destacar o botão
// de pacote "Básico"/"Completo" certo conforme a seleção atual).
const modulesEqual = (a: OptionalModule[], b: OptionalModule[]): boolean =>
  a.length === b.length && a.every((m) => b.includes(m));

// Grade de módulos contratados por loja — usada tanto no cadastro de loja
// nova quanto na edição de uma loja já existente.
function ModulePicker({ value, onChange }: { value: OptionalModule[]; onChange: (v: OptionalModule[]) => void }) {
  return (
    <div>
      <div className="flex gap-2 mt-1 mb-2">
        <Button type="button" size="sm" variant={modulesEqual(value, MODULE_PACKAGES.basico) ? "default" : "outline"}
          onClick={() => onChange([...MODULE_PACKAGES.basico])} data-testid="button-package-basico">
          Básico
        </Button>
        <Button type="button" size="sm" variant={modulesEqual(value, MODULE_PACKAGES.completo) ? "default" : "outline"}
          onClick={() => onChange([...MODULE_PACKAGES.completo])} data-testid="button-package-completo">
          Completo
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-2">Ajuste fino — marque/desmarque módulos individuais:</p>
      <div className="grid grid-cols-2 gap-1.5">
        {OPTIONAL_MODULES.map((m) => (
          <label key={m} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={value.includes(m)} data-testid={`checkbox-module-${m}`}
              onChange={(e) => onChange(e.target.checked ? [...value, m] : value.filter((x) => x !== m))} />
            {MODULE_LABELS[m]}
          </label>
        ))}
      </div>
    </div>
  );
}

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

const fmtDateTime = (d: string): string => {
  const dt = new Date(d);
  return `${fmtDate(d)} ${dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
};

const TICKET_STATUS_META: Record<TicketStatus, { label: string; className: string }> = {
  aberto: { label: "Aberto", className: "bg-blue-100 text-blue-700 hover:bg-blue-100" },
  em_analise: { label: "Em análise", className: "bg-violet-100 text-violet-700 hover:bg-violet-100" },
  em_andamento: { label: "Em andamento", className: "bg-amber-100 text-amber-700 hover:bg-amber-100" },
  resolvido: { label: "Resolvido", className: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100" },
  fechado: { label: "Fechado", className: "bg-gray-100 text-gray-600 hover:bg-gray-100" },
};
const TICKET_PRIORITY_META: Record<TicketPriority, { label: string; className: string }> = {
  baixa: { label: "Baixa", className: "text-gray-500 border-gray-300" },
  normal: { label: "Normal", className: "text-blue-600 border-blue-300" },
  alta: { label: "Alta", className: "text-amber-600 border-amber-300" },
  urgente: { label: "Urgente", className: "text-red-600 border-red-400 font-semibold" },
};
const TICKET_CATEGORY_META: Record<TicketCategory, { label: string; icon: typeof Bug }> = {
  bug: { label: "Bug", icon: Bug },
  duvida: { label: "Dúvida", icon: HelpCircle },
  melhoria: { label: "Melhoria", icon: Sparkles },
};

// Sub-abas da lista de chamados: "Ativos" (visão padrão) fica só com quem
// ainda precisa de atenção; "Histórico" junta resolvido/fechado (com a nota
// de solução) fora do caminho do dia a dia.
const ACTIVE_TICKET_STATUSES: TicketStatus[] = ["aberto", "em_analise", "em_andamento"];
const HISTORY_TICKET_STATUSES: TicketStatus[] = ["resolvido", "fechado"];

// Indicador de SLA: quanto tempo em aberto sem 1ª resposta do técnico.
// Verde < 2h, âmbar 2–8h, vermelho > 8h. Já respondido = neutro.
function slaBadge(tk: SaasTicket) {
  if (tk.status === "resolvido" || tk.status === "fechado") return null;
  if (tk.firstRespondedAt) {
    return <Badge variant="outline" className="text-muted-foreground border-border"><Clock className="w-3 h-3 mr-1" /> Respondido</Badge>;
  }
  const hours = (Date.now() - new Date(tk.createdAt).getTime()) / 3600000;
  const className = hours > 8 ? "bg-red-100 text-red-700 hover:bg-red-100" : hours > 2 ? "bg-amber-100 text-amber-700 hover:bg-amber-100" : "bg-emerald-100 text-emerald-700 hover:bg-emerald-100";
  const label = hours < 1 ? "aguardando há minutos" : `aguardando há ${Math.floor(hours)}h`;
  return <Badge className={className}><Clock className="w-3 h-3 mr-1" /> {label}</Badge>;
}

// Cada item do feed "Precisa da sua atenção" (Visão Geral) tem seu próprio
// formato de mensagem — monta o texto certo conforme o tipo do item.
function attentionItemLabel(item: AttentionItem) {
  switch (item.type) {
    case "whatsapp_disconnected":
      return (
        <p className="text-sm flex items-center gap-1.5">
          <WifiOff className="w-4 h-4 text-red-500 shrink-0" />
          <span><strong>{item.tenantName}</strong> · WhatsApp "{item.sessionLabel}" desconectado{item.hoursOffline >= 1 ? ` há ${item.hoursOffline}h` : ""}</span>
        </p>
      );
    case "invoice_overdue":
      return (
        <p className="text-sm flex items-center gap-1.5">
          <DollarSign className="w-4 h-4 text-red-500 shrink-0" />
          <span><strong>{item.tenantName}</strong> · mensalidade de {brl(item.amountCents)} vencida há {item.daysOverdue} dia{item.daysOverdue === 1 ? "" : "s"}</span>
        </p>
      );
    case "contract_renewing":
      return (
        <p className="text-sm flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-amber-500 shrink-0" />
          <span><strong>{item.tenantName}</strong> · contrato {item.daysUntil < 0 ? `venceu há ${-item.daysUntil} dia(s)` : item.daysUntil === 0 ? "vence hoje" : `vence em ${item.daysUntil} dia(s)`}</span>
        </p>
      );
    case "ticket_urgent":
      return (
        <p className="text-sm flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
          <span><strong>{item.tenantName}</strong> · chamado urgente "{item.title}" {item.responded ? "aguardando retorno" : "sem resposta"} há {item.hoursOpen}h</span>
        </p>
      );
    default:
      return null;
  }
}

type Tab = "visaogeral" | "lojistas" | "planos" | "financeiro" | "contratos" | "suporte" | "auditoria";

const TABS: { id: Tab; label: string; icon: typeof Building2 }[] = [
  { id: "visaogeral", label: "Visão Geral", icon: LayoutDashboard },
  { id: "lojistas", label: "Lojistas", icon: Building2 },
  { id: "planos", label: "Planos & Limites", icon: Gauge },
  { id: "financeiro", label: "Financeiro", icon: DollarSign },
  { id: "contratos", label: "Contratos", icon: FileText },
  { id: "suporte", label: "Suporte", icon: Wrench },
  { id: "auditoria", label: "Auditoria", icon: History },
];

// Motivos fixos do "Entrar como" (mesmos do backend) — "Outro" libera um
// campo de texto livre que vira o motivo final gravado no log.
const IMPERSONATE_REASONS = ["Suporte", "Configuração", "Treinamento", "Outro"] as const;

// Situação da loja: rótulo curto + estilo do badge, usado na tabela de
// Lojistas e na Visão Geral. "inadimplente" é sempre derivada (nunca
// escolhida manualmente); as outras três o superadmin escolhe direto.
const TENANT_STATUS_META: Record<TenantSummary["saasStatus"], { label: string; className: string }> = {
  ativo: { label: "Ativo", className: "bg-green-100 text-green-700 hover:bg-green-100" },
  em_implantacao: { label: "Em implantação", className: "bg-blue-100 text-blue-700 hover:bg-blue-100" },
  inadimplente: { label: "Inadimplente", className: "" }, // usa variant="destructive"
  cancelado: { label: "Cancelado", className: "" }, // usa variant="outline"
};

export default function SuperAdminDashboard() {
  const { user, logout, setUser } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("visaogeral");

  // Meu Cadastro: edição do próprio nome/e-mail (PATCH /auth/me — nunca um
  // id de outra conta) + troca de senha (reaproveita o mesmo modal usado no
  // resto do sistema). Fase 2: saiu da barra de abas e virou um menu no
  // canto (ver header), mais discreto pra uma ação que é rara.
  const [showProfile, setShowProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: user?.name ?? "", email: user?.email ?? "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  useEffect(() => {
    if (user) setProfileForm({ name: user.name, email: user.email });
  }, [user]);
  const saveProfile = async () => {
    const name = profileForm.name.trim();
    const email = profileForm.email.trim();
    if (!name) { toast({ title: "Nome não pode ficar vazio", variant: "destructive" }); return; }
    if (!email.includes("@")) { toast({ title: "E-mail inválido", variant: "destructive" }); return; }
    setSavingProfile(true);
    try {
      const { user: updated } = await api.auth.updateProfile({ name, email });
      setUser(updated);
      toast({ title: "Cadastro atualizado" });
    } catch (e) {
      fail("Erro ao salvar cadastro")(e);
    } finally {
      setSavingProfile(false);
    }
  };
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [overview, setOverview] = useState<SaasOverview | null>(null);
  const [attention, setAttention] = useState<SaasAttention | null>(null);
  const [invoices, setInvoices] = useState<SaasInvoice[]>([]);
  const [contracts, setContracts] = useState<SaasContract[]>([]);
  const [tickets, setTickets] = useState<SaasTicket[]>([]);
  const [auditEntries, setAuditEntries] = useState<SuperadminAuditEntry[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [template, setTemplate] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Lojistas: busca por nome/contato + filtro rápido por situação —
  // substituem os cards por uma tabela compacta que aguenta muitas lojas.
  const [lojistaSearch, setLojistaSearch] = useState("");
  const [lojistaFilter, setLojistaFilter] = useState<
    "todas" | "ativas" | "suspensas" | "em_implantacao" | "inadimplentes" | "whatsapp_desconectado" | "com_chamado"
  >("todas");

  // Diálogos
  const [createOpen, setCreateOpen] = useState(false);
  const [impersonateFor, setImpersonateFor] = useState<TenantSummary | null>(null);
  // Fase 2: motivo obrigatório antes de "Entrar como" — mesmo diálogo serve
  // pra escolher o admin (quando a loja tem mais de um) e pra informar o
  // motivo (sempre).
  const [impersonateAdminId, setImpersonateAdminId] = useState<number | null>(null);
  const [impersonateReason, setImpersonateReason] = useState("");
  const [impersonateReasonDetail, setImpersonateReasonDetail] = useState("");
  const [impersonating, setImpersonating] = useState(false);
  const [adminFor, setAdminFor] = useState<TenantSummary | null>(null);
  const [contactFor, setContactFor] = useState<TenantSummary | null>(null);
  const [contractFor, setContractFor] = useState<TenantSummary | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  // Suporte: filtros da lista + chamado aberto em detalhe (timeline + resposta).
  const [ticketView, setTicketView] = useState<"ativos" | "historico">("ativos");
  const [ticketFilters, setTicketFilters] = useState<{ status: string; priority: string; category: string; tenantId: string }>({ status: "", priority: "", category: "", tenantId: "" });
  const [ticketDetail, setTicketDetail] = useState<SaasTicket | null>(null);
  const [ticketMessages, setTicketMessages] = useState<TicketMessage[]>([]);
  const [ticketReply, setTicketReply] = useState("");
  const [sendingReply, setSendingReply] = useState(false);

  const [form, setForm] = useState<{
    name: string; contactName: string; cpfCnpj: string; contactEmail: string; contactPhone: string;
    enabledModules: OptionalModule[]; adminName: string; adminEmail: string; adminPassword: string;
  }>({
    name: "", contactName: "", cpfCnpj: "", contactEmail: "", contactPhone: "",
    enabledModules: [...MODULE_PACKAGES.basico], adminName: "", adminEmail: "", adminPassword: "",
  });
  const emptyForm = { name: "", contactName: "", cpfCnpj: "", contactEmail: "", contactPhone: "", enabledModules: [...MODULE_PACKAGES.basico], adminName: "", adminEmail: "", adminPassword: "" };
  const [adminForm, setAdminForm] = useState({ name: "", email: "", password: "" });
  const [contactForm, setContactForm] = useState({ contactName: "", contactPhone: "", contactEmail: "" });
  const [modulesFor, setModulesFor] = useState<TenantSummary | null>(null);
  const [modulesForm, setModulesForm] = useState<OptionalModule[]>([]);

  // Catálogo de planos (Fase 3 — Planos & Limites): CRUD dos modelos de
  // plano (Start/Pro/Premium/...). Campo vazio = ilimitado nesse recurso.
  const [planFor, setPlanFor] = useState<Plan | "new" | null>(null);
  const [planForm, setPlanForm] = useState<{ name: string; isActive: boolean } & Record<LimitField, string>>(
    { name: "", isActive: true, ...(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, ""])) as Record<LimitField, string>) },
  );
  const openNewPlan = () => {
    setPlanFor("new");
    setPlanForm({ name: "", isActive: true, ...(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, ""])) as Record<LimitField, string>) });
  };
  const openEditPlan = (p: Plan) => {
    setPlanFor(p);
    setPlanForm({
      name: p.name, isActive: p.isActive,
      ...(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, p[f] == null ? "" : String(p[f])])) as Record<LimitField, string>),
    });
  };
  const savePlan = () => {
    const body: { name: string; isActive: boolean } & Partial<Record<LimitField, number | null>> = {
      name: planForm.name.trim(), isActive: planForm.isActive,
    };
    for (const f of LIMIT_FIELDS) body[f] = planForm[f].trim() === "" ? null : Number(planForm[f]);
    const isNew = planFor === "new";
    void run(
      () => (isNew ? api.superadmin.createPlan(body) : api.superadmin.updatePlan((planFor as Plan).id, body)),
      isNew ? "Plano criado" : "Plano atualizado",
      () => setPlanFor(null),
    );
  };

  // Plano & Limites de UMA loja: escolher o plano dela e, se precisar,
  // personalizar os limites só pra ela (negociação diferente do padrão).
  const [limitsFor, setLimitsFor] = useState<TenantSummary | null>(null);
  const [limitsForm, setLimitsForm] = useState<{ planId: string; usesCustomLimits: boolean } & Record<LimitField, string>>(
    { planId: "", usesCustomLimits: false, ...(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, ""])) as Record<LimitField, string>) },
  );
  const openLimits = (t: TenantSummary) => {
    setLimitsFor(t);
    const usage = t.planUsage;
    setLimitsForm({
      planId: t.contract?.planId != null ? String(t.contract.planId) : "",
      usesCustomLimits: usage?.isCustom ?? false,
      ...(Object.fromEntries(LIMIT_FIELDS.map((f) => {
        const item = usage?.items.find((i) => i.field === f);
        return [f, item?.limit == null ? "" : String(item.limit)];
      })) as Record<LimitField, string>),
    });
  };
  const saveLimits = () => {
    if (!limitsFor) return;
    const customLimits: Partial<Record<LimitField, number | null>> = {};
    for (const f of LIMIT_FIELDS) customLimits[f] = limitsForm[f].trim() === "" ? null : Number(limitsForm[f]);
    void run(
      () => api.superadmin.updateTenantPlan(limitsFor.id, {
        planId: limitsForm.planId ? Number(limitsForm.planId) : null,
        usesCustomLimits: limitsForm.usesCustomLimits,
        customLimits: limitsForm.usesCustomLimits ? customLimits : undefined,
      }),
      "Plano e limites atualizados",
      () => setLimitsFor(null),
    );
  };
  const [contractForm, setContractForm] = useState({ plan: "Mensal", monthlyValue: "", startDate: "", renewalDate: "", notes: "" });
  const [invoiceForm, setInvoiceForm] = useState({ tenantId: "", description: "Mensalidade", amount: "", dueDate: "" });
  const [ticketForm, setTicketForm] = useState({ tenantId: "", title: "", description: "" });

  const fail = (title: string) => (e: unknown) =>
    toast({ title, description: (e as Error).message, variant: "destructive" });

  const loadAll = useCallback(() => {
    Promise.all([
      api.superadmin.listTenants().then((r) => setTenants(r.tenants)),
      api.superadmin.saasOverview().then(setOverview),
      api.superadmin.saasAttention().then(setAttention),
      api.superadmin.listInvoices().then((r) => setInvoices(r.invoices)),
      api.superadmin.listContracts().then((r) => setContracts(r.contracts)),
      api.superadmin.getContractTemplate().then((r) => setTemplate(r.template)),
      api.superadmin.auditLog().then((r) => setAuditEntries(r.entries)),
      api.superadmin.listPlans().then((r) => setPlans(r.plans)),
    ])
      .catch(fail("Erro ao carregar dados"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(loadAll, [loadAll]);

  // Lista de chamados: refaz sempre que um filtro muda.
  const loadTickets = useCallback(() => {
    api.superadmin.listTickets({
      status: (ticketFilters.status || undefined) as TicketStatus | undefined,
      priority: (ticketFilters.priority || undefined) as TicketPriority | undefined,
      category: (ticketFilters.category || undefined) as TicketCategory | undefined,
      tenantId: ticketFilters.tenantId ? Number(ticketFilters.tenantId) : undefined,
    }).then((r) => setTickets(r.tickets)).catch(() => {});
  }, [ticketFilters]);
  useEffect(loadTickets, [loadTickets]);

  // O filtro de situação já pode restringir a um status específico; a
  // sub-aba (Ativos/Histórico) filtra por cima disso, no cliente, pro grupo
  // de status certo — evita duplicar a query no backend pra algo tão simples.
  const viewTickets = tickets.filter((tk) =>
    (ticketView === "ativos" ? ACTIVE_TICKET_STATUSES : HISTORY_TICKET_STATUSES).includes(tk.status)
  );

  // Timeline do chamado aberto no detalhe, com polling pra ver resposta da loja.
  const loadTicketThread = useCallback(() => {
    if (!ticketDetail) return;
    api.superadmin.ticketMessages(ticketDetail.id).then((r) => setTicketMessages(r.messages)).catch(() => {});
  }, [ticketDetail]);
  useEffect(loadTicketThread, [loadTicketThread]);
  useEffect(() => {
    if (!ticketDetail) return;
    const t = setInterval(loadTicketThread, 10000);
    return () => clearInterval(t);
  }, [ticketDetail, loadTicketThread]);

  const sendTicketReply = async () => {
    if (!ticketDetail || !ticketReply.trim() || sendingReply) return;
    setSendingReply(true);
    try {
      await api.superadmin.replyTicket(ticketDetail.id, ticketReply.trim());
      setTicketReply("");
      loadTicketThread();
      loadTickets();
      if (!ticketDetail.firstRespondedAt) setTicketDetail({ ...ticketDetail, firstRespondedAt: new Date().toISOString() });
    } catch (e) {
      fail("Erro ao responder")(e);
    } finally {
      setSendingReply(false);
    }
  };

  const updateTicketField = async (data: { status?: TicketStatus; priority?: TicketPriority; category?: TicketCategory; resolutionNote?: string }) => {
    if (!ticketDetail) return;
    try {
      const { ticket } = await api.superadmin.updateTicket(ticketDetail.id, data);
      setTicketDetail(ticket);
      loadTickets();
    } catch (e) {
      fail("Erro ao atualizar")(e);
    }
  };

  // Marcar como "resolvido" exige descrever a solução antes de confirmar —
  // em vez de disparar o PATCH na hora do Select (como as outras situações),
  // abre um campo pra escrever, e só salva os dois juntos ao confirmar.
  // resolvingStatus != null também controla o valor exibido no Select
  // enquanto o campo está aberto (senão ele voltaria pro status antigo até
  // confirmar, um piscar de tela confuso).
  const [resolvingStatus, setResolvingStatus] = useState(false);
  const [resolutionDraft, setResolutionDraft] = useState("");
  const handleTicketStatusChange = (v: string) => {
    if (v === "resolvido") {
      setResolutionDraft(ticketDetail?.resolutionNote ?? "");
      setResolvingStatus(true);
    } else {
      setResolvingStatus(false);
      updateTicketField({ status: v as TicketStatus });
    }
  };
  const confirmResolve = async () => {
    if (!resolutionDraft.trim()) return;
    await updateTicketField({ status: "resolvido", resolutionNote: resolutionDraft.trim() });
    setResolvingStatus(false);
  };
  const openEditResolution = () => {
    setResolutionDraft(ticketDetail?.resolutionNote ?? "");
    setResolvingStatus(true);
  };

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

  // "Entrar como": desde a Fase 2, sempre pede o motivo antes (item pedido
  // explicitamente pelo cliente) — com mais de um admin ativo, o mesmo
  // diálogo também pede qual admin. A sessão já muda no backend; recarrega
  // a página inteira pra o AuthProvider buscar a identidade nova do zero.
  const closeImpersonateDialog = () => {
    setImpersonateFor(null);
    setImpersonateAdminId(null);
    setImpersonateReason("");
    setImpersonateReasonDetail("");
  };
  const openImpersonate = (t: TenantSummary) => {
    const activeAdmins = t.admins.filter((a) => a.isActive);
    if (activeAdmins.length === 0) return;
    setImpersonateFor(t);
    setImpersonateAdminId(activeAdmins.length === 1 ? activeAdmins[0]!.id : null);
    setImpersonateReason("");
    setImpersonateReasonDetail("");
  };
  const confirmImpersonate = async () => {
    if (!impersonateFor || impersonateAdminId == null || !impersonateReason) return;
    if (impersonateReason === "Outro" && !impersonateReasonDetail.trim()) return;
    setImpersonating(true);
    try {
      await api.superadmin.impersonate(impersonateFor.id, impersonateAdminId, impersonateReason, impersonateReasonDetail.trim() || undefined);
      window.location.href = "/";
    } catch (e) {
      fail("Erro ao entrar como este admin")(e);
      setImpersonating(false);
    }
  };

  const statusBadge = (t: TenantSummary) => {
    if (t.saasStatus === "cancelado") return <Badge variant="outline" className="text-muted-foreground">Cancelado</Badge>;
    if (t.saasStatus === "inadimplente") return <Badge variant="destructive">Inadimplente</Badge>;
    if (t.saasStatus === "em_implantacao") return <Badge className={TENANT_STATUS_META.em_implantacao.className}>Em implantação</Badge>;
    return <Badge variant="secondary" className="text-green-700">Ativo</Badge>;
  };

  const activeTenants = tenants.filter((t) => t.saasStatus !== "cancelado");

  // Tabela de Lojistas: busca por nome/contato + o filtro rápido selecionado.
  const filteredTenants = tenants.filter((t) => {
    if (lojistaSearch.trim()) {
      const q = lojistaSearch.trim().toLowerCase();
      const haystack = `${t.name} ${t.contactName ?? ""} ${t.contactEmail ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    switch (lojistaFilter) {
      case "ativas": return t.saasStatus === "ativo";
      case "suspensas": return !t.isActive && t.saasStatus !== "cancelado";
      case "em_implantacao": return t.saasStatus === "em_implantacao";
      case "inadimplentes": return t.saasStatus === "inadimplente";
      case "whatsapp_desconectado": return t.whatsappCount > t.whatsappConnectedCount;
      case "com_chamado": return t.openTicketCount > 0;
      default: return true;
    }
  });

  // "Ver X" do feed de atenção: leva direto pra Lojistas (com o nome já
  // filtrado) ou pra Suporte (com prioridade urgente + a loja já filtrada).
  const viewTenantFromAttention = (tenantName: string) => {
    setTab("lojistas");
    setLojistaFilter("todas");
    setLojistaSearch(tenantName);
  };
  const viewTicketFromAttention = (tenantId: number) => {
    setTab("suporte");
    setTicketView("ativos");
    setTicketFilters({ status: "", priority: "urgente", category: "", tenantId: String(tenantId) });
  };

  // Alterna entre "em implantação" e "ativo" — usado enquanto a loja ainda
  // está sendo configurada, antes de virar cliente ativo de fato.
  const toggleImplantacao = (t: TenantSummary) =>
    run(() => api.superadmin.updateTenant(t.id, { saasStatus: t.saasStatus === "em_implantacao" ? "ativo" : "em_implantacao" }),
      t.saasStatus === "em_implantacao" ? "Loja marcada como ativa" : "Loja marcada como em implantação");

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
        <div className="flex items-center gap-1">
          {/* Meu Cadastro saiu da barra de abas na Fase 2 — ação rara, então
              vira menu no canto em vez de disputar espaço com as abas do dia a dia. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" data-testid="button-corner-menu">
                <UserCog className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setShowProfile(true)} data-testid="menuitem-meu-cadastro">
                <UserCog className="w-4 h-4 mr-2" /> Meu Cadastro
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={logout} data-testid="button-logout">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
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
            {/* --------------------------------------------- VISÃO GERAL */}
            {tab === "visaogeral" && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: "Lojas cadastradas", value: String(attention?.counts.total ?? tenants.length) },
                    { label: "Ativas", value: String(attention?.counts.ativo ?? 0) },
                    { label: "Suspensas", value: String(attention?.counts.suspensas ?? 0), red: (attention?.counts.suspensas ?? 0) > 0 },
                    { label: "Em implantação", value: String(attention?.counts.emImplantacao ?? 0) },
                    { label: "Inadimplentes", value: String(attention?.counts.inadimplente ?? 0), red: (attention?.counts.inadimplente ?? 0) > 0 },
                    { label: "Receita mensal", value: overview ? brl(overview.mrrCents) : "—" },
                    { label: "Em atraso", value: overview ? brl(overview.overdueCents) : "—", red: (overview?.overdueCount ?? 0) > 0 },
                    { label: "WhatsApp conectados", value: attention ? `${attention.whatsapp.connected}/${attention.whatsapp.total}` : "—", red: !!attention && attention.whatsapp.connected < attention.whatsapp.total },
                    { label: "Chamados críticos", value: String(attention?.criticalTickets ?? 0), red: (attention?.criticalTickets ?? 0) > 0 },
                  ].map((s) => (
                    <Card key={s.label}>
                      <CardContent className="pt-4">
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                        <p className={`text-xl font-bold ${s.red ? "text-red-600" : ""}`}>{s.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500" /> Precisa da sua atenção
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {!attention || attention.items.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">Nenhum ponto de atenção no momento — tudo em dia.</p>
                    ) : (
                      attention.items.map((item, i) => (
                        <div key={i} className="flex items-center justify-between gap-2 py-2 border-b last:border-0 flex-wrap">
                          {attentionItemLabel(item)}
                          {item.type === "ticket_urgent" ? (
                            <Button size="sm" variant="outline" onClick={() => viewTicketFromAttention(item.tenantId)}>
                              Ver chamado <ArrowRight className="w-3.5 h-3.5 ml-1" />
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => viewTenantFromAttention(item.tenantName)}>
                              Ver loja <ArrowRight className="w-3.5 h-3.5 ml-1" />
                            </Button>
                          )}
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </>
            )}

            {/* ------------------------------------------------ LOJISTAS */}
            {tab === "lojistas" && (
              <>
                <div className="flex justify-between items-center gap-2 flex-wrap">
                  <div className="flex gap-2 flex-wrap items-center flex-1 min-w-[240px]">
                    <div className="relative w-full max-w-xs">
                      <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input value={lojistaSearch} onChange={(e) => setLojistaSearch(e.target.value)}
                        placeholder="Buscar loja ou contato..." className="pl-8" data-testid="input-lojista-search" />
                    </div>
                    <Select value={lojistaFilter} onValueChange={(v) => setLojistaFilter(v as typeof lojistaFilter)}>
                      <SelectTrigger className="w-[200px]" data-testid="filter-lojista"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="todas">Todas as lojas</SelectItem>
                        <SelectItem value="ativas">Ativas</SelectItem>
                        <SelectItem value="suspensas">Suspensas</SelectItem>
                        <SelectItem value="em_implantacao">Em implantação</SelectItem>
                        <SelectItem value="inadimplentes">Inadimplentes</SelectItem>
                        <SelectItem value="whatsapp_desconectado">WhatsApp desconectado</SelectItem>
                        <SelectItem value="com_chamado">Com chamado aberto</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-tenant">
                    <Plus className="w-4 h-4 mr-1" /> Nova loja
                  </Button>
                </div>

                {tenants.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nenhuma loja cadastrada ainda.</p>
                ) : filteredTenants.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nenhuma loja encontrada com esse filtro.</p>
                ) : (
                  <Card>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Loja</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Plano</TableHead>
                          <TableHead>Usuários</TableHead>
                          <TableHead>WhatsApp</TableHead>
                          <TableHead>Conversas</TableHead>
                          <TableHead>Financeiro</TableHead>
                          <TableHead>Suporte</TableHead>
                          <TableHead className="text-right">Ações</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredTenants.map((t) => (
                          <TableRow key={t.id} data-testid={`row-tenant-${t.id}`}>
                            <TableCell>
                              <div className="font-medium">{t.name}</div>
                              <div className="text-xs text-muted-foreground">{t.contactName || t.contactEmail || "—"}</div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1 items-start">
                                {statusBadge(t)}
                                {!t.isActive && <Badge variant="destructive" className="text-[10px]">Acesso suspenso</Badge>}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm">
                              {t.contract ? <>{t.contract.plan}<br /><span className="text-xs text-muted-foreground">{brl(t.contract.monthlyValueCents)}/mês</span></> : "—"}
                            </TableCell>
                            <TableCell className="text-sm">{t.userCount}</TableCell>
                            <TableCell className="text-sm">
                              <span className={t.whatsappCount > 0 && t.whatsappConnectedCount < t.whatsappCount ? "text-red-600 flex items-center gap-1" : ""}>
                                {t.whatsappCount > 0 && t.whatsappConnectedCount < t.whatsappCount && <WifiOff className="w-3.5 h-3.5" />}
                                {t.whatsappConnectedCount}/{t.whatsappCount}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">{t.conversationCount}</TableCell>
                            <TableCell className="text-sm">
                              {t.overdueCount > 0 ? (
                                <span className="text-red-600 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {t.overdueCount} atrasada(s)</span>
                              ) : "Em dia"}
                            </TableCell>
                            <TableCell className="text-sm">
                              {t.openTicketCount > 0 ? `${t.openTicketCount} aberto(s)` : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button size="sm" variant="outline" disabled={!t.admins.some((a) => a.isActive)}
                                  title={!t.admins.some((a) => a.isActive) ? "Cadastre um admin ativo primeiro" : undefined}
                                  onClick={() => openImpersonate(t)} data-testid={`button-impersonate-${t.id}`}>
                                  <LogIn className="w-4 h-4 mr-1" /> Entrar como
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="ghost" data-testid={`button-menu-${t.id}`}><MoreVertical className="w-4 h-4" /></Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => {
                                      setContactFor(t);
                                      setContactForm({ contactName: t.contactName ?? "", contactPhone: t.contactPhone ?? "", contactEmail: t.contactEmail ?? "" });
                                    }} data-testid={`button-contact-${t.id}`}>
                                      <Pencil className="w-4 h-4 mr-2" /> Contato
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => { setModulesFor(t); setModulesForm([...t.enabledModules]); }} data-testid={`button-modules-${t.id}`}>
                                      <LayoutGrid className="w-4 h-4 mr-2" /> Módulos
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => openLimits(t)} data-testid={`button-limits-${t.id}`}>
                                      <Gauge className="w-4 h-4 mr-2" /> Plano & Limites
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => { setAdminFor(t); setAdminForm({ name: "", email: t.admins[0]?.email ?? "", password: "" }); }} data-testid={`button-admin-${t.id}`}>
                                      <KeyRound className="w-4 h-4 mr-2" /> Admin
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {t.saasStatus !== "cancelado" && (
                                      <DropdownMenuItem onClick={() => toggleImplantacao(t)} data-testid={`button-implantacao-${t.id}`}>
                                        <HardHat className="w-4 h-4 mr-2" /> {t.saasStatus === "em_implantacao" ? "Marcar como ativa" : "Marcar em implantação"}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={() => run(() => api.superadmin.updateTenant(t.id, { isActive: !t.isActive }), t.isActive ? "Loja suspensa" : "Loja reativada")}
                                      data-testid={`button-toggle-${t.id}`}>
                                      {t.isActive ? <><Ban className="w-4 h-4 mr-2" /> Suspender</> : <><CheckCircle2 className="w-4 h-4 mr-2" /> Reativar</>}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {t.saasStatus !== "cancelado" ? (
                                      <DropdownMenuItem className="text-muted-foreground"
                                        onClick={() => {
                                          if (window.confirm(`Cancelar o contrato da loja "${t.name}"? O acesso dela será suspenso.`))
                                            void run(() => api.superadmin.updateTenant(t.id, { saasStatus: "cancelado" }), "Contrato cancelado");
                                        }}
                                        data-testid={`button-cancel-${t.id}`}>
                                        Cancelar contrato
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem
                                        onClick={() => run(() => api.superadmin.updateTenant(t.id, { saasStatus: "ativo", isActive: true }), "Lojista reativado")}
                                        data-testid={`button-uncancel-${t.id}`}>
                                        Reativar contrato
                                      </DropdownMenuItem>
                                    )}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                )}
              </>
            )}

            {/* ------------------------------------------ PLANOS & LIMITES */}
            {tab === "planos" && (
              <>
                <div className="flex justify-between items-center gap-2 flex-wrap">
                  <p className="text-sm text-muted-foreground max-w-2xl">
                    Modelos de plano (Start, Pro, Premium...) com um teto por recurso. Cada loja usa os limites
                    do plano contratado, ou você personaliza só pra ela em "Plano & Limites" na aba Lojistas —
                    sem afetar as demais lojas do mesmo plano.
                  </p>
                  <Button size="sm" onClick={openNewPlan} data-testid="button-create-plan">
                    <Plus className="w-4 h-4 mr-1" /> Novo plano
                  </Button>
                </div>
                {plans.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nenhum plano cadastrado ainda.</p>
                ) : (
                  <div className="grid md:grid-cols-2 gap-3">
                    {plans.map((p) => (
                      <Card key={p.id} data-testid={`card-plan-${p.id}`} className={p.isActive ? "" : "opacity-60"}>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-base flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2">
                              {p.name}
                              {!p.isActive && <Badge variant="outline" className="text-[10px]">Arquivado</Badge>}
                            </span>
                            <Button size="sm" variant="ghost" onClick={() => openEditPlan(p)} data-testid={`button-edit-plan-${p.id}`}>
                              <Pencil className="w-4 h-4" />
                            </Button>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                            {LIMIT_FIELDS.map((f) => (
                              <div key={f} className="flex justify-between gap-2 text-muted-foreground">
                                <span>{LIMIT_LABELS[f]}</span>
                                <span className="font-medium text-foreground">{p[f] == null ? "Ilimitado" : p[f]}</span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
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
                <div className="flex gap-2">
                  {(["ativos", "historico"] as const).map((v) => (
                    <Button key={v} size="sm" variant={ticketView === v ? "default" : "outline"}
                      onClick={() => { setTicketView(v); setTicketFilters((f) => ({ ...f, status: "" })); }}
                      data-testid={`button-ticket-view-${v}`}>
                      {v === "ativos" ? "Ativos" : "Histórico"}
                    </Button>
                  ))}
                </div>
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <div className="flex gap-2 flex-wrap">
                    <Select value={ticketFilters.status || "all"} onValueChange={(v) => setTicketFilters({ ...ticketFilters, status: v === "all" ? "" : v })}>
                      <SelectTrigger className="w-[160px]" data-testid="filter-ticket-status"><SelectValue placeholder="Situação" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas as situações</SelectItem>
                        {(ticketView === "ativos" ? ACTIVE_TICKET_STATUSES : HISTORY_TICKET_STATUSES).map((s) => <SelectItem key={s} value={s}>{TICKET_STATUS_META[s].label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={ticketFilters.priority || "all"} onValueChange={(v) => setTicketFilters({ ...ticketFilters, priority: v === "all" ? "" : v })}>
                      <SelectTrigger className="w-[140px]" data-testid="filter-ticket-priority"><SelectValue placeholder="Prioridade" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Toda prioridade</SelectItem>
                        {(Object.keys(TICKET_PRIORITY_META) as TicketPriority[]).map((p) => <SelectItem key={p} value={p}>{TICKET_PRIORITY_META[p].label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={ticketFilters.category || "all"} onValueChange={(v) => setTicketFilters({ ...ticketFilters, category: v === "all" ? "" : v })}>
                      <SelectTrigger className="w-[140px]" data-testid="filter-ticket-category"><SelectValue placeholder="Categoria" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Toda categoria</SelectItem>
                        {(Object.keys(TICKET_CATEGORY_META) as TicketCategory[]).map((c) => <SelectItem key={c} value={c}>{TICKET_CATEGORY_META[c].label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={ticketFilters.tenantId || "all"} onValueChange={(v) => setTicketFilters({ ...ticketFilters, tenantId: v === "all" ? "" : v })}>
                      <SelectTrigger className="w-[180px]" data-testid="filter-ticket-tenant"><SelectValue placeholder="Loja" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas as lojas</SelectItem>
                        {tenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button size="sm" onClick={() => setTicketOpen(true)} data-testid="button-create-ticket">
                    <Plus className="w-4 h-4 mr-1" /> Novo chamado
                  </Button>
                </div>
                {viewTickets.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {ticketView === "ativos" ? "Nenhum chamado ativo no momento." : "Nenhum chamado no histórico."}
                  </p>
                ) : (
                  viewTickets.map((tk) => {
                    const CategoryIcon = TICKET_CATEGORY_META[tk.category].icon;
                    return (
                      <Card key={tk.id} data-testid={`card-ticket-${tk.id}`} className="cursor-pointer hover:bg-muted/30" onClick={() => setTicketDetail(tk)}>
                        <CardContent className="py-3 flex items-center justify-between flex-wrap gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-sm flex items-center gap-2 flex-wrap">
                              {tk.title}
                              <Badge className={TICKET_STATUS_META[tk.status].className}>{TICKET_STATUS_META[tk.status].label}</Badge>
                              <Badge variant="outline" className={TICKET_PRIORITY_META[tk.priority].className}>{TICKET_PRIORITY_META[tk.priority].label}</Badge>
                              {slaBadge(tk)}
                            </p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <CategoryIcon className="w-3 h-3" /> {TICKET_CATEGORY_META[tk.category].label} · {tk.tenantName}{tk.storeName ? ` (${tk.storeName})` : ""}{tk.openedByUserName ? ` · aberto por ${tk.openedByUserName}` : ""} · aberto em {fmtDateTime(tk.createdAt)}
                            </p>
                          </div>
                          <Button size="sm" variant="outline" data-testid={`button-open-ticket-${tk.id}`}>Ver conversa</Button>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </>
            )}

            {/* --------------------------------------------- AUDITORIA */}
            {tab === "auditoria" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Toda ação relevante feita neste painel, em qualquer loja: entrar como, suspender/reativar,
                  cancelar/reativar contrato, mudar módulos, criar loja ou admin. Mais recentes primeiro.
                </p>
                {auditEntries.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nenhuma ação registrada ainda.</p>
                ) : (
                  <Card>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Quando</TableHead>
                          <TableHead>Loja</TableHead>
                          <TableHead>Ação</TableHead>
                          <TableHead>Motivo</TableHead>
                          <TableHead>Superadmin</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {auditEntries.map((e) => (
                          <TableRow key={e.id} data-testid={`row-audit-${e.id}`}>
                            <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(e.createdAt)}</TableCell>
                            <TableCell className="text-sm">{e.tenantName ?? "—"}</TableCell>
                            <TableCell className="text-sm">{e.description}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{e.reason ?? "—"}</TableCell>
                            <TableCell className="text-sm">{e.superadminName ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Meu Cadastro — Fase 2: virou diálogo aberto pelo menu no canto do header. */}
      <Dialog open={showProfile} onOpenChange={setShowProfile}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Meu Cadastro</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Meus dados</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label>Nome</Label>
                  <Input value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} data-testid="input-profile-name" />
                </div>
                <div>
                  <Label>E-mail</Label>
                  <Input type="email" value={profileForm.email} onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })} data-testid="input-profile-email" />
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={savingProfile || !profileForm.name.trim() || !profileForm.email.trim()}
                    onClick={saveProfile} data-testid="button-save-profile">
                    {savingProfile ? "Salvando..." : "Salvar"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Segurança</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">Troque sua senha de acesso ao painel do sistema.</p>
                <Button size="sm" variant="outline" onClick={() => setShowChangePassword(true)} data-testid="button-open-change-password">
                  <KeyRound className="w-4 h-4 mr-1" /> Trocar senha
                </Button>
              </CardContent>
            </Card>
          </div>
        </DialogContent>
      </Dialog>

      {/* Nova loja */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Nova loja (lojista)</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome da loja</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Celulares do João" data-testid="input-tenant-name" />
            </div>
            <div>
              <Label>Nome completo / Razão social</Label>
              <Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} data-testid="input-tenant-contact-name" />
            </div>
            <div>
              <Label>CPF ou CNPJ</Label>
              <Input value={form.cpfCnpj} onChange={(e) => setForm({ ...form, cpfCnpj: e.target.value })} placeholder="Só números ou com máscara" data-testid="input-tenant-cpf-cnpj" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>E-mail de contato</Label>
                <Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} data-testid="input-tenant-contact-email" />
              </div>
              <div>
                <Label>Telefone</Label>
                <Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} data-testid="input-tenant-contact-phone" />
              </div>
            </div>

            <div className="pt-2 border-t">
              <Label>Pacote de módulos</Label>
              <ModulePicker value={form.enabledModules} onChange={(enabledModules) => setForm({ ...form, enabledModules })} />
            </div>

            <p className="text-xs text-muted-foreground pt-2 border-t">Opcional: já criar o admin da loja (ele será obrigado a trocar a senha no primeiro acesso).</p>
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
                contactName: form.contactName.trim() || undefined,
                contactEmail: form.contactEmail.trim() || undefined,
                contactPhone: form.contactPhone.trim() || undefined,
                cpfCnpj: form.cpfCnpj.trim() || undefined,
                enabledModules: form.enabledModules,
                adminName: form.adminName.trim() || undefined,
                adminEmail: form.adminEmail.trim() || undefined,
                adminPassword: form.adminPassword || undefined,
              }), "Loja criada", () => { setCreateOpen(false); setForm(emptyForm); })}>
              Criar loja
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Entrar como: motivo obrigatório (Fase 2) + escolher qual admin,
          quando a loja tem mais de um ativo. */}
      <Dialog open={!!impersonateFor} onOpenChange={(o) => { if (!o) closeImpersonateDialog(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Entrar como admin de {impersonateFor?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {(() => {
              const activeAdmins = impersonateFor?.admins.filter((a) => a.isActive) ?? [];
              return activeAdmins.length > 1 ? (
                <div className="space-y-2">
                  <Label>Qual admin?</Label>
                  {activeAdmins.map((a) => (
                    <Button key={a.id} type="button"
                      variant={impersonateAdminId === a.id ? "default" : "outline"}
                      className="w-full justify-start"
                      onClick={() => setImpersonateAdminId(a.id)} data-testid={`button-impersonate-as-${a.id}`}>
                      {a.name} ({a.email})
                    </Button>
                  ))}
                </div>
              ) : null;
            })()}
            <div>
              <Label>Motivo de entrar como este admin</Label>
              <Select value={impersonateReason} onValueChange={setImpersonateReason}>
                <SelectTrigger data-testid="select-impersonate-reason"><SelectValue placeholder="Selecione o motivo" /></SelectTrigger>
                <SelectContent>
                  {IMPERSONATE_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {impersonateReason === "Outro" && (
              <div>
                <Label>Descreva o motivo</Label>
                <Textarea value={impersonateReasonDetail} onChange={(e) => setImpersonateReasonDetail(e.target.value)}
                  rows={2} data-testid="input-impersonate-reason-detail" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeImpersonateDialog}>Cancelar</Button>
            <Button
              disabled={impersonating || impersonateAdminId == null || !impersonateReason || (impersonateReason === "Outro" && !impersonateReasonDetail.trim())}
              onClick={confirmImpersonate} data-testid="button-confirm-impersonate">
              {impersonating ? "Entrando..." : "Entrar"}
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

      {/* Módulos da loja */}
      <Dialog open={!!modulesFor} onOpenChange={(o) => { if (!o) setModulesFor(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Módulos · {modulesFor?.name}</DialogTitle></DialogHeader>
          <ModulePicker value={modulesForm} onChange={setModulesForm} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setModulesFor(null)}>Cancelar</Button>
            <Button disabled={busy} data-testid="button-save-modules"
              onClick={() => modulesFor && run(() => api.superadmin.updateTenant(modulesFor.id, {
                enabledModules: modulesForm,
              }), "Módulos atualizados", () => setModulesFor(null))}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plano & Limites de UMA loja (Fase 3) */}
      <Dialog open={!!limitsFor} onOpenChange={(o) => { if (!o) setLimitsFor(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Plano & Limites · {limitsFor?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Plano</Label>
              <Select value={limitsForm.planId || "none"} onValueChange={(v) => setLimitsForm({ ...limitsForm, planId: v === "none" ? "" : v })}>
                <SelectTrigger data-testid="select-tenant-plan"><SelectValue placeholder="Sem plano (tudo ilimitado)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem plano (tudo ilimitado)</SelectItem>
                  {plans.filter((p) => p.isActive).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={limitsForm.usesCustomLimits}
                onChange={(e) => setLimitsForm({ ...limitsForm, usesCustomLimits: e.target.checked })}
                data-testid="checkbox-custom-limits" />
              Personalizar limites pra esta loja (negociação diferente do padrão do plano)
            </label>

            {limitsForm.usesCustomLimits && (
              <div className="grid grid-cols-2 gap-2 border rounded-lg p-3 bg-muted/20">
                {LIMIT_FIELDS.map((f) => (
                  <div key={f}>
                    <Label className="text-xs">{LIMIT_LABELS[f]}</Label>
                    <Input type="number" min={0} placeholder="Ilimitado" value={limitsForm[f]}
                      onChange={(e) => setLimitsForm({ ...limitsForm, [f]: e.target.value })}
                      data-testid={`input-custom-limit-${f}`} />
                  </div>
                ))}
              </div>
            )}

            {limitsFor?.planUsage && (
              <div className="border-t pt-3 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Uso atual</Label>
                {limitsFor.planUsage.items.map((it) => {
                  const pct = it.limit == null ? 0 : Math.min(100, (it.used / Math.max(it.limit, 1)) * 100);
                  const near = it.limit != null && it.used >= it.limit * 0.8;
                  return (
                    <div key={it.field} className="text-xs">
                      <div className="flex justify-between">
                        <span className={near ? "text-amber-600 font-medium" : "text-muted-foreground"}>{it.label}</span>
                        <span className={near ? "text-amber-600 font-medium" : ""}>{it.used} de {it.limit ?? "∞"}{!it.enforced ? " (não bloqueado ainda)" : ""}</span>
                      </div>
                      {it.limit != null && (
                        <div className="h-1.5 rounded-full bg-muted mt-0.5 overflow-hidden">
                          <div className={`h-full ${it.used >= it.limit ? "bg-red-500" : near ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimitsFor(null)}>Cancelar</Button>
            <Button disabled={busy} data-testid="button-save-limits" onClick={saveLimits}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Criar/editar plano do catálogo (Fase 3) */}
      <Dialog open={!!planFor} onOpenChange={(o) => { if (!o) setPlanFor(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{planFor === "new" ? "Novo plano" : `Editar plano · ${(planFor as Plan | null)?.name ?? ""}`}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome do plano</Label>
              <Input value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} placeholder="Ex.: Pro" data-testid="input-plan-name" />
            </div>
            <p className="text-xs text-muted-foreground">Deixe um campo em branco para "Ilimitado" nesse recurso.</p>
            <div className="grid grid-cols-2 gap-2">
              {LIMIT_FIELDS.map((f) => (
                <div key={f}>
                  <Label className="text-xs">{LIMIT_LABELS[f]}</Label>
                  <Input type="number" min={0} placeholder="Ilimitado" value={planForm[f]}
                    onChange={(e) => setPlanForm({ ...planForm, [f]: e.target.value })}
                    data-testid={`input-plan-${f}`} />
                </div>
              ))}
            </div>
            {planFor !== "new" && (
              <label className="flex items-center gap-2 text-sm pt-2 border-t">
                <input type="checkbox" checked={planForm.isActive}
                  onChange={(e) => setPlanForm({ ...planForm, isActive: e.target.checked })}
                  data-testid="checkbox-plan-active" />
                Plano ativo (aparece como opção pra novas lojas)
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanFor(null)}>Cancelar</Button>
            <Button disabled={busy || !planForm.name.trim()} data-testid="button-save-plan" onClick={savePlan}>
              {planFor === "new" ? "Criar plano" : "Salvar"}
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

      {/* Detalhe do chamado: timeline + resposta + situação/prioridade/categoria */}
      <Dialog open={!!ticketDetail} onOpenChange={(open) => { if (!open) { setTicketDetail(null); setTicketMessages([]); setTicketReply(""); setResolvingStatus(false); setResolutionDraft(""); } }}>
        <DialogContent className="max-w-2xl">
          {ticketDetail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 flex-wrap pr-6">
                  {ticketDetail.title}
                  {slaBadge(ticketDetail)}
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  {ticketDetail.tenantName}{ticketDetail.storeName ? ` (${ticketDetail.storeName})` : ""}{ticketDetail.openedByUserName ? ` · aberto por ${ticketDetail.openedByUserName}` : ""} · aberto em {fmtDateTime(ticketDetail.createdAt)}
                </p>
              </DialogHeader>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Situação</Label>
                  <Select value={resolvingStatus ? "resolvido" : ticketDetail.status} onValueChange={handleTicketStatusChange}>
                    <SelectTrigger data-testid="select-ticket-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TICKET_STATUS_META) as TicketStatus[]).map((s) => <SelectItem key={s} value={s}>{TICKET_STATUS_META[s].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Prioridade</Label>
                  <Select value={ticketDetail.priority} onValueChange={(v) => updateTicketField({ priority: v as TicketPriority })}>
                    <SelectTrigger data-testid="select-ticket-priority"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TICKET_PRIORITY_META) as TicketPriority[]).map((p) => <SelectItem key={p} value={p}>{TICKET_PRIORITY_META[p].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Categoria</Label>
                  <Select value={ticketDetail.category} onValueChange={(v) => updateTicketField({ category: v as TicketCategory })}>
                    <SelectTrigger data-testid="select-ticket-category"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TICKET_CATEGORY_META) as TicketCategory[]).map((c) => <SelectItem key={c} value={c}>{TICKET_CATEGORY_META[c].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {resolvingStatus ? (
                <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 space-y-2">
                  <Label className="text-xs font-semibold text-emerald-800">Qual foi a solução aplicada?</Label>
                  <Textarea rows={3} value={resolutionDraft} onChange={(e) => setResolutionDraft(e.target.value)}
                    placeholder="Descreva o que foi feito pra resolver este chamado..." data-testid="input-resolution-note"
                    className="bg-white" autoFocus />
                  <div className="flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setResolvingStatus(false)} data-testid="button-cancel-resolve">
                      Cancelar
                    </Button>
                    <Button size="sm" onClick={confirmResolve} disabled={!resolutionDraft.trim()} data-testid="button-confirm-resolve">
                      Marcar como resolvido
                    </Button>
                  </div>
                </div>
              ) : ticketDetail.resolutionNote ? (
                <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <Label className="text-xs font-semibold text-emerald-800">✅ Solução aplicada</Label>
                    <button onClick={openEditResolution} data-testid="button-edit-resolution"
                      className="text-[11px] font-semibold text-emerald-700 hover:underline shrink-0">
                      Editar
                    </button>
                  </div>
                  <p className="text-sm text-emerald-900 whitespace-pre-wrap break-words">{ticketDetail.resolutionNote}</p>
                </div>
              ) : null}

              <div className="border rounded-lg max-h-80 overflow-y-auto p-3 space-y-2 bg-muted/20">
                {ticketMessages.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">Nenhuma mensagem ainda.</p>
                ) : ticketMessages.map((m) => (
                  <div key={m.id} className={`flex ${m.authorType === "superadmin" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${m.authorType === "superadmin" ? "bg-primary text-primary-foreground" : "bg-white border"}`}>
                      {m.authorType === "tenant" && <p className="text-[11px] font-semibold mb-0.5 opacity-70">{m.authorName}</p>}
                      {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
                      {m.mediaUrl && (
                        m.mediaType?.startsWith("image/") ? (
                          <img src={m.mediaUrl} alt="Anexo" className="mt-1 rounded-lg max-w-full max-h-56 object-contain" />
                        ) : m.mediaType?.startsWith("video/") ? (
                          <video src={m.mediaUrl} controls className="mt-1 rounded-lg max-w-full max-h-56" />
                        ) : (
                          <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="mt-1 text-xs underline block">📎 Ver anexo</a>
                        )
                      )}
                      <p className={`text-[10px] mt-1 ${m.authorType === "superadmin" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{fmtDateTime(m.createdAt)}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Input value={ticketReply} onChange={(e) => setTicketReply(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendTicketReply(); }}
                  placeholder="Responder pra loja..." data-testid="input-ticket-reply" />
                <Button onClick={sendTicketReply} disabled={!ticketReply.trim() || sendingReply} data-testid="button-send-ticket-reply">
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {showChangePassword && (
        <ChangePasswordModal onDone={() => { setShowChangePassword(false); toast({ title: "Senha alterada com sucesso!" }); }}
          onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  );
}
