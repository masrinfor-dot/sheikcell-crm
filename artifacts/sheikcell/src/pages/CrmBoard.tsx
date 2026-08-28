import { useState, useEffect, useCallback, useRef } from "react";
import { api, canEditModule, type CrmContact, type Sector, type CrmCustomField, type CrmCustomFieldType, type Store } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import CrmContactDetail from "@/components/CrmContactDetail";
import { acquireSharedEventSource, releaseSharedEventSource } from "@/lib/sharedEventSource";

const CHAT_EVENTS_URL = "/api/chat/events";
import {
  Plus, X, Phone, Tag, StickyNote, RefreshCw, Archive, MapPin,
  ChevronRight, ChevronLeft, Crown, Star, UserPlus, UserMinus,
  Search, Filter, ExternalLink, ShoppingBag, SlidersHorizontal, Trash2, GripVertical,
  Kanban, BookUser, Mail, Users,
} from "lucide-react";

const FIELD_TYPES: { value: CrmCustomFieldType; label: string }[] = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "date", label: "Data" },
  { value: "select", label: "Lista de opções" },
  { value: "textarea", label: "Texto longo" },
];

const COLUMNS = [
  { key: "potential" as const, label: "Potenciais", color: "bg-purple-500", light: "bg-purple-50", border: "border-purple-200", text: "text-purple-700" },
  { key: "pending"  as const, label: "Pendentes",  color: "bg-amber-500",  light: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-700"  },
  { key: "active"   as const, label: "Ativos",     color: "bg-green-500",  light: "bg-green-50",  border: "border-green-200",  text: "text-green-700"  },
] as const;

type Status = typeof COLUMNS[number]["key"];

type ContactFormData = {
  name: string; contact: string; sectorId: string;
  notes: string; tags: string; status: Status; profile: CrmContact["profile"];
};

const emptyForm: ContactFormData = {
  name: "", contact: "", sectorId: "", notes: "", tags: "", status: "potential", profile: "Novo",
};

const PROFILE_META: Record<CrmContact["profile"], { label: string; color: string; Icon: React.ElementType }> = {
  VIP:    { label: "VIP",     color: "bg-yellow-100 text-yellow-800 border-yellow-200", Icon: Crown     },
  Regular:{ label: "Regular", color: "bg-blue-100 text-blue-800 border-blue-200",       Icon: Star      },
  Novo:   { label: "Novo",    color: "bg-green-100 text-green-800 border-green-200",    Icon: UserPlus  },
  Inativo:{ label: "Inativo", color: "bg-gray-100 text-gray-600 border-gray-200",       Icon: UserMinus },
};

function ProfileBadge({ profile }: { profile: CrmContact["profile"] }) {
  const m = PROFILE_META[profile] ?? PROFILE_META.Novo;
  const { Icon } = m;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${m.color}`}>
      <Icon className="w-2.5 h-2.5" />{m.label}
    </span>
  );
}

function fmtCurrency(val: string | number) {
  const n = parseFloat(String(val));
  if (isNaN(n) || n === 0) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function ContactCard({
  contact, onMove, onEdit, onArchive, onOpen, colIdx, canEdit,
}: {
  contact: CrmContact;
  onMove: (id: number, status: Status) => void;
  onEdit: (c: CrmContact) => void;
  onArchive: (id: number) => void;
  onOpen: (c: CrmContact) => void;
  colIdx: number;
  canEdit: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const prev = COLUMNS[colIdx - 1];
  const next = COLUMNS[colIdx + 1];
  const total = fmtCurrency(contact.totalPurchases ?? "0");

  return (
    <div
      className="bg-white rounded-2xl border border-border shadow-sm p-4 space-y-2 hover:shadow-md transition group"
      data-testid={`crm-card-${contact.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="font-semibold text-sm text-foreground truncate">{contact.name}</p>
            <ProfileBadge profile={contact.profile} />
          </div>
          {contact.contact && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Phone className="w-3 h-3" />{contact.contact}
            </p>
          )}
          {total && (
            <p className="text-xs text-primary font-semibold flex items-center gap-1 mt-0.5">
              <ShoppingBag className="w-3 h-3" />{total}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onOpen(contact)}
            data-testid={`crm-card-open-${contact.id}`}
            className="p-1.5 rounded-lg text-primary hover:bg-primary hover:text-white transition"
            title="Ver perfil completo"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="p-1 rounded-lg text-muted-foreground hover:bg-secondary transition"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <circle cx="10" cy="4" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="16" r="1.5"/>
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-7 z-20 bg-white border border-border rounded-xl shadow-lg p-1 min-w-[160px]">
                <button onClick={() => { onOpen(contact); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                  <ExternalLink className="w-3 h-3" /> Ver perfil completo
                </button>
                {canEdit && (
                  <>
                    <button onClick={() => { onEdit(contact); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                      <Plus className="w-3 h-3" /> Editar
                    </button>
                    {prev && (
                      <button onClick={() => { onMove(contact.id, prev.key); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                        <ChevronLeft className="w-3 h-3" /> Mover para {prev.label}
                      </button>
                    )}
                    {next && (
                      <button onClick={() => { onMove(contact.id, next.key); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                        <ChevronRight className="w-3 h-3" /> Mover para {next.label}
                      </button>
                    )}
                    <button onClick={() => { onArchive(contact.id); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg text-destructive hover:bg-destructive/10 transition">
                      <Archive className="w-3 h-3" /> Arquivar
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {(contact.sector || contact.serviceStore) && (
        <div className="flex flex-wrap items-center gap-1">
          {contact.sector && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium text-white"
              style={{ backgroundColor: contact.sector.color }}
            >
              {contact.sector.name}
            </span>
          )}
          {contact.serviceStore && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground flex items-center gap-0.5" data-testid={`crm-card-store-${contact.id}`}>
              <MapPin className="w-2.5 h-2.5" />{contact.serviceStore}
            </span>
          )}
        </div>
      )}

      {contact.notes && (
        <p className="text-xs text-muted-foreground italic flex items-start gap-1">
          <StickyNote className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="line-clamp-2">{contact.notes}</span>
        </p>
      )}

      {contact.tags && (
        <div className="flex flex-wrap gap-1">
          {contact.tags.split(",").map((t) => t.trim()).filter(Boolean).map((tag) => (
            <span key={tag} className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full flex items-center gap-0.5">
              <Tag className="w-2.5 h-2.5" />{tag}
            </span>
          ))}
        </div>
      )}

      {contact.attendant && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground pt-1 border-t border-border">
          <UserPlus className="w-3 h-3" />
          <span>{contact.attendant.name}</span>
        </div>
      )}
    </div>
  );
}

export default function CrmBoard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [filterStore, setFilterStore] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<CrmContact | null>(null);
  const [form, setForm] = useState<ContactFormData>(emptyForm);
  const [searchQ, setSearchQ] = useState("");
  const [filterProfile, setFilterProfile] = useState<string>("");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [autoImporting, setAutoImporting] = useState(false);
  const [showFieldsManager, setShowFieldsManager] = useState(false);
  // "Agenda de Contatos": mesma lista/filtros do Quadro, só que como
  // diretório simples (nome/telefone/e-mail) em vez de pipeline por status —
  // útil pra achar rápido o contato de alguém sem precisar procurar em qual
  // coluna do Kanban ele está.
  const [viewMode, setViewMode] = useState<"board" | "agenda">("board");
  // Conversas finalizadas (atendimentos resolvidos no chat) — o servidor já
  // aplica o escopo por papel/setor, então basta contar o retorno.
  const [finalizadasCount, setFinalizadasCount] = useState(0);
  const canEdit = canEditModule(user, "crm");
  const canManageFields = (user?.role === "admin" || user?.role === "supervisor") && canEdit;

  const fetchFinalizadas = useCallback(async () => {
    try {
      // Mesma regra do ChatCenter ("Resolvidas"): status resolved OU archived.
      const [resolved, archived] = await Promise.all([
        api.chat.conversations({ status: "resolved" }),
        api.chat.conversations({ status: "archived" }),
      ]);
      setFinalizadasCount(resolved.length + archived.length);
    } catch { /* silent */ }
  }, []);

  const fetchContacts = useCallback(async () => {
    try {
      const data = await api.crm.list({ profile: filterProfile || undefined, search: searchQ || undefined });
      setContacts(data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [filterProfile, searchQ]);

  useEffect(() => {
    setLoading(true);
    fetchContacts();
    api.sectors.list().then(setSectors).catch(() => {});
    api.stores.list(true).then(setStores).catch(() => {});
  }, [fetchContacts]);

  useEffect(() => { fetchFinalizadas(); }, [fetchFinalizadas]);

  // ── Real-time sync: reflect CRM changes from any user instantly ──
  const filterProfileRef = useRef(filterProfile);
  const searchQRef = useRef(searchQ);
  const fetchContactsRef = useRef(fetchContacts);
  const searchRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { filterProfileRef.current = filterProfile; }, [filterProfile]);
  useEffect(() => { searchQRef.current = searchQ; }, [searchQ]);
  useEffect(() => { fetchContactsRef.current = fetchContacts; }, [fetchContacts]);
  const fetchFinalizadasRef = useRef(fetchFinalizadas);
  useEffect(() => { fetchFinalizadasRef.current = fetchFinalizadas; }, [fetchFinalizadas]);

  useEffect(() => {
    const es = acquireSharedEventSource(CHAT_EVENTS_URL);

    // While a search is active the server-side match spans many fields, so we
    // can't reliably decide client-side whether a changed row still matches.
    // Debounce a scoped refetch instead of a surgical upsert.
    const scheduleSearchRefetch = () => {
      if (searchRefetchTimer.current) return;
      searchRefetchTimer.current = setTimeout(() => {
        searchRefetchTimer.current = null;
        fetchContactsRef.current();
      }, 500);
    };

    const upsert = (c: CrmContact) => {
      if (searchQRef.current) { scheduleSearchRefetch(); return; }
      setContacts((prev) => {
        const exists = prev.some((x) => x.id === c.id);
        // Respect the active profile filter so events don't inject off-filter rows.
        const profileOk = !filterProfileRef.current || c.profile === filterProfileRef.current;
        if (!profileOk) return exists ? prev.filter((x) => x.id !== c.id) : prev;
        if (exists) return prev.map((x) => (x.id === c.id ? { ...x, ...c } : x));
        return [c, ...prev];
      });
    };

    const onContactCreated = (e: Event) => {
      try { upsert(JSON.parse((e as MessageEvent).data) as CrmContact); } catch { /* ignore */ }
    };
    const onContactUpdated = (e: Event) => {
      try { upsert(JSON.parse((e as MessageEvent).data) as CrmContact); } catch { /* ignore */ }
    };
    const onContactDeleted = (e: Event) => {
      try {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: number };
        setContacts((prev) => prev.filter((x) => x.id !== id));
      } catch { /* ignore */ }
    };
    es.addEventListener("crm_contact_created", onContactCreated);
    es.addEventListener("crm_contact_updated", onContactUpdated);
    es.addEventListener("crm_contact_deleted", onContactDeleted);

    // Keep the "Conversas finalizadas" counter live: conversation status
    // changes (resolve/reopen) arrive as conversation_updated. Debounce the
    // recount to avoid bursts.
    let finalizadasTimer: ReturnType<typeof setTimeout> | null = null;
    const onConversationUpdated = () => {
      if (finalizadasTimer) return;
      finalizadasTimer = setTimeout(() => {
        finalizadasTimer = null;
        fetchFinalizadasRef.current();
      }, 500);
    };
    es.addEventListener("conversation_updated", onConversationUpdated);

    return () => {
      es.removeEventListener("crm_contact_created", onContactCreated);
      es.removeEventListener("crm_contact_updated", onContactUpdated);
      es.removeEventListener("crm_contact_deleted", onContactDeleted);
      es.removeEventListener("conversation_updated", onConversationUpdated);
      releaseSharedEventSource(CHAT_EVENTS_URL);
      if (searchRefetchTimer.current) { clearTimeout(searchRefetchTimer.current); searchRefetchTimer.current = null; }
      if (finalizadasTimer) { clearTimeout(finalizadasTimer); finalizadasTimer = null; }
    };
  }, []);

  const openAdd = () => {
    setEditTarget(null);
    setForm({ ...emptyForm, sectorId: user?.sectorId ? String(user.sectorId) : "" });
    setShowForm(true);
  };

  const openEdit = (c: CrmContact) => {
    setEditTarget(c);
    setForm({
      name: c.name, contact: c.contact ?? "", sectorId: c.sectorId ? String(c.sectorId) : "",
      notes: c.notes ?? "", tags: c.tags ?? "", status: c.status as Status, profile: c.profile,
    });
    setShowForm(true);
  };

  const handleMove = async (id: number, status: Status) => {
    try {
      await api.crm.update(id, { status });
      setContacts((prev) => prev.map((c) => c.id === id ? { ...c, status } : c));
    } catch { toast({ title: "Erro ao mover contato", variant: "destructive" }); }
  };

  const handleArchive = async (id: number) => {
    try {
      await api.crm.remove(id);
      setContacts((prev) => prev.filter((c) => c.id !== id));
      toast({ title: "Contato arquivado" });
    } catch { toast({ title: "Erro ao arquivar", variant: "destructive" }); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: form.name, contact: form.contact || undefined,
      sectorId: form.sectorId ? Number(form.sectorId) : undefined,
      notes: form.notes || undefined, tags: form.tags || undefined,
      status: form.status, profile: form.profile,
    };
    try {
      if (editTarget) {
        const updated = await api.crm.update(editTarget.id, payload);
        setContacts((prev) => prev.map((c) => c.id === editTarget.id ? { ...c, ...updated } : c));
        toast({ title: "Contato atualizado!" });
      } else {
        const created = await api.crm.create(payload);
        setContacts((prev) => [created, ...prev]);
        toast({ title: "Contato adicionado!" });
      }
      setShowForm(false);
      fetchContacts();
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const handleAutoImport = async () => {
    setAutoImporting(true);
    try {
      const logs = await api.admin.logs({ limit: 50 });
      let imported = 0;
      for (const log of logs) {
        if (!log.clientName) continue;
        const result = await api.crm.autoRegister({
          name: log.clientName,
          phone: log.clientContact ?? undefined,
          contact: log.clientContact ?? undefined,
          sectorId: log.sectorId,
        });
        if ((result as CrmContact & { created: boolean }).created) imported++;
      }
      toast({ title: `Auto-importação concluída`, description: `${imported} novo(s) cliente(s) cadastrado(s)` });
      fetchContacts();
    } catch { toast({ title: "Erro na importação", variant: "destructive" }); }
    setAutoImporting(false);
  };

  const handleContactUpdated = (updated: CrmContact) => {
    setContacts((prev) => prev.map((c) => c.id === updated.id ? updated : c));
  };

  // Stats
  const vipCount = contacts.filter((c) => c.profile === "VIP").length;
  const totalRevenue = contacts.reduce((sum, c) => sum + parseFloat(c.totalPurchases ?? "0"), 0);

  // Filtro por loja de atendimento é aplicado no cliente: a lista já está em
  // memória e assim o filtro também vale para cartões vindos via SSE.
  const visibleContacts = filterStore
    ? contacts.filter((c) => (c.serviceStore ?? "") === filterStore)
    : contacts;

  const byStatus = (status: Status) => visibleContacts.filter((c) => c.status === status);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-bold text-foreground">CRM — Pipeline de Clientes</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Gerencie relacionamentos e histórico de clientes</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && (
            <button onClick={handleAutoImport} disabled={autoImporting}
              className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-xl text-xs font-medium text-muted-foreground hover:bg-secondary transition disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${autoImporting ? "animate-spin" : ""}`} />
              {autoImporting ? "Importando…" : "Auto-importar"}
            </button>
          )}
          <button onClick={fetchContacts}
            className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
            <RefreshCw className="w-4 h-4" />
          </button>
          {canManageFields && (
            <button onClick={() => setShowFieldsManager(true)} data-testid="button-crm-custom-fields"
              className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-xl text-xs font-medium text-muted-foreground hover:bg-secondary transition">
              <SlidersHorizontal className="w-3.5 h-3.5" /> Campos
            </button>
          )}
          {canEdit && (
            <button onClick={openAdd} data-testid="button-crm-add"
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
              <Plus className="w-3.5 h-3.5" /> Novo Contato
            </button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Total", value: contacts.length, color: "text-foreground" },
          { label: "VIP",   value: vipCount,         color: "text-yellow-600" },
          { label: "Ativos",value: byStatus("active").length, color: "text-green-600" },
          { label: "Conversas finalizadas", value: finalizadasCount, color: "text-gray-600" },
          { label: "Receita",value: totalRevenue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }), color: "text-primary" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-xl border border-border p-3 text-center">
            <p className={`text-lg font-bold ${color}`}>{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Buscar cliente…"
            className="w-full pl-8 pr-3 py-2 rounded-xl border border-border text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-muted-foreground" />
          <select value={filterProfile} onChange={(e) => setFilterProfile(e.target.value)}
            className="px-2 py-2 rounded-xl border border-border text-xs">
            <option value="">Todos os perfis</option>
            {(["VIP", "Regular", "Novo", "Inativo"] as const).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select value={filterStore} onChange={(e) => setFilterStore(e.target.value)}
            className="px-2 py-2 rounded-xl border border-border text-xs" data-testid="crm-filter-store">
            <option value="">Todas as lojas</option>
            {stores.map((s) => (
              <option key={s.id} value={s.name}>{s.name}</option>
            ))}
          </select>
        </div>
        {/* Quadro (pipeline por status) x Agenda (diretório simples de contatos) */}
        <div className="flex items-center gap-1 border border-border rounded-xl p-0.5 ml-auto">
          <button onClick={() => setViewMode("board")} data-testid="button-crm-view-board"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              viewMode === "board" ? "bg-primary text-white" : "text-muted-foreground hover:bg-secondary"
            }`}>
            <Kanban className="w-3.5 h-3.5" /> Quadro
          </button>
          <button onClick={() => setViewMode("agenda")} data-testid="button-crm-view-agenda"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              viewMode === "agenda" ? "bg-primary text-white" : "text-muted-foreground hover:bg-secondary"
            }`}>
            <BookUser className="w-3.5 h-3.5" /> Agenda
          </button>
        </div>
      </div>

      {/* Agenda de Contatos: diretório simples, ordenado por nome, com busca/filtro
          idênticos ao Quadro acima (mesma lista visibleContacts). */}
      {viewMode === "agenda" && (
        loading ? (
          <div className="h-40 rounded-xl bg-secondary/40 animate-pulse" />
        ) : visibleContacts.length === 0 ? (
          <div className="shk-card p-10 text-center">
            <BookUser className="w-8 h-8 mx-auto text-muted-foreground mb-2 opacity-40" />
            <p className="text-muted-foreground text-sm">Nenhum contato encontrado</p>
          </div>
        ) : (
          <div className="shk-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50">
                  <tr>
                    {["Nome", "Telefone", "E-mail", "Setor", "Atendente", "Loja", "Perfil", ""].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...visibleContacts].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")).map((c, i) => (
                    <tr key={c.id} className={`${i % 2 === 0 ? "bg-white" : "bg-secondary/20"} hover:bg-secondary/40 cursor-pointer transition`}
                      onClick={() => setDetailId(c.id)} data-testid={`row-agenda-${c.id}`}>
                      <td className="px-4 py-3 font-medium whitespace-nowrap">{c.name}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {/* Ficha de grupo/comunidade do WhatsApp: "contact" guarda o JID
                            (...@g.us), não um telefone de pessoa física -- mostra o rótulo
                            em vez do JID cru. */}
                        {(c.contact ?? "").includes("@g.us") ? (
                          <span className="flex items-center gap-1"><Users className="w-3 h-3" /> Grupo do WhatsApp</span>
                        ) : (c.phone || c.contact) ? (
                          <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {c.phone ?? c.contact}</span>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {c.email ? <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {c.email}</span> : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{c.sector?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{c.attendant?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{c.serviceStore ?? "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap"><ProfileBadge profile={c.profile} /></td>
                      <td className="px-4 py-3 text-right"><ExternalLink className="w-3.5 h-3.5 text-muted-foreground" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* Kanban */}
      {viewMode === "board" && (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
        {COLUMNS.map((col, colIdx) => {
          const cards = byStatus(col.key);
          return (
            <div key={col.key} className={`rounded-2xl ${col.light} border ${col.border} p-4`} data-testid={`crm-col-${col.key}`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${col.color}`} />
                  <span className={`text-sm font-bold ${col.text}`}>{col.label}</span>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${col.light} ${col.text} border ${col.border}`}>
                  {loading ? "…" : cards.length}
                </span>
              </div>
              <div className="space-y-3">
                {loading ? (
                  <div className="h-20 rounded-xl bg-white/60 animate-pulse" />
                ) : cards.length === 0 ? (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    <p>Nenhum contato aqui</p>
                    {canEdit && (
                      <button onClick={openAdd} className={`mt-2 ${col.text} font-semibold underline underline-offset-2`}>
                        Adicionar
                      </button>
                    )}
                  </div>
                ) : (
                  cards.map((c) => (
                    <ContactCard
                      key={c.id} contact={c} onMove={handleMove}
                      onEdit={openEdit} onArchive={handleArchive}
                      onOpen={(contact) => setDetailId(contact.id)}
                      colIdx={colIdx} canEdit={canEdit}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* Add/Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editTarget ? "Editar Contato" : "Novo Contato"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome *</label>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: João da Silva" data-testid="input-crm-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Contato (WhatsApp / Instagram)</label>
                <input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })}
                  placeholder="33 99999-0000"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium mb-1 block">Etapa</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Perfil</label>
                  <select value={form.profile} onChange={(e) => setForm({ ...form, profile: e.target.value as CrmContact["profile"] })}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                    {(["Novo", "Regular", "VIP", "Inativo"] as const).map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Setor de interesse</label>
                <select value={form.sectorId} onChange={(e) => setForm({ ...form, sectorId: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  <option value="">— Nenhum —</option>
                  {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Tags (separadas por vírgula)</label>
                <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="Ex: iPhone, Urgente, Financiado"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Observações</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Ex: Interessado em iPhone 15, aguarda promoção..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
                  Cancelar
                </button>
                <button type="submit" data-testid="button-crm-save"
                  className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition">
                  {editTarget ? "Salvar" : "Adicionar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Contact Detail Panel */}
      {detailId !== null && (
        <CrmContactDetail
          contactId={detailId}
          onClose={() => setDetailId(null)}
          onContactUpdated={handleContactUpdated}
          sectors={sectors}
        />
      )}

      {/* Custom Fields Manager */}
      {showFieldsManager && (
        <CustomFieldsManager onClose={() => setShowFieldsManager(false)} />
      )}
    </div>
  );
}

function CustomFieldsManager({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [fields, setFields] = useState<CrmCustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ name: string; type: CrmCustomFieldType; options: string }>({
    name: "", type: "text", options: "",
  });

  const load = useCallback(async () => {
    try { setFields(await api.crm.customFields.list()); }
    catch { toast({ title: "Erro ao carregar campos", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      const created = await api.crm.customFields.create({
        name: draft.name.trim(),
        type: draft.type,
        options: draft.type === "select" ? draft.options : undefined,
        sortOrder: fields.length,
      });
      setFields((prev) => [...prev, created]);
      setDraft({ name: "", type: "text", options: "" });
      toast({ title: "Campo criado!" });
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
    setSaving(false);
  };

  const handleToggle = async (f: CrmCustomField) => {
    try {
      const updated = await api.crm.customFields.update(f.id, { isActive: !f.isActive });
      setFields((prev) => prev.map((x) => x.id === f.id ? updated : x));
    } catch { toast({ title: "Erro ao atualizar campo", variant: "destructive" }); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Excluir este campo? Os valores já preenchidos nos clientes deixarão de aparecer.")) return;
    try {
      await api.crm.customFields.remove(id);
      setFields((prev) => prev.filter((x) => x.id !== id));
      toast({ title: "Campo excluído" });
    } catch { toast({ title: "Erro ao excluir campo", variant: "destructive" }); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="shk-card w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold flex items-center gap-2"><SlidersHorizontal className="w-4 h-4" /> Campos personalizados</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>
        <p className="text-xs text-muted-foreground mb-4">Crie campos para personalizar os dados dos clientes. Eles aparecem na ficha de cada cliente.</p>

        {/* Existing fields */}
        <div className="space-y-2 mb-5">
          {loading ? (
            <div className="h-12 rounded-xl bg-secondary/60 animate-pulse" />
          ) : fields.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Nenhum campo criado ainda</p>
          ) : (
            fields.map((f) => (
              <div key={f.id} className="flex items-center gap-2 bg-secondary/50 rounded-xl px-3 py-2.5 border border-border">
                <GripVertical className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${f.isActive ? "" : "line-through text-muted-foreground"}`}>{f.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {FIELD_TYPES.find((t) => t.value === f.type)?.label ?? f.type}
                    {f.type === "select" && f.options ? ` · ${f.options}` : ""}
                  </p>
                </div>
                <button onClick={() => handleToggle(f)}
                  className={`text-xs px-2 py-1 rounded-lg border transition ${f.isActive ? "border-green-300 text-green-700 bg-green-50" : "border-border text-muted-foreground"}`}>
                  {f.isActive ? "Ativo" : "Inativo"}
                </button>
                <button onClick={() => handleDelete(f.id)} className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 hover:bg-red-50 transition">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* New field form */}
        <form onSubmit={handleCreate} className="space-y-3 border-t border-border pt-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Novo campo</p>
          <div>
            <label className="text-xs font-medium mb-1 block">Nome do campo *</label>
            <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Ex: CPF, Data de nascimento, Modelo do aparelho" data-testid="input-field-name"
              className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Tipo</label>
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as CrmCustomFieldType })}
              className="w-full px-3 py-2 rounded-xl border border-border text-sm">
              {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {draft.type === "select" && (
            <div>
              <label className="text-xs font-medium mb-1 block">Opções (separadas por vírgula)</label>
              <input value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })}
                placeholder="Ex: Pequeno, Médio, Grande"
                className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          )}
          <button type="submit" disabled={saving} data-testid="button-field-create"
            className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-60 flex items-center justify-center gap-2">
            <Plus className="w-4 h-4" /> {saving ? "Criando…" : "Adicionar campo"}
          </button>
        </form>
      </div>
    </div>
  );
}
