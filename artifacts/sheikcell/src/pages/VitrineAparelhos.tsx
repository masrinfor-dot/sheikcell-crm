import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  api, canEditModule, CATALOG_CONDITIONS,
  type CatalogProduct, type CatalogPricingSettings, type CatalogImportItem, type CatalogCondition,
} from "@/lib/api";
import {
  Smartphone, Plus, X, Search, Trash2, Pencil, Sparkles, Settings2, Link2,
  Copy, ImagePlus, Check, AlertTriangle, Loader2, MessageCircle,
} from "lucide-react";

function formatBRL(v: string | number | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const INSTALLMENT_OPTIONS = [1, 2, 3, 4, 6, 10, 12, 18];

const emptyForm = {
  model: "", storage: "", condition: "seminovo" as CatalogCondition, colors: "",
  description: "", costPrice: "", costIncludesInvoice: false, marginPercentOverride: "",
  salePrice: "", stockQty: "1", status: "active" as CatalogProduct["status"],
};

export default function VitrineAparelhos() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = canEditModule(user, "vitrine");

  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [settings, setSettings] = useState<CatalogPricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"active" | "all">("active");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CatalogProduct | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importItems, setImportItems] = useState<CatalogImportItem[] | null>(null);
  const [importTab, setImportTab] = useState<"approved" | "pending">("approved");
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<CatalogPricingSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [slug, setSlug] = useState<string | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [savingSlug, setSavingSlug] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([api.catalog.list(), api.catalog.getSlug()])
      .then(([l, s]) => { setProducts(l.products); setSettings(l.settings); setSlug(s.slug); setSlugInput(s.slug ?? ""); })
      .catch(() => toast({ title: "Erro ao carregar a vitrine", variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = products.filter((p) =>
    (filterStatus === "all" || p.status === "active") &&
    (!search || p.model.toLowerCase().includes(search.toLowerCase()) || (p.storage ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  // ─── Formulário de produto ─────────────────────────────────────────────
  const openCreate = () => { setEditing(null); setForm(emptyForm); setShowForm(true); };
  const openEdit = (p: CatalogProduct) => {
    setEditing(p);
    setForm({
      model: p.model, storage: p.storage ?? "", condition: p.condition, colors: p.colors.join(", "),
      description: p.description ?? "", costPrice: p.costPrice ?? "", costIncludesInvoice: p.costIncludesInvoice,
      marginPercentOverride: p.marginPercentOverride ?? "", salePrice: p.salePrice ?? "",
      stockQty: String(p.stockQty), status: p.status,
    });
    setShowForm(true);
  };

  // Recalcula o preço sugerido ao vivo quando custo/margem mudam, sem
  // sobrescrever se o lojista já digitou um preço manualmente nesta sessão.
  const [salePriceTouched, setSalePriceTouched] = useState(false);
  useEffect(() => {
    if (!showForm || salePriceTouched) return;
    const custo = Number(form.costPrice);
    if (!Number.isFinite(custo) || custo <= 0) return;
    const t = setTimeout(() => {
      api.catalog.simulatePrice({
        costPrice: custo,
        costIncludesInvoice: form.costIncludesInvoice,
        marginPercentOverride: form.marginPercentOverride ? Number(form.marginPercentOverride) : null,
      }).then((r) => { if (r.salePrice != null) setForm((f) => ({ ...f, salePrice: String(r.salePrice) })); }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.costPrice, form.costIncludesInvoice, form.marginPercentOverride, showForm, salePriceTouched]);

  const closeForm = () => { setShowForm(false); setEditing(null); setSalePriceTouched(false); };

  const handleSave = async () => {
    if (saving) return;
    const model = form.model.trim();
    if (!model) { toast({ title: "Informe o modelo do aparelho", variant: "destructive" }); return; }
    setSaving(true);
    const payload: Record<string, unknown> = {
      model,
      storage: form.storage.trim() || null,
      condition: form.condition,
      colors: form.colors.split(",").map((c) => c.trim()).filter(Boolean),
      description: form.description.trim() || null,
      costPrice: form.costPrice ? Number(form.costPrice) : null,
      costIncludesInvoice: form.costIncludesInvoice,
      marginPercentOverride: form.marginPercentOverride ? Number(form.marginPercentOverride) : null,
      stockQty: Number(form.stockQty) || 0,
      status: form.status,
    };
    if (salePriceTouched || editing) payload.salePrice = form.salePrice ? Number(form.salePrice) : null;
    try {
      if (editing) {
        const updated = await api.catalog.update(editing.id, payload);
        setProducts((prev) => prev.map((p) => (p.id === updated.id ? { ...updated, photos: p.photos } : p)));
        setEditing(updated);
        toast({ title: "Aparelho atualizado" });
      } else {
        const created = await api.catalog.create(payload);
        setProducts((prev) => [created, ...prev]);
        setEditing(created); // mantém o modal aberto pra permitir enviar fotos
        toast({ title: "Aparelho cadastrado! Agora adicione fotos." });
      }
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: CatalogProduct) => {
    if (!confirm(`Excluir "${p.model}"? As fotos também serão apagadas.`)) return;
    try {
      await api.catalog.remove(p.id);
      setProducts((prev) => prev.filter((x) => x.id !== p.id));
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const handlePhotoUpload = async (files: FileList | null) => {
    if (!editing || !files || files.length === 0) return;
    setUploadingPhoto(true);
    try {
      for (const file of Array.from(files).slice(0, 8)) {
        if (file.size > 8 * 1024 * 1024) { toast({ title: `${file.name} é maior que 8MB`, variant: "destructive" }); continue; }
        const photo = await api.catalog.addPhoto(editing.id, file);
        setEditing((prev) => prev && { ...prev, photos: [...prev.photos, photo] });
        setProducts((prev) => prev.map((p) => (p.id === editing.id ? { ...p, photos: [...p.photos, photo] } : p)));
      }
    } catch (err) {
      toast({ title: "Erro ao enviar foto", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handlePhotoRemove = async (photoId: number) => {
    if (!editing) return;
    try {
      await api.catalog.removePhoto(editing.id, photoId);
      setEditing((prev) => prev && { ...prev, photos: prev.photos.filter((ph) => ph.id !== photoId) });
      setProducts((prev) => prev.map((p) => (p.id === editing.id ? { ...p, photos: p.photos.filter((ph) => ph.id !== photoId) } : p)));
    } catch { toast({ title: "Erro ao remover foto", variant: "destructive" }); }
  };

  // ─── Copiar mensagem formatada pro WhatsApp ────────────────────────────
  const productMessage = (p: CatalogProduct) => [
    `📱 ${p.model}${p.storage ? ` – ${p.storage}` : ""}`,
    p.colors.length ? `🎨 Cores: ${p.colors.join(", ")}` : null,
    `💰 ${formatBRL(p.salePrice)}`,
  ].filter(Boolean).join("\n");

  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Mensagem copiada! Cole no WhatsApp." });
    } catch { toast({ title: "Não foi possível copiar", variant: "destructive" }); }
  };

  const copyFullCatalog = () => {
    const active = products.filter((p) => p.status === "active");
    if (active.length === 0) { toast({ title: "Nenhum aparelho ativo pra copiar", variant: "destructive" }); return; }
    copyMessage(active.map(productMessage).join("\n\n"));
  };

  // ─── Importação por IA ──────────────────────────────────────────────────
  const openImport = () => { setImportText(""); setImportItems(null); setImportTab("approved"); setShowImport(true); };

  const handleParse = async () => {
    if (parsing || !importText.trim()) return;
    setParsing(true);
    try {
      const r = await api.catalog.importParse(importText);
      setImportItems(r.items);
      setImportTab(r.items.some((i) => i.status === "approved") ? "approved" : "pending");
    } catch (err) {
      toast({ title: "Erro ao analisar a lista", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setParsing(false);
    }
  };

  const updateImportItem = (idx: number, patch: Partial<CatalogImportItem>) => {
    setImportItems((prev) => prev && prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const handleConfirmImport = async () => {
    if (!importItems || confirming) return;
    const toImport = importItems.filter((i) => i.model && i.model !== "(modelo não identificado)" && i.model !== "(sem modelo)");
    if (toImport.length === 0) { toast({ title: "Nenhum item pronto para importar", variant: "destructive" }); return; }
    setConfirming(true);
    try {
      const r = await api.catalog.importConfirm(toImport);
      setProducts((prev) => [...r.products, ...prev]);
      toast({ title: `${r.imported} aparelho(s) importado(s)!` });
      setShowImport(false);
    } catch (err) {
      toast({ title: "Erro ao importar", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setConfirming(false);
    }
  };

  const approvedCount = importItems?.filter((i) => i.status === "approved").length ?? 0;
  const pendingCount = importItems?.filter((i) => i.status === "pending").length ?? 0;
  const visibleImportItems = useMemo(
    () => (importItems ?? []).map((it, idx) => ({ it, idx })).filter(({ it }) => it.status === importTab || (importTab === "approved" && it.status !== "pending")),
    [importItems, importTab],
  );

  // ─── Configurações de precificação ──────────────────────────────────────
  const openSettings = () => { setSettingsForm(settings); setShowSettings(true); };
  const handleSaveSettings = async () => {
    if (!settingsForm || savingSettings) return;
    setSavingSettings(true);
    try {
      const saved = await api.catalog.savePricingSettings(settingsForm);
      setSettings(saved);
      toast({ title: "Configurações de preço salvas" });
      setShowSettings(false);
    } catch { toast({ title: "Erro ao salvar configurações", variant: "destructive" }); } finally { setSavingSettings(false); }
  };

  const handleSaveSlug = async () => {
    if (savingSlug) return;
    const value = slugInput.trim().toLowerCase();
    setSavingSlug(true);
    try {
      const r = await api.catalog.setSlug(value);
      setSlug(r.slug);
      toast({ title: r.slug ? "Link da vitrine atualizado" : "Link da vitrine desligado" });
    } catch (err) {
      toast({ title: "Erro ao salvar link", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSavingSlug(false);
    }
  };

  const publicUrl = slug ? `${window.location.origin}/vitrine/${slug}` : null;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold">Vitrine Aparelhos</h1>
          <span className="text-xs text-muted-foreground">catálogo de aparelhos, importação por IA e link público</span>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={openImport} data-testid="button-import-catalog"
              className="flex items-center gap-1.5 px-3 py-2 bg-violet-600 text-white rounded-xl text-xs font-semibold hover:bg-violet-700 transition">
              <Sparkles className="w-3.5 h-3.5" /> Importar lista com IA
            </button>
            <button onClick={openSettings} data-testid="button-catalog-settings"
              className="flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground rounded-xl text-xs font-semibold hover:bg-secondary/70 transition">
              <Settings2 className="w-3.5 h-3.5" /> Preço e cartão
            </button>
            <button onClick={openCreate} data-testid="button-add-product"
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
              <Plus className="w-3.5 h-3.5" /> Novo aparelho
            </button>
          </div>
        )}
      </div>

      {/* Link público */}
      <div className="bg-white rounded-xl border border-border p-4 flex flex-wrap items-center gap-3">
        <Link2 className="w-4 h-4 text-primary shrink-0" />
        <div className="flex-1 min-w-[220px]">
          <p className="text-xs font-semibold text-muted-foreground mb-1">Link público da vitrine (pra clientes verem sem login)</p>
          {canManage ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground shrink-0">{window.location.origin}/vitrine/</span>
              <input value={slugInput} onChange={(e) => setSlugInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="minha-loja" data-testid="input-catalog-slug"
                className="flex-1 min-w-[120px] rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              <button onClick={handleSaveSlug} disabled={savingSlug} data-testid="button-save-slug"
                className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {savingSlug ? "Salvando..." : "Salvar"}
              </button>
            </div>
          ) : (
            <p className="text-sm">{publicUrl ?? "Vitrine ainda não publicada"}</p>
          )}
        </div>
        {publicUrl && (
          <button onClick={() => { navigator.clipboard.writeText(publicUrl); toast({ title: "Link copiado!" }); }}
            data-testid="button-copy-catalog-link"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary text-xs font-semibold hover:bg-secondary/70 transition shrink-0">
            <Copy className="w-3.5 h-3.5" /> Copiar link
          </button>
        )}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por modelo ou armazenamento..."
            data-testid="input-catalog-search"
            className="w-full pl-9 pr-3 py-2 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
        </div>
        <button onClick={() => setFilterStatus(filterStatus === "active" ? "all" : "active")}
          data-testid="button-toggle-status-filter"
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${filterStatus === "active" ? "bg-primary text-white" : "bg-secondary text-muted-foreground"}`}>
          {filterStatus === "active" ? "Só ativos" : "Todos"}
        </button>
        {products.some((p) => p.status === "active") && (
          <button onClick={copyFullCatalog} data-testid="button-copy-full-catalog"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition">
            <MessageCircle className="w-3.5 h-3.5" /> Copiar catálogo pro WhatsApp
          </button>
        )}
      </div>

      {/* Grade de produtos */}
      {loading ? (
        <div className="h-24 rounded-xl bg-secondary animate-pulse" />
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Smartphone className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{products.length === 0 ? "Nenhum aparelho cadastrado ainda." : "Nada encontrado com esse filtro."}</p>
          {canManage && products.length === 0 && (
            <button onClick={openCreate} className="mt-2 text-primary font-semibold underline underline-offset-2 text-sm">Cadastrar o primeiro</button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map((p) => (
            <div key={p.id} data-testid={`product-card-${p.id}`} className="bg-white rounded-xl border border-border overflow-hidden flex flex-col">
              <div className="aspect-square bg-neutral-100 flex items-center justify-center overflow-hidden">
                {p.photos[0] ? (
                  <img src={api.catalog.photoUrl(p.photos[0].id)} alt={p.model} className="w-full h-full object-cover" />
                ) : (
                  <Smartphone className="w-8 h-8 text-neutral-300" />
                )}
              </div>
              <div className="p-3 flex-1 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">
                    {CATALOG_CONDITIONS.find((c) => c.value === p.condition)?.label}
                  </span>
                  {p.status !== "active" && (
                    <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      {p.status === "sold" ? "Vendido" : "Inativo"}
                    </span>
                  )}
                </div>
                <p className="text-sm font-semibold leading-tight">{p.model}</p>
                {p.storage && <p className="text-xs text-muted-foreground">{p.storage}</p>}
                <p className="text-sm font-bold mt-auto">{formatBRL(p.salePrice)}</p>
                {p.costPrice && <p className="text-[10px] text-muted-foreground">custo {formatBRL(p.costPrice)}</p>}
                <div className="flex items-center gap-1 pt-1">
                  <button onClick={() => copyMessage(productMessage(p))} title="Copiar mensagem" data-testid={`button-copy-product-${p.id}`}
                    className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600"><MessageCircle className="w-3.5 h-3.5" /></button>
                  {canManage && (
                    <>
                      <button onClick={() => openEdit(p)} data-testid={`button-edit-product-${p.id}`}
                        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleDelete(p)} data-testid={`button-delete-product-${p.id}`}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-red-600 ml-auto"><Trash2 className="w-3.5 h-3.5" /></button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal: criar/editar produto */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3 py-6 overflow-y-auto" onClick={closeForm}>
          <div className="bg-card rounded-xl w-full max-w-lg shadow-xl border overflow-hidden my-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><Smartphone className="w-4 h-4 text-primary" /> {editing ? "Editar aparelho" : "Novo aparelho"}</span>
              <button onClick={closeForm} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-muted-foreground">Modelo</label>
                  <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} data-testid="input-product-model"
                    placeholder="Ex.: iPhone 15 Pro Max" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Armazenamento</label>
                  <input value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })} data-testid="input-product-storage"
                    placeholder="Ex.: 256GB" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Condição</label>
                  <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as CatalogCondition })} data-testid="select-product-condition"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                    {CATALOG_CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-muted-foreground">Cores (separadas por vírgula)</label>
                  <input value={form.colors} onChange={(e) => setForm({ ...form, colors: e.target.value })} data-testid="input-product-colors"
                    placeholder="Preto, Azul, Rosa" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              </div>

              <div className="rounded-lg border border-dashed p-3 space-y-2 bg-secondary/30">
                <p className="text-xs font-semibold text-muted-foreground">Formação de preço</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Custo (nota do fornecedor)</label>
                    <input type="number" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} data-testid="input-product-cost"
                      placeholder="0,00" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Margem % (em branco = padrão)</label>
                    <input type="number" value={form.marginPercentOverride} onChange={(e) => setForm({ ...form, marginPercentOverride: e.target.value })} data-testid="input-product-margin"
                      placeholder={settings ? String(settings.defaultMarginPercent) : ""} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={form.costIncludesInvoice} onChange={(e) => setForm({ ...form, costIncludesInvoice: e.target.checked })} />
                  Custo já inclui a nota fiscal
                </label>
                <div>
                  <label className="text-xs text-muted-foreground">Preço de venda (calculado — pode ajustar na mão)</label>
                  <input type="number" value={form.salePrice} onChange={(e) => { setSalePriceTouched(true); setForm({ ...form, salePrice: e.target.value }); }} data-testid="input-product-sale-price"
                    placeholder="0,00" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Estoque</label>
                  <input type="number" value={form.stockQty} onChange={(e) => setForm({ ...form, stockQty: e.target.value })} data-testid="input-product-stock"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CatalogProduct["status"] })} data-testid="select-product-status"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                    <option value="active">Ativo (na vitrine)</option>
                    <option value="inactive">Inativo</option>
                    <option value="sold">Vendido</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground">Descrição (opcional)</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} data-testid="input-product-description"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>

              {editing && (
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Fotos</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {editing.photos.map((ph) => (
                      <div key={ph.id} className="relative w-16 h-16 rounded-lg overflow-hidden border group">
                        <img src={api.catalog.photoUrl(ph.id)} alt="" className="w-full h-full object-cover" />
                        <button onClick={() => handlePhotoRemove(ph.id)} data-testid={`button-remove-photo-${ph.id}`}
                          className="absolute inset-0 bg-black/50 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <label className="w-16 h-16 rounded-lg border border-dashed flex items-center justify-center cursor-pointer hover:bg-secondary/50 transition">
                      {uploadingPhoto ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> : <ImagePlus className="w-5 h-5 text-muted-foreground" />}
                      <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" data-testid="input-product-photos"
                        onChange={(e) => handlePhotoUpload(e.target.files)} disabled={uploadingPhoto} />
                    </label>
                  </div>
                </div>
              )}

              <button onClick={handleSave} disabled={saving} data-testid="button-save-product"
                className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {saving ? "Salvando..." : editing ? "Salvar alterações" : "Cadastrar e continuar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: importar lista via IA */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3 py-6 overflow-y-auto" onClick={() => setShowImport(false)}>
          <div className="bg-card rounded-xl w-full max-w-2xl shadow-xl border overflow-hidden my-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><Sparkles className="w-4 h-4 text-violet-600" /> Importar lista do fornecedor com IA</span>
              <button onClick={() => setShowImport(false)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
              {!importItems ? (
                <>
                  <p className="text-xs text-muted-foreground">Cole abaixo a lista de aparelhos do fornecedor (o texto que chega pelo WhatsApp, por exemplo). A IA identifica modelo, armazenamento, cor e o preço de custo automaticamente.</p>
                  <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={10} data-testid="input-import-text"
                    placeholder={"iPhone 15 128GB\nCores: Preto, Azul\nR$ 3.250\n\niPhone 15 Pro Max 256GB\n..."}
                    className="w-full rounded-lg border px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <button onClick={handleParse} disabled={parsing || !importText.trim()} data-testid="button-parse-import"
                    className="w-full py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 transition flex items-center justify-center gap-2">
                    {parsing ? <><Loader2 className="w-4 h-4 animate-spin" /> Analisando lista...</> : <><Sparkles className="w-4 h-4" /> Analisar com IA</>}
                  </button>
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <button onClick={() => setImportTab("approved")} data-testid="tab-import-approved"
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition flex items-center gap-1 ${importTab === "approved" ? "bg-primary text-white" : "bg-secondary text-muted-foreground"}`}>
                      <Check className="w-3 h-3" /> Aprovados ({approvedCount})
                    </button>
                    <button onClick={() => setImportTab("pending")} data-testid="tab-import-pending"
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition flex items-center gap-1 ${importTab === "pending" ? "bg-amber-500 text-white" : "bg-secondary text-muted-foreground"}`}>
                      <AlertTriangle className="w-3 h-3" /> Pendências ({pendingCount})
                    </button>
                  </div>
                  <div className="space-y-2">
                    {visibleImportItems.map(({ it, idx }) => (
                      <div key={idx} className={`rounded-lg border p-2.5 ${it.status === "pending" ? "border-amber-300 bg-amber-50/50" : "border-border"}`}>
                        <div className="grid grid-cols-4 gap-2 items-center">
                          <input value={it.model} onChange={(e) => updateImportItem(idx, { model: e.target.value })} data-testid={`import-item-model-${idx}`}
                            className="col-span-2 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Modelo" />
                          <input value={it.storage ?? ""} onChange={(e) => updateImportItem(idx, { storage: e.target.value || null })}
                            className="rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Armazenamento" />
                          <input type="number" value={it.costPrice ?? ""} onChange={(e) => updateImportItem(idx, { costPrice: e.target.value ? Number(e.target.value) : null })}
                            className="rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Custo R$" />
                        </div>
                        {it.issue && <p className="text-[10px] text-amber-700 mt-1">{it.issue}</p>}
                        {it.rawLine && <p className="text-[10px] text-muted-foreground mt-1 truncate">"{it.rawLine}"</p>}
                      </div>
                    ))}
                    {visibleImportItems.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">Nada aqui.</p>}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setImportItems(null)} data-testid="button-back-import"
                      className="flex-1 py-2 rounded-lg bg-secondary text-sm font-semibold hover:bg-secondary/70 transition">Voltar</button>
                    <button onClick={handleConfirmImport} disabled={confirming} data-testid="button-confirm-import"
                      className="flex-1 py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                      {confirming ? "Importando..." : `Importar ${importItems.filter((i) => i.model && i.model !== "(modelo não identificado)").length} produtos`}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: configurações de preço */}
      {showSettings && settingsForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3 py-6 overflow-y-auto" onClick={() => setShowSettings(false)}>
          <div className="bg-card rounded-xl w-full max-w-lg shadow-xl border overflow-hidden my-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><Settings2 className="w-4 h-4 text-primary" /> Preço, cartão e nota fiscal</span>
              <button onClick={() => setShowSettings(false)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
              <p className="text-xs text-muted-foreground">Essas configurações formam o preço de venda automaticamente a partir do custo: <b>preço = (custo + nota fiscal) ÷ (1 − margem% − taxa do cartão%)</b>.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Margem de lucro bruto padrão (%)</label>
                  <input type="number" value={settingsForm.defaultMarginPercent}
                    onChange={(e) => setSettingsForm({ ...settingsForm, defaultMarginPercent: Number(e.target.value) })} data-testid="input-default-margin"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Custo de nota fiscal (%)</label>
                  <input type="number" value={settingsForm.invoiceCostPercent}
                    onChange={(e) => setSettingsForm({ ...settingsForm, invoiceCostPercent: Number(e.target.value) })} data-testid="input-invoice-cost"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Taxa do cartão por nº de parcelas (%)</label>
                <div className="mt-1 grid grid-cols-4 gap-2">
                  {INSTALLMENT_OPTIONS.map((n) => (
                    <div key={n}>
                      <label className="text-[10px] text-muted-foreground">{n}x</label>
                      <input type="number" value={settingsForm.cardFeeTable[String(n)] ?? 0}
                        onChange={(e) => setSettingsForm({ ...settingsForm, cardFeeTable: { ...settingsForm.cardFeeTable, [String(n)]: Number(e.target.value) } })}
                        data-testid={`input-card-fee-${n}`}
                        className="w-full rounded-lg border px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40" />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">O preço é calculado usando a taxa de 1x como referência; as demais aparecem no parcelamento exibido ao cliente.</p>
              </div>
              <button onClick={handleSaveSettings} disabled={savingSettings} data-testid="button-save-pricing-settings"
                className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {savingSettings ? "Salvando..." : "Salvar configurações"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
