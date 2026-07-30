import { useState, useEffect } from "react";
import { api, type FilmCompat } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Shield, Plus, X, Trash2, Pencil, Search } from "lucide-react";

// Normaliza para busca sem acento e sem caixa.
function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Aba "Películas": tabela de compatibilidade para consulta rápida.
// Toda a equipe consulta; só o admin edita.
export default function Peliculas() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [rows, setRows] = useState<FilmCompat[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<FilmCompat | null>(null);
  const [form, setForm] = useState({ film: "", models: "", notes: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.filmCompat.list().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const q = norm(search.trim());
  const visible = q
    ? rows.filter((r) => norm(r.film).includes(q) || norm(r.models).includes(q) || norm(r.notes ?? "").includes(q))
    : rows;

  const openForm = (r?: FilmCompat) => {
    setEditing(r ?? null);
    setForm(r ? { film: r.film, models: r.models, notes: r.notes ?? "" } : { film: "", models: "", notes: "" });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.film.trim() || !form.models.trim() || saving) return;
    setSaving(true);
    try {
      if (editing) {
        const upd = await api.filmCompat.update(editing.id, form);
        setRows((prev) => prev.map((r) => (r.id === upd.id ? upd : r)));
      } else {
        const created = await api.filmCompat.create(form);
        setRows((prev) => [...prev, created].sort((a, b) => a.film.localeCompare(b.film)));
      }
      setShowForm(false);
      toast({ title: editing ? "Compatibilidade atualizada" : "Compatibilidade adicionada" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (r: FilmCompat) => {
    if (!window.confirm(`Excluir "${r.film}" da tabela?`)) return;
    try {
      await api.filmCompat.remove(r.id);
      setRows((prev) => prev.filter((x) => x.id !== r.id));
      toast({ title: "Registro excluído" });
    } catch {
      toast({ title: "Erro ao excluir", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" /> Compatibilidade de Películas
        </h2>
        {isAdmin && (
          <button onClick={() => openForm()} data-testid="button-add-film-compat"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-semibold">
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        )}
      </div>

      {/* Busca */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por aparelho ou película (ex.: A54, iPhone 13...)"
          data-testid="input-film-search"
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border text-sm bg-white" />
      </div>

      {/* Lista */}
      {loading ? (
        <div className="h-24 rounded-xl bg-secondary/40 animate-pulse" />
      ) : visible.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <Shield className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">{q ? "Nada encontrado para essa busca" : "Nenhuma compatibilidade cadastrada"}</p>
          {!q && isAdmin && <p className="text-xs mt-1">Clique em "Adicionar" para montar a tabela de consulta.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((r) => (
            <div key={r.id} className="shk-card p-4 flex items-start gap-3" data-testid={`film-compat-${r.id}`}>
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Shield className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm break-words">{r.film}</p>
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {r.models.split(",").map((m) => m.trim()).filter(Boolean).map((m, i) => (
                    <span key={i} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-full font-medium">
                      {m}
                    </span>
                  ))}
                </div>
                {r.notes && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1 mt-2 inline-block">⚠ {r.notes}</p>}
              </div>
              {isAdmin && (
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => openForm(r)} title="Editar"
                    className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(r)} title="Excluir"
                    className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal adicionar/editar */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editing ? "Editar compatibilidade" : "Nova compatibilidade"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Película</label>
                <input value={form.film} onChange={(e) => setForm((f) => ({ ...f, film: e.target.value }))}
                  placeholder="Ex.: Película 3D Samsung A54" data-testid="input-film-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Aparelhos compatíveis (separados por vírgula)</label>
                <textarea value={form.models} onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
                  placeholder="Ex.: Samsung A54, A54 5G, M54" rows={3} data-testid="input-film-models"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Observações (opcional)</label>
                <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Ex.: não serve com capinha grossa" data-testid="input-film-notes"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button onClick={handleSave} disabled={!form.film.trim() || !form.models.trim() || saving}
                data-testid="button-save-film-compat"
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
