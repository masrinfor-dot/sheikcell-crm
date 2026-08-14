import { useState, useEffect, useCallback } from "react";
import {
  api, canEditModule, type CrmContact, type CrmPurchase, type CrmInternalNote,
  type AttendanceLog, type Sector, type CrmCustomField, type Store as StoreType,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  X, Crown, Star, UserPlus, UserMinus, ShoppingBag, MessageSquare,
  StickyNote, Phone, Mail, Pencil, Trash2, Plus, Check, Clock,
  ChevronDown, Package, Sparkles, MapPin, Store, Compass,
} from "lucide-react";

const PROFILES: { key: CrmContact["profile"]; label: string; color: string; Icon: React.ElementType }[] = [
  { key: "VIP",    label: "VIP",    color: "bg-yellow-100 text-yellow-800 border-yellow-300", Icon: Crown },
  { key: "Regular",label: "Regular",color: "bg-blue-100 text-blue-800 border-blue-300",       Icon: Star },
  { key: "Novo",   label: "Novo",   color: "bg-green-100 text-green-800 border-green-300",    Icon: UserPlus },
  { key: "Inativo",label: "Inativo",color: "bg-gray-100 text-gray-600 border-gray-300",       Icon: UserMinus },
];

const CATEGORIES = ["Celular", "Acessório", "Serviço", "Garantia", "Outro"];

const ATTENDANCE_SOURCES = ["WhatsApp", "Instagram", "Facebook", "Indicação", "Google", "Loja física", "Telefone", "Outro"];

