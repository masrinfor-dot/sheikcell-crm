import { useState, useEffect } from "react";
import { api, type DocumentItem } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { FolderArchive, Plus, X, Search, FileText, Image, Download, Trash2, Eye } from "lucide-react";

const CATEGORIES: { value: string; label: string; badge: string }[] = [
  { value: "ata", label: "Ata de Reunião", badge: "bg-violet-100 text-violet-700" },
  { value: "documento", label: "Documento", badge: "bg-blue-100 text-blue-700" },
  { value: "comunicado", label: "Comunicado", badge: "bg-amber-100 text-amber-700" },
  { value: "contrato", label: "Contrato", badge: "bg-emerald-100 text-emerald-700" },
];
const catInfo = (v: string) => CATEGORIES.find((c) => c.value === v) ?? CATEGORIES[1];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Documentos() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  // Formulário de envio
  const [fTitle, setFTitle] = useState("");
  const [fCat, setFCat] = useState("ata");
  const [fDesc, setFDesc] = useState("");
  const [fFile, setFFile] = useState<File | null>(null);

  const canManage = user?.role === "admin" || user?.role === "supervisor";

  useEffect(() => {
    api.documents.list().then(setDocs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const openAdd = () => {
    setFTitle(""); setFCat("ata"); setFDesc(""); setFFile(null);
    setShowAdd(true);
  };

  const handleUpload = async () => {
    if (saving) return;
    const title = fTitle.trim();
    if (!title) { toast({ title: "Dê um título ao documento", variant: "destructive" }); return; }
    if (!fFile) { toast({ title: "Escolha um arquivo", variant: "destructive" }); return; }
    if (fFile.size > 15 * 1024 * 1024) { toast({ title: "Arquivo muito grande (máximo 15MB)", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
        reader.readAsDataURL(fFile);
      });
      const doc = await api.documents.create({
        title, category: fCat, description: fDesc.trim() || undefined,
        fileName: fFile.name, mimeType: fFile.type || "application/octet-stream", data: base64,
      });
      setDocs((prev) => [{ ...doc, uploaderName: user?.name ?? null }, ...prev]);
      setShowAdd(false);
      toast({ title: "Documento arquivado! 📁" });
    } catch (err) {
      toast({ title: "Erro ao enviar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (d: DocumentItem) => {
    if (!confirm(`Excluir "${d.title}"? O arquivo será apagado.`)) return;
    try {
      await api.documents.remove(d.id);
      setDocs((prev) => prev.filter((x) => x.id !== d.id));
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const filtered = docs.filter((d) =>
    (!filterCat || d.category === filterCat) &&
    (!search || d.title.toLowerCase().includes(search.toLowerCase()) || (d.description ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FolderArchive className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold">Documentos</h1>
          <span className="text-xs text-muted-foreground">atas de reunião, comunicados e arquivos da loja</span>
        </div>
        {canManage && (
          <button onClick={openAdd} data-testid="button-add-document"
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
            <Plus className="w-3.5 h-3.5" /> Arquivar documento
          </button>
        )}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por título ou descrição..."
            data-testid="input-doc-search"
            className="w-full pl-9 pr-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
        </div>
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setFilterCat("")}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${!filterCat ? "bg-primary text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/70"}`}>
            Todos
          </button>
          {CATEGORIES.map((c) => (
            <button key={c.value} onClick={() => setFilterCat(filterCat === c.value ? "" : c.value)}
              data-testid={`filter-cat-${c.value}`}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${filterCat === c.value ? "bg-primary text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/70"}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="h-24 rounded-xl bg-secondary animate-pulse" />
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <FolderArchive className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{docs.length === 0 ? "Nenhum documento arquivado ainda." : "Nada encontrado com esse filtro."}</p>
          {canManage && docs.length === 0 && (
            <button onClick={openAdd} className="mt-2 text-primary font-semibold underline underline-offset-2 text-sm">Arquivar o primeiro</button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((d) => {
            const cat = catInfo(d.category);
            const isImage = d.mimeType.startsWith("image/");
            return (
              <div key={d.id} data-testid={`doc-card-${d.id}`} className="bg-white rounded-xl border border-border p-4 flex gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  {isImage ? <Image className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-sm truncate">{d.title}</p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${cat.badge}`}>{cat.label}</span>
                  </div>
                  {d.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{d.description}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {d.fileName} · {formatSize(d.sizeBytes)} · {new Date(d.createdAt).toLocaleDateString("pt-BR")}
                    {d.uploaderName ? ` · por ${d.uploaderName}` : ""}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <a href={api.documents.fileUrl(d.id)} target="_blank" rel="noreferrer" data-testid={`button-view-doc-${d.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:bg-primary/10 rounded-lg px-2 py-1 transition">
                      <Eye className="w-3.5 h-3.5" /> Abrir
                    </a>
                    <a href={api.documents.fileUrl(d.id)} download={d.fileName} data-testid={`button-download-doc-${d.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:bg-secondary rounded-lg px-2 py-1 transition">
                      <Download className="w-3.5 h-3.5" /> Baixar
                    </a>
                    {canManage && (
                      <button onClick={() => handleDelete(d)} data-testid={`button-delete-doc-${d.id}`}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg px-2 py-1 transition ml-auto">
                        <Trash2 className="w-3.5 h-3.5" /> Excluir
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de envio */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3" onClick={() => setShowAdd(false)}>
          <div className="bg-card rounded-xl w-full max-w-md shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><FolderArchive className="w-4 h-4 text-primary" /> Arquivar documento</span>
              <button onClick={() => setShowAdd(false)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Título</label>
                <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} data-testid="input-doc-title"
                  placeholder="Ex.: Ata da reunião de julho"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Categoria</label>
                <select value={fCat} onChange={(e) => setFCat(e.target.value)} data-testid="select-doc-category"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Descrição (opcional)</label>
                <textarea value={fDesc} onChange={(e) => setFDesc(e.target.value)} rows={2} data-testid="input-doc-desc"
                  placeholder="Resumo do que trata o documento"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Arquivo (PDF, Word, Excel, PowerPoint, texto ou imagem — até 15MB)</label>
                <input type="file" data-testid="input-doc-file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png,.webp"
                  onChange={(e) => setFFile(e.target.files?.[0] ?? null)}
                  className="mt-1 w-full text-xs file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-primary/10 file:text-primary file:text-xs file:font-semibold hover:file:bg-primary/20" />
                {fFile && <p className="text-[11px] text-muted-foreground mt-1">{fFile.name} · {formatSize(fFile.size)}</p>}
              </div>
              <button onClick={handleUpload} disabled={saving} data-testid="button-save-document"
                className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {saving ? "Enviando..." : "Arquivar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
