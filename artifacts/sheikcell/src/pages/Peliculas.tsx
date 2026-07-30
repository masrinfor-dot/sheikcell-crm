import { useState, useEffect } from "react";
import { api, type FilmCompat } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Shield, Plus, X, Trash2, Pencil, Search, Upload, FileSpreadsheet } from "lucide-react";

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
  const [showImport, setShowImport] = useState(false);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    api.filmCompat.list().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleImport = async () => {
    if (!importFile || importing) return;
    if (importMode === "replace" && !window.confirm("Substituir TODA a tabela atual pelos dados da planilha?")) return;
    setImporting(true);
    try {
      const buf = new Uint8Array(await importFile.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      const r = await api.filmCompat.import(btoa(bin), importMode);
      const fresh = await api.filmCompat.list();
      setRows(fresh);
      setShowImport(false);
      setImportFile(null);
      toast({
        title: `${r.imported} linha${r.imported === 1 ? "" : "s"} importada${r.imported === 1 ? "" : "s"}!`,
        description: r.skipped ? `${r.skipped} linha(s) ignorada(s): ${r.errors.join("; ")}` : undefined,
      });
    } catch (err) {
      toast({ title: "Erro na importação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

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
          <button onClick={() => { setImportFile(null); setImportMode("append"); setShowImport(true); }} data-testid="button-import-film-compat"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
            <Upload className="w-3.5 h-3.5" /> Importar planilha
          </button>
        )}
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

      {/* Modal importar planilha */}
      {showImport && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">Importar planilha</h3>
              <button onClick={() => setShowImport(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3">
              <div className="bg-secondary/40 rounded-xl p-3 text-[11px] text-muted-foreground">
                <p className="font-bold text-foreground mb-1">Como montar a planilha (Excel ou CSV):</p>
                <p>• Coluna <b>A</b>: nome da película</p>
                <p>• Coluna <b>B</b>: aparelhos compatíveis</p>
                <p>• Coluna <b>C</b>: observações (opcional)</p>
              </div>
              <label className="flex items-center gap-2 px-3 py-3 rounded-xl border border-dashed border-border text-xs font-semibold text-muted-foreground cursor-pointer hover:bg-secondary transition">
                <FileSpreadsheet className="w-4 h-4 text-primary shrink-0" />
                <span className="truncate">{importFile ? importFile.name : "Escolher arquivo (.xlsx, .xls ou .csv)"}</span>
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" data-testid="input-import-file"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
              </label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="radio" checked={importMode === "append"} onChange={() => setImportMode("append")} />
                  Adicionar à tabela atual
                </label>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="radio" checked={importMode === "replace"} onChange={() => setImportMode("replace")} />
                  Substituir a tabela inteira
                </label>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowImport(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">Cancelar</button>
              <button onClick={handleImport} disabled={!importFile || importing} data-testid="button-do-import"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {importing ? "Importando..." : "Importar"}
              </button>
            </div>
          </div>
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
