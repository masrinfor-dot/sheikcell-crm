import { useState, useEffect } from "react";
import { api, canEditModule, type PartnerLink } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Landmark, Plus, X, Trash2, Pencil, ExternalLink, Globe,
} from "lucide-react";

// Aba "Financeiras": atalhos das financeiras parceiras. Os sites de bancos e
// financeiras BLOQUEIAM ser exibidos dentro de outros sistemas
// (X-Frame-Options) — por isso a antiga tela embutida ficava em branco.
// Agora cada card abre o site direto em uma NOVA ABA do navegador.
export default function Financeiras() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = (user?.role === "admin" || user?.role === "supervisor") && canEditModule(user, "financeiras");

  const [links, setLinks] = useState<PartnerLink[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PartnerLink | null>(null);
  const [form, setForm] = useState({ name: "", url: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.partnerLinks.list().then(setLinks).catch(() => {});
  }, []);

  const openForm = (l?: PartnerLink) => {
    setEditing(l ?? null);
    setForm(l ? { name: l.name, url: l.url } : { name: "", url: "" });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.url.trim() || saving) return;
    setSaving(true);
    try {
      if (editing) {
        const upd = await api.partnerLinks.update(editing.id, form);
        setLinks((prev) => prev.map((l) => (l.id === upd.id ? upd : l)));
      } else {
        const created = await api.partnerLinks.create(form);
        setLinks((prev) => [...prev, created]);
      }
      setShowForm(false);
      toast({ title: editing ? "Financeira atualizada" : "Financeira adicionada" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (l: PartnerLink) => {
    if (!window.confirm(`Remover "${l.name}" da lista de financeiras?`)) return;
    try {
      await api.partnerLinks.remove(l.id);
      setLinks((prev) => prev.filter((x) => x.id !== l.id));
      toast({ title: "Financeira removida" });
    } catch {
      toast({ title: "Erro ao remover", variant: "destructive" });
    }
  };

  const hostOf = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Landmark className="w-5 h-5 text-primary" />
          <h2 className="font-bold text-lg">Financeiras parceiras</h2>
        </div>
        {canManage && (
          <button onClick={() => openForm()} data-testid="button-add-partner-link"
            className="flex items-center gap-1 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        💡 Os sites das financeiras não permitem abrir dentro de outros sistemas — por isso cada
        card abre o site em uma <strong>nova aba</strong> do navegador, já pronto para usar.
      </p>

      {links.length === 0 ? (
        <div className="shk-card p-10 flex flex-col items-center justify-center text-muted-foreground text-center">
          <Globe className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-semibold">Nenhuma financeira cadastrada ainda</p>
          <p className="text-xs mt-1 max-w-sm">
            {canManage
              ? 'Clique em "Adicionar" para cadastrar o link de uma financeira parceira.'
              : "Peça ao administrador para cadastrar os links das financeiras parceiras."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {links.map((l) => (
            <div key={l.id} className="shk-card p-4 flex flex-col gap-3 group/link" data-testid={`partner-link-${l.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-sm truncate">{l.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{hostOf(l.url)}</p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openForm(l)} title="Editar" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(l)} title="Remover" className="p-1.5 rounded-lg hover:bg-red-50 text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <a href={l.url} target="_blank" rel="noopener noreferrer"
                data-testid={`button-open-partner-${l.id}`}
                className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl bg-primary text-white text-xs font-semibold hover:opacity-90 transition">
                <ExternalLink className="w-3.5 h-3.5" /> Abrir em nova aba
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Modal adicionar/editar */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editing ? "Editar financeira" : "Nova financeira"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ex.: Losango, Crefisa..." data-testid="input-partner-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Link (site da financeira)</label>
                <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://www.financeira.com.br" data-testid="input-partner-url"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button onClick={handleSave} disabled={!form.name.trim() || !form.url.trim() || saving}
                data-testid="button-save-partner-link"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