function ProfileBadge({ profile }: { profile: CrmContact["profile"] }) {
  const p = PROFILES.find((x) => x.key === profile) ?? PROFILES[2];
  const { Icon } = p;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${p.color}`}>
      <Icon className="w-3 h-3" />{p.label}
    </span>
  );
}

function fmtCurrency(val: string | number) {
  const n = parseFloat(String(val));
  if (isNaN(n)) return "R$ 0,00";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Safely reads a custom-field value as a trimmed string, tolerating legacy/non-string jsonb values.
function cfValue(fields: Record<string, string> | null | undefined, id: number): string {
  const raw = fields?.[String(id)];
  return typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
}

type Tab = "overview" | "purchases" | "history" | "notes";

interface Props {
  contactId: number;
  onClose: () => void;
  onContactUpdated: (c: CrmContact) => void;
  sectors: Sector[];
}

export default function CrmContactDetail({ contactId, onClose, onContactUpdated, sectors }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = canEditModule(user, "crm");
  const [tab, setTab] = useState<Tab>("overview");
  const [contact, setContact] = useState<CrmContact | null>(null);
  const [purchases, setPurchases] = useState<CrmPurchase[]>([]);
  const [notes, setNotes] = useState<CrmInternalNote[]>([]);
  const [history, setHistory] = useState<AttendanceLog[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", contact: "", phone: "", email: "", notes: "", tags: "", sectorId: "", profile: "Novo" as CrmContact["profile"], isNew: true, city: "", serviceStore: "", attendanceSource: "" });

  // Lojas da rede (para o select "Loja para atendimento")
  const [storesList, setStoresList] = useState<StoreType[]>([]);
  useEffect(() => { api.stores.list().then(setStoresList).catch(() => {}); }, []);

  // Custom fields
  const [customDefs, setCustomDefs] = useState<CrmCustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  // Purchase form
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [purchaseForm, setPurchaseForm] = useState({ description: "", amount: "", category: "Celular", notes: "", purchaseDate: new Date().toISOString().slice(0, 10) });
  const [purchaseLoading, setPurchaseLoading] = useState(false);

  // Note form
  const [noteContent, setNoteContent] = useState("");
  const [noteLoading, setNoteLoading] = useState(false);

  const loadContact = useCallback(async () => {
    try {
      const c = await api.crm.get(contactId);
      setContact(c);
      setEditForm({
        name: c.name, contact: c.contact ?? "", phone: c.phone ?? "",
        email: c.email ?? "", notes: c.notes ?? "", tags: c.tags ?? "",
        sectorId: c.sectorId ? String(c.sectorId) : "", profile: c.profile,
        isNew: c.isNew ?? true, city: c.city ?? "",
        serviceStore: c.serviceStore ?? "", attendanceSource: c.attendanceSource ?? "",
      });
      setCustomValues(c.customFields ?? {});
    } catch { toast({ title: "Erro ao carregar contato", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [contactId, toast]);

  useEffect(() => { loadContact(); }, [loadContact]);

  useEffect(() => {
    api.crm.customFields.list().then((f) => setCustomDefs(f.filter((d) => d.isActive))).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "purchases") api.crm.purchases.list(contactId).then(setPurchases).catch(() => {});
    if (tab === "notes") api.crm.notes.list(contactId).then(setNotes).catch(() => {});
    if (tab === "history") api.crm.serviceHistory(contactId).then(setHistory).catch(() => {});
  }, [tab, contactId]);

  const handleSaveEdit = async () => {
    if (!contact) return;
    try {
      const updated = await api.crm.update(contact.id, {
        name: editForm.name, contact: editForm.contact || undefined,
        phone: editForm.phone || undefined, email: editForm.email || undefined,
        notes: editForm.notes || undefined, tags: editForm.tags || undefined,
        sectorId: editForm.sectorId ? Number(editForm.sectorId) : undefined,
        profile: editForm.profile,
        isNew: editForm.isNew,
        city: editForm.city,
        serviceStore: editForm.serviceStore,
        attendanceSource: editForm.attendanceSource,
        customFields: customValues,
      });
      setContact(updated);
      setCustomValues(updated.customFields ?? {});
      onContactUpdated(updated);
      setEditing(false);
      toast({ title: "Contato atualizado!" });
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const handleProfileChange = async (profile: CrmContact["profile"]) => {
    if (!contact) return;
    try {
      const updated = await api.crm.update(contact.id, { profile });
      setContact(updated);
      onContactUpdated(updated);
      toast({ title: `Perfil alterado para ${profile}` });
    } catch { toast({ title: "Erro ao alterar perfil", variant: "destructive" }); }
  };

  const handleAddPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!purchaseForm.description) return;
    setPurchaseLoading(true);
    try {
      await api.crm.purchases.create(contactId, {
        description: purchaseForm.description,
        amount: purchaseForm.amount || "0",
        category: purchaseForm.category,
        notes: purchaseForm.notes || undefined,
        purchaseDate: purchaseForm.purchaseDate,
      });
      // Reload both purchases list and contact in parallel so UI shows fresh data before toast
      const [ps, c] = await Promise.all([
        api.crm.purchases.list(contactId),
        api.crm.get(contactId),
      ]);
      setPurchases(ps);
      setContact(c);
      onContactUpdated(c);
      setPurchaseForm({ description: "", amount: "", category: "Celular", notes: "", purchaseDate: new Date().toISOString().slice(0, 10) });
      setShowPurchaseForm(false);
      toast({ title: "Compra registrada!" });
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
    setPurchaseLoading(false);
  };

  const handleDeletePurchase = async (purchaseId: number) => {
    try {
      await api.crm.purchases.remove(purchaseId);
      setPurchases((prev) => prev.filter((p) => p.id !== purchaseId));
      const c = await api.crm.get(contactId);
      setContact(c);
      onContactUpdated(c);
      toast({ title: "Compra removida" });
    } catch { toast({ title: "Erro ao remover compra", variant: "destructive" }); }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteContent.trim()) return;
    setNoteLoading(true);
    try {
      const n = await api.crm.notes.create(contactId, noteContent.trim());
      setNotes((prev) => [n, ...prev]);
      setNoteContent("");
      toast({ title: "Nota adicionada!" });
    } catch { toast({ title: "Erro ao salvar nota", variant: "destructive" }); }
    setNoteLoading(false);
  };

  const handleDeleteNote = async (noteId: number) => {
    try {
      await api.crm.notes.remove(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast({ title: "Nota removida" });
    } catch { toast({ title: "Erro ao remover nota", variant: "destructive" }); }
  };

  const TABS: { key: Tab; label: string; Icon: React.ElementType }[] = [
    { key: "overview",  label: "Perfil",       Icon: UserPlus },
    { key: "purchases", label: "Compras",       Icon: ShoppingBag },
    { key: "history",   label: "Atendimentos",  Icon: MessageSquare },
    { key: "notes",     label: "Notas",         Icon: StickyNote },
  ];

  if (loading || !contact) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full max-w-lg bg-background shadow-2xl flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  const totalPurchasesNum = parseFloat(contact.totalPurchases ?? "0");

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-background shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-right-8 duration-200">
        {/* Header */}
        <div className="bg-primary px-6 pt-6 pb-4 text-white shrink-0">
          <div className="flex items-start justify-between mb-3">
            <div className="flex-1 min-w-0">
              {editing ? (
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="text-xl font-bold bg-white/20 rounded-lg px-2 py-1 w-full text-white placeholder-white/60 focus:outline-none focus:bg-white/30"
                />
              ) : (
                <h2 className="text-xl font-bold truncate">{contact.name}</h2>
              )}
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <ProfileBadge profile={contact.profile} />
                {contact.sector && (
                  <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">{contact.sector.name}</span>
                )}
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/20 transition ml-2 shrink-0">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3 mt-3">
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <p className="text-xs text-white/70">Total Compras</p>
              <p className="font-bold text-sm mt-0.5">{fmtCurrency(totalPurchasesNum)}</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <p className="text-xs text-white/70">Pedidos</p>
              <p className="font-bold text-sm mt-0.5">{purchases.length || "—"}</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <p className="text-xs text-white/70">Cliente desde</p>
              <p className="font-bold text-sm mt-0.5">{fmtDate(contact.createdAt)}</p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border bg-background shrink-0 px-2">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 px-3 py-3 text-xs font-medium border-b-2 transition flex-1 justify-center ${
                tab === key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />{label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">

          {/* ── OVERVIEW ── */}
          {tab === "overview" && (
            <div className="p-5 space-y-5">
              {/* Profile selector */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Classificação por Perfil</p>
                <div className="grid grid-cols-2 gap-2">
                  {PROFILES.map(({ key, label, color, Icon }) => (
                    <button
                      key={key}
                      onClick={() => handleProfileChange(key)}
                      disabled={!canEdit}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed ${
                        contact.profile === key ? color + " border-current" : "border-border hover:bg-secondary"
                      }`}
                    >
                      <Icon className="w-4 h-4" />{label}
                      {contact.profile === key && <Check className="w-3.5 h-3.5 ml-auto" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Contact info */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Informações</p>
                  {canEdit && (
                    <button
                      onClick={() => setEditing(!editing)}
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Pencil className="w-3 h-3" />{editing ? "Cancelar" : "Editar"}
                    </button>
                  )}
                </div>
                {editing ? (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">WhatsApp / Contato</label>
                        <input value={editForm.contact} onChange={(e) => setEditForm({ ...editForm, contact: e.target.value })}
                          placeholder="(33) 99999-0000"
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Telefone</label>
                        <input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                          placeholder="(33) 3333-0000"
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">E-mail</label>
                      <input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                        placeholder="cliente@email.com"
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Setor de interesse</label>
                      <select value={editForm.sectorId} onChange={(e) => setEditForm({ ...editForm, sectorId: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                        <option value="">— Nenhum —</option>
                        {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Cliente novo?</label>
                      <select value={editForm.isNew ? "sim" : "nao"} onChange={(e) => setEditForm({ ...editForm, isNew: e.target.value === "sim" })}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                        <option value="sim">Sim — primeiro atendimento</option>
                        <option value="nao">Não — cliente recorrente</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Cidade</label>
                        <input value={editForm.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                          placeholder="Governador Valadares"
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Loja para atendimento</label>
                        <select value={editForm.serviceStore} onChange={(e) => setEditForm({ ...editForm, serviceStore: e.target.value })}
                          data-testid="select-contact-store"
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30">
                          <option value="">Sem loja</option>
                          {storesList.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                          {editForm.serviceStore && !storesList.some((s) => s.name === editForm.serviceStore) && (
                            <option value={editForm.serviceStore}>{editForm.serviceStore}</option>
                          )}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">De onde veio o atendimento</label>
                      <select value={editForm.attendanceSource} onChange={(e) => setEditForm({ ...editForm, attendanceSource: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                        <option value="">— Selecione —</option>
                        {ATTENDANCE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Tags (vírgula)</label>
                      <input value={editForm.tags} onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                        placeholder="iPhone, Urgente, Financiado"
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Observações gerais</label>
                      <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                        rows={3} className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    {customDefs.length > 0 && (
                      <div className="space-y-2.5 pt-2 border-t border-border">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Campos personalizados</p>
                        {customDefs.map((def) => {
                          const raw = customValues[String(def.id)];
                          const val = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
                          const set = (v: string) => setCustomValues((prev) => ({ ...prev, [String(def.id)]: v }));
                          const cls = "w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";
                          return (
                            <div key={def.id}>
                              <label className="text-xs text-muted-foreground mb-1 block">{def.name}</label>
                              {def.type === "textarea" ? (
                                <textarea value={val} onChange={(e) => set(e.target.value)} rows={2} className={`${cls} resize-none`} />
                              ) : def.type === "select" ? (
                                <select value={val} onChange={(e) => set(e.target.value)} className={cls}>
                                  <option value="">— Selecione —</option>
                                  {(def.options ?? "").split(",").map((o) => o.trim()).filter(Boolean).map((o) => (
                                    <option key={o} value={o}>{o}</option>
                                  ))}
                                </select>
                              ) : (
                                <input type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                                  value={val} onChange={(e) => set(e.target.value)} className={cls} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <button onClick={handleSaveEdit}
                      className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition flex items-center justify-center gap-2">
                      <Check className="w-4 h-4" /> Salvar alterações
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2 bg-secondary/50 rounded-xl p-4">
                    {contact.contact && (
                      <div className="flex items-center gap-2 text-sm">
                        <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span>{contact.contact}</span>
                      </div>
                    )}
                    {contact.email && (
                      <div className="flex items-center gap-2 text-sm">
                        <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span>{contact.email}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-sm">
                      <Sparkles className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span>{contact.isNew ? "Cliente novo" : "Cliente recorrente"}</span>
                    </div>
                    {contact.city && (
                      <div className="flex items-center gap-2 text-sm">
                        <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span>{contact.city}</span>
                      </div>
                    )}
                    {contact.serviceStore && (
                      <div className="flex items-center gap-2 text-sm">
                        <Store className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span>{contact.serviceStore}</span>
                      </div>
                    )}
                    {contact.attendanceSource && (
                      <div className="flex items-center gap-2 text-sm">
                        <Compass className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span>Veio de: {contact.attendanceSource}</span>
                      </div>
                    )}
                    {contact.tags && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {contact.tags.split(",").map((t) => t.trim()).filter(Boolean).map((tag) => (
                          <span key={tag} className="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">{tag}</span>
                        ))}
                      </div>
                    )}
                    {contact.notes && (
                      <p className="text-sm text-muted-foreground italic pt-1">{contact.notes}</p>
                    )}
                    {customDefs.filter((d) => cfValue(contact.customFields, d.id)).length > 0 && (
                      <div className="pt-2 mt-1 border-t border-border space-y-1.5">
                        {customDefs.map((d) => {
                          const v = cfValue(contact.customFields, d.id);
                          if (!v) return null;
                          return (
                            <div key={d.id} className="flex items-start gap-2 text-sm">
                              <span className="text-xs text-muted-foreground shrink-0 min-w-[90px]">{d.name}:</span>
                              <span className="font-medium break-words">{v}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {!contact.contact && !contact.email && !contact.tags && !contact.notes &&
                      customDefs.filter((d) => cfValue(contact.customFields, d.id)).length === 0 && (
                      <p className="text-sm text-muted-foreground">Nenhuma informação adicional</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── PURCHASES ── */}
          {tab === "purchases" && (
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Histórico de Compras</p>
                  <p className="text-xs text-muted-foreground">Total: {fmtCurrency(totalPurchasesNum)}</p>
                </div>
                {canEdit && (
                  <button onClick={() => setShowPurchaseForm(!showPurchaseForm)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
                    <Plus className="w-3.5 h-3.5" /> Registrar
                  </button>
                )}
              </div>

              {showPurchaseForm && (
                <form onSubmit={handleAddPurchase} className="bg-secondary/50 rounded-xl p-4 space-y-3 border border-border">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Nova Compra</p>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Descrição *</label>
                    <input required value={purchaseForm.description} onChange={(e) => setPurchaseForm({ ...purchaseForm, description: e.target.value })}
                      placeholder="Ex: iPhone 15 Pro Max 256GB"
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Valor (R$)</label>
                      <input type="number" step="0.01" min="0" value={purchaseForm.amount}
                        onChange={(e) => setPurchaseForm({ ...purchaseForm, amount: e.target.value })}
                        placeholder="0,00"
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Data</label>
                      <input type="date" value={purchaseForm.purchaseDate}
                        onChange={(e) => setPurchaseForm({ ...purchaseForm, purchaseDate: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Categoria</label>
                    <select value={purchaseForm.category} onChange={(e) => setPurchaseForm({ ...purchaseForm, category: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                      {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Observação</label>
                    <input value={purchaseForm.notes} onChange={(e) => setPurchaseForm({ ...purchaseForm, notes: e.target.value })}
                      placeholder="Ex: Parcelado em 12x"
                      className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setShowPurchaseForm(false)}
                      className="flex-1 py-2 rounded-xl border border-border text-xs text-muted-foreground hover:bg-secondary transition">
                      Cancelar
                    </button>
                    <button type="submit" disabled={purchaseLoading}
                      className="flex-1 py-2 rounded-xl bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition disabled:opacity-60">
                      {purchaseLoading ? "Salvando…" : "Salvar"}
                    </button>
                  </div>
                </form>
              )}

              {purchases.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground">
                  <Package className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Nenhuma compra registrada</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {purchases.map((p) => (
                    <div key={p.id} className="bg-white rounded-xl border border-border p-3 flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.description}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs font-bold text-primary">{fmtCurrency(p.amount)}</span>
                          {p.category && <span className="text-xs bg-secondary px-1.5 py-0.5 rounded-full">{p.category}</span>}
                          <span className="text-xs text-muted-foreground">{fmtDate(p.purchaseDate)}</span>
                        </div>
                        {p.notes && <p className="text-xs text-muted-foreground mt-1 italic">{p.notes}</p>}
                      </div>
                      {canEdit && (
                        <button onClick={() => handleDeletePurchase(p.id)}
                          className="p-1.5 rounded-lg text-destructive hover:bg-destructive/10 transition shrink-0">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── HISTORY ── */}
          {tab === "history" && (
            <div className="p-5 space-y-3">
              <p className="text-sm font-semibold">Histórico de Atendimentos</p>
              {history.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground">
                  <Clock className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Nenhum atendimento encontrado</p>
                  <p className="text-xs mt-1">O histórico é buscado pelo nome e número do cliente</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map((h) => (
                    <div key={h.id} className="bg-white rounded-xl border border-border p-3 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{h.sectorName}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          h.outcome === "completed" ? "bg-green-100 text-green-700" :
                          h.outcome === "transferred" ? "bg-blue-100 text-blue-700" :
                          "bg-gray-100 text-gray-600"
                        }`}>
                          {h.outcome === "completed" ? "Concluído" : h.outcome === "transferred" ? "Transferido" : h.outcome ?? "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        {h.attendantName && <span>Atendente: {h.attendantName}</span>}
                        {h.channel && <span>Canal: {h.channel}</span>}
                        {h.serviceTimeSeconds && <span>Duração: {Math.round(h.serviceTimeSeconds / 60)}min</span>}
                        <span>{fmtDateTime(h.createdAt)}</span>
                      </div>
                      {h.resolutionReason && <p className="text-xs text-foreground"><span className="font-medium">Motivo:</span> {h.resolutionReason}</p>}
                      {h.notes && <p className="text-xs text-muted-foreground italic">{h.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── NOTES ── */}
          {tab === "notes" && (
            <div className="p-5 space-y-4">
              <p className="text-sm font-semibold">Observações Internas</p>
              {canEdit && (
                <form onSubmit={handleAddNote} className="space-y-2">
                  <textarea
                    value={noteContent}
                    onChange={(e) => setNoteContent(e.target.value)}
                    placeholder="Adicionar observação interna (visível apenas para atendentes)…"
                    rows={3}
                    className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button type="submit" disabled={noteLoading || !noteContent.trim()}
                    className="px-4 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition disabled:opacity-50 flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5" />{noteLoading ? "Salvando…" : "Adicionar nota"}
                  </button>
                </form>
              )}

              {notes.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <StickyNote className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Nenhuma observação registrada</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {notes.map((n) => (
                    <div key={n.id} className="bg-amber-50 border border-amber-200 rounded-xl p-3 relative">
                      <p className="text-sm text-foreground whitespace-pre-wrap">{n.content}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-xs text-muted-foreground">
                          {n.authorName ?? "Sistema"} · {fmtDateTime(n.createdAt)}
                        </span>
                        {canEdit && (
                          <button onClick={() => handleDeleteNote(n.id)}
                            className="p-1 rounded-lg text-destructive hover:bg-destructive/10 transition">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
