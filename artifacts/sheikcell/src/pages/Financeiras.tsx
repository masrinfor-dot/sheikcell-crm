import { useState, useEffect } from "react";
import { api, type PartnerLink } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Landmark, Plus, X, Trash2, Pencil, RefreshCw, ExternalLink, Globe,
} from "lucide-react";

// Aba "Financeiras": links das financeiras parceiras abertos dentro do
// sistema, como um navegador. Alguns sites bloqueiam ser exibidos dentro de
// outros sistemas — nesses casos oferecemos abrir em nova aba.
export default function Financeiras() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = user?.role === "admin" || user?.role === "supervisor";

  const [links, setLinks] = useState<PartnerLink[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PartnerLink | null>(null);
  const [form, setForm] = useState({ name: "", url: "" });
  const [saving, setSaving] = useState(false);

  const fetchLinks = () => {
    api.partnerLinks.list().then((rows) => {
      setLinks(rows);
      setActiveId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)));
    }).catch(() => {});
  };

  useEffect(() => { fetchLinks(); }, []);

  const active = links.find((l) => l.id === activeId) ?? null;

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
        if (activeId === upd.id) setIframeKey((k) => k + 1);
      } else {
        const created = await api.partnerLinks.create(form);
        setLinks((prev) => [...prev, created]);
        setActiveId(created.id);
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
      if (activeId === l.id) setActiveId(null);
      toast({ title: "Financeira removida" });
    } catch {
      toast({ title: "Erro ao remover", variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)] md:h-[calc(100vh-6rem)]">
      {/* Barra de financeiras */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border border-border rounded-t-2xl overflow-x-auto">
        <Landmark className="w-4 h-4 text-primary shrink-0" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
          {links.length === 0 && (
            <span className="text-xs text-muted-foreground">Nenhuma financeira cadastrada ainda.</span>
          )}
          {links.map((l) => (
            <div key={l.id} className="group/link relative shrink-0">
              <button
                onClick={() => { setActiveId(l.id); setIframeKey((k) => k + 1); }}
                data-testid={`partner-link-${l.id}`}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition whitespace-nowrap ${
                  activeId === l.id
                    ? "bg-primary text-white border-primary"
                    : "bg-white text-muted-foreground border-border hover:bg-secondary"
                } ${canManage ? "pr-9" : ""}`}
              >
                {l.name}
              </button>
              {canManage && (
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden group-hover/link:flex items-center gap-0.5">
                  <button onClick={() => openForm(l)} title="Editar">
                    <Pencil className={`w-3 h-3 ${activeId === l.id ? "text-white/80" : "text-muted-foreground"}`} />
                  </button>
                  <button onClick={() => handleDelete(l)} title="Remover">
                    <Trash2 className={`w-3 h-3 ${activeId === l.id ? "text-white/80" : "text-red-400"}`} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
        {active && (
          <>
            <button onClick={() => setIframeKey((k) => k + 1)} title="Recarregar página"
              className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition shrink-0">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <a href={active.url} target="_blank" rel="noopener noreferrer" title="Abrir em nova aba"
              className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition shrink-0">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </>
        )}
        {canManage && (
          <button onClick={() => openForm()} data-testid="button-add-partner-link"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-primary text-white text-xs font-semibold shrink-0">
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        )}
      </div>

      {/* Navegador embutido */}
      <div className="flex-1 bg-white border border-t-0 border-border rounded-b-2xl overflow-hidden relative">
        {!active ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
            <Globe className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm font-semibold">Nenhuma financeira selecionada</p>
            <p className="text-xs mt-1 max-w-sm">
              {canManage
                ? 'Clique em "Adicionar" para cadastrar o link de uma financeira parceira. Ela abre aqui dentro, como um navegador.'
                : "Peça ao administrador para cadastrar os links das financeiras parceiras."}
            </p>
          </div>
        ) : (
          <>
            <iframe
              key={`${active.id}-${iframeKey}`}
              src={active.url}
              title={active.name}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              referrerPolicy="no-referrer-when-downgrade"
            />
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 text-white text-[10px] px-3 py-1 rounded-full pointer-events-auto">
              Página em branco? Este site bloqueia abrir dentro de sistemas —{" "}
              <a href={active.url} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                abrir em nova aba
              </a>
            </div>
          </>
        )}
      </div>

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
