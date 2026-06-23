import { useState, useEffect, useCallback } from "react";
import { api, type CrmContact, type Sector } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  Plus, X, Pencil, User, Phone, Tag, StickyNote,
  RefreshCw, Archive, ChevronRight, ChevronLeft
} from "lucide-react";

const COLUMNS = [
  { key: "potential" as const, label: "Potenciais", color: "bg-purple-500", light: "bg-purple-50", border: "border-purple-200", text: "text-purple-700" },
  { key: "pending"  as const, label: "Pendentes",  color: "bg-amber-500",  light: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-700"  },
  { key: "active"   as const, label: "Ativos",     color: "bg-green-500",  light: "bg-green-50",  border: "border-green-200",  text: "text-green-700"  },
] as const;

type Status = typeof COLUMNS[number]["key"];

type ContactFormData = {
  name: string; contact: string; sectorId: string;
  notes: string; tags: string; status: Status;
};

const emptyForm: ContactFormData = {
  name: "", contact: "", sectorId: "", notes: "", tags: "", status: "potential"
};

function ContactCard({
  contact,
  onMove,
  onEdit,
  onArchive,
  colIdx,
}: {
  contact: CrmContact;
  onMove: (id: number, status: Status) => void;
  onEdit: (c: CrmContact) => void;
  onArchive: (id: number) => void;
  colIdx: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const prev = COLUMNS[colIdx - 1];
  const next = COLUMNS[colIdx + 1];

  return (
    <div
      className="bg-white rounded-2xl border border-border shadow-sm p-4 space-y-2 hover:shadow-md transition"
      data-testid={`crm-card-${contact.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground truncate">{contact.name}</p>
          {contact.contact && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Phone className="w-3 h-3" />{contact.contact}
            </p>
          )}
        </div>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 rounded-lg text-muted-foreground hover:bg-secondary transition"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-20 bg-white border border-border rounded-xl shadow-lg p-1 min-w-[140px]">
              <button onClick={() => { onEdit(contact); setMenuOpen(false); }} className="w-full text-left flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-secondary transition">
                <Pencil className="w-3 h-3" /> Editar
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
            </div>
          )}
        </div>
      </div>

      {contact.sector && (
        <div className="flex items-center gap-1">
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium text-white"
            style={{ backgroundColor: contact.sector.color }}
          >
            {contact.sector.name}
          </span>
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
          <User className="w-3 h-3" />
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
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<CrmContact | null>(null);
  const [form, setForm] = useState<ContactFormData>(emptyForm);

  const fetchContacts = useCallback(async () => {
    try {
      const data = await api.crm.list();
      setContacts(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContacts();
    api.sectors.list().then(setSectors).catch(() => {});
  }, [fetchContacts]);

  const openAdd = () => {
    setEditTarget(null);
    setForm({
      ...emptyForm,
      sectorId: user?.sectorId ? String(user.sectorId) : "",
    });
    setShowForm(true);
  };

  const openEdit = (c: CrmContact) => {
    setEditTarget(c);
    setForm({
      name: c.name,
      contact: c.contact ?? "",
      sectorId: c.sectorId ? String(c.sectorId) : "",
      notes: c.notes ?? "",
      tags: c.tags ?? "",
      status: c.status as Status,
    });
    setShowForm(true);
  };

  const handleMove = async (id: number, status: Status) => {
    try {
      await api.crm.update(id, { status });
      setContacts((prev) => prev.map((c) => c.id === id ? { ...c, status } : c));
    } catch {
      toast({ title: "Erro ao mover contato", variant: "destructive" });
    }
  };

  const handleArchive = async (id: number) => {
    try {
      await api.crm.remove(id);
      setContacts((prev) => prev.filter((c) => c.id !== id));
      toast({ title: "Contato arquivado" });
    } catch {
      toast({ title: "Erro ao arquivar", variant: "destructive" });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: form.name,
      contact: form.contact || undefined,
      sectorId: form.sectorId ? Number(form.sectorId) : undefined,
      notes: form.notes || undefined,
      tags: form.tags || undefined,
      status: form.status,
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
      fetchContacts(); // refresh with enriched data
    } catch (err: unknown) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const byStatus = (status: Status) => contacts.filter((c) => c.status === status);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-foreground">CRM — Pipeline de Clientes</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Gerencie contatos por etapa do relacionamento</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchContacts} className="p-2 text-muted-foreground hover:text-foreground rounded-xl hover:bg-secondary transition">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={openAdd}
            data-testid="button-crm-add"
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            Novo Contato
          </button>
        </div>
      </div>

      {/* Kanban board */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-start">
        {COLUMNS.map((col, colIdx) => {
          const cards = byStatus(col.key);
          return (
            <div key={col.key} className={`rounded-2xl ${col.light} border ${col.border} p-4`} data-testid={`crm-col-${col.key}`}>
              {/* Column header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${col.color}`} />
                  <span className={`text-sm font-bold ${col.text}`}>{col.label}</span>
                </div>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${col.light} ${col.text} border ${col.border}`}>
                  {loading ? "…" : cards.length}
                </span>
              </div>

              {/* Cards */}
              <div className="space-y-3">
                {loading ? (
                  <div className="h-20 rounded-xl bg-white/60 animate-pulse" />
                ) : cards.length === 0 ? (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    <p>Nenhum contato aqui</p>
                    <button onClick={openAdd} className={`mt-2 ${col.text} font-semibold underline underline-offset-2`}>
                      Adicionar
                    </button>
                  </div>
                ) : (
                  cards.map((c) => (
                    <ContactCard
                      key={c.id}
                      contact={c}
                      onMove={handleMove}
                      onEdit={openEdit}
                      onArchive={handleArchive}
                      colIdx={colIdx}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Form modal */}
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
              <div>
                <label className="text-xs font-medium mb-1 block">Etapa</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm">
                  {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
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
    </div>
  );
}
