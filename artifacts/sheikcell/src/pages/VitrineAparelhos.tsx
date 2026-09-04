import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  api, canEditModule, CATALOG_CONDITIONS, CATALOG_CONDITION_CRITERIA,
  type CatalogProduct, type CatalogPricingSettings, type CatalogImportItem, type CatalogCondition,
  type CatalogImportVariant, type CatalogPhotoSearchResult, type CatalogCategory,
} from "@/lib/api";
import {
  Smartphone, Plus, X, Search, Trash2, Pencil, Sparkles, Settings2, Link2,
  Copy, ImagePlus, Check, AlertTriangle, Loader2, MessageCircle, Info, Calculator,
  Tags, Lock, KeyRound, Package,
} from "lucide-react";

function formatBRL(v: string | number | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const INSTALLMENT_OPTIONS = [1, 2, 3, 4, 6, 10, 12, 18];

type VariantFormRow = {
  id?: number;
  storage: string;
  color: string;
  costPrice: string;
  costIncludesInvoice: boolean;
  marginPercentOverride: string;
  salePrice: string;
  wholesalePrice: string;
  wholesaleMarginPercentOverride: string;
  stockQty: string;
  // Só pra exibir depois de clicar em "calcular" — não é salvo (à vista/12x
  // são derivados do custo/margem na hora de exibir, ver withInstallmentPricing
  // no backend), mas ajuda o lojista a ver a composição antes de salvar.
  priceCashPreview?: string;
  installment12Preview?: string;
  // Mesma ideia, só que pro preço de atacado (wholesalePrice já é o valor à
  // vista de atacado — isso aqui é só a prévia da parcela em 12x de atacado).
  wholesaleInstallment12Preview?: string;
};

const emptyVariant: VariantFormRow = {
  storage: "", color: "", costPrice: "", costIncludesInvoice: false, marginPercentOverride: "", salePrice: "",
  wholesalePrice: "", wholesaleMarginPercentOverride: "", stockQty: "1",
};

const emptyForm = {
  model: "", condition: "bom" as CatalogCondition, colors: "",
  description: "", status: "active" as CatalogProduct["status"], categoryId: null as number | null,
  variants: [{ ...emptyVariant }] as VariantFormRow[],
};

// "Celulares" ou "Celulares > Samsung", pra mostrar hierarquia no select.
function categoryPathLabel(categories: CatalogCategory[], id: number): string {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const cat = byId.get(id);
  if (!cat) return "";
  if (cat.parentId == null) return cat.name;
  const parent = byId.get(cat.parentId);
  return parent ? `${parent.name} > ${cat.name}` : cat.name;
}

// Faixa de preço de venda considerando todas as variantes com preço definido.
function priceRangeLabel(p: CatalogProduct): string {
  const prices = p.variants.map((v) => v.salePrice).filter((x): x is string => x != null).map(Number).filter(Number.isFinite);
  if (prices.length === 0) return "—";
  const min = Math.min(...prices), max = Math.max(...prices);
  return min === max ? formatBRL(min) : `${formatBRL(min)} a ${formatBRL(max)}`;
}

function storagesLabel(p: CatalogProduct): string {
  const list = [...new Set(p.variants.map((v) => v.storage).filter((s): s is string => !!s))];
  return list.join(", ");
}

export default function VitrineAparelhos() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = canEditModule(user, "vitrine");

  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [settings, setSettings] = useState<CatalogPricingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"active" | "all">("active");
  const [filterCategory, setFilterCategory] = useState<number | "all">("all");

  // Seleção em massa (excluir vários de uma vez, geralmente depois de
  // filtrar por categoria/busca/status pra achar só o que quer apagar).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CatalogProduct | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [showConditionInfo, setShowConditionInfo] = useState(false);

  // Busca de fotos na internet (dentro do modal de edição do produto)
  const [showPhotoSearch, setShowPhotoSearch] = useState(false);
  const [photoQuery, setPhotoQuery] = useState("");
  const [photoResults, setPhotoResults] = useState<CatalogPhotoSearchResult[] | null>(null);
  const [searchingPhotos, setSearchingPhotos] = useState(false);
  const [photoSearchError, setPhotoSearchError] = useState<string | null>(null);
  const [attachingPhotoUrl, setAttachingPhotoUrl] = useState<string | null>(null);

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importItems, setImportItems] = useState<CatalogImportItem[] | null>(null);
  const [importTab, setImportTab] = useState<"approved" | "pending">("approved");
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Categorias/subcategorias novas sugeridas pela IA (que ainda não existem
  // na loja) — só são criadas de verdade se o lojista autorizar explicitamente.
  const [importNewCategoryPaths, setImportNewCategoryPaths] = useState<string[][]>([]);
  const [authorizeNewCategories, setAuthorizeNewCategories] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<CatalogPricingSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [slug, setSlug] = useState<string | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [savingSlug, setSavingSlug] = useState(false);

  const [whatsapp, setWhatsapp] = useState<string | null>(null);
  const [whatsappInput, setWhatsappInput] = useState("");
  const [savingWhatsapp, setSavingWhatsapp] = useState(false);

  const [whatsappWholesale, setWhatsappWholesale] = useState<string | null>(null);
  const [whatsappWholesaleInput, setWhatsappWholesaleInput] = useState("");
  const [savingWhatsappWholesale, setSavingWhatsappWholesale] = useState(false);

  const [hasWholesaleCode, setHasWholesaleCode] = useState(false);
  const [wholesaleCodeInput, setWholesaleCodeInput] = useState("");
  const [savingWholesaleCode, setSavingWholesaleCode] = useState(false);

  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [showCategories, setShowCategories] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParent, setNewCategoryParent] = useState<number | "">("");
  const [savingCategory, setSavingCategory] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.catalog.list(), api.catalog.getSlug(), api.catalog.getWhatsapp(), api.catalog.getWhatsappWholesale(),
      api.catalog.categories(), api.catalog.getWholesaleCode(),
    ])
      .then(([l, s, w, ww, cats, wc]) => {
        setProducts(l.products); setSettings(l.settings);
        setSlug(s.slug); setSlugInput(s.slug ?? "");
        setWhatsapp(w.whatsapp); setWhatsappInput(w.whatsapp ?? "");
        setWhatsappWholesale(ww.whatsapp); setWhatsappWholesaleInput(ww.whatsapp ?? "");
        setCategories(cats.categories);
        setHasWholesaleCode(wc.hasCode); setWholesaleCodeInput(wc.code ?? "");
      })
      .catch(() => toast({ title: "Erro ao carregar a vitrine", variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const topCategories = categories.filter((c) => c.parentId == null);
  const childCategories = (parentId: number) => categories.filter((c) => c.parentId === parentId);

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name || savingCategory) return;
    setSavingCategory(true);
    try {
      const created = await api.catalog.createCategory({ name, parentId: newCategoryParent === "" ? null : newCategoryParent });
      setCategories((prev) => [...prev, created]);
      setNewCategoryName(""); setNewCategoryParent("");
    } catch (err) {
      toast({ title: "Erro ao criar categoria", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSavingCategory(false);
    }
  };

  const handleRenameCategory = async (id: number, name: string) => {
    try {
      const updated = await api.catalog.updateCategory(id, { name });
      setCategories((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch { toast({ title: "Erro ao renomear categoria", variant: "destructive" }); }
  };

  const handleDeleteCategory = async (c: CatalogCategory) => {
    const hasChildren = categories.some((x) => x.parentId === c.id);
    if (!confirm(hasChildren ? `Excluir "${c.name}" e todas as subcategorias?` : `Excluir "${c.name}"?`)) return;
    try {
      await api.catalog.removeCategory(c.id);
      setCategories((prev) => prev.filter((x) => x.id !== c.id && x.parentId !== c.id));
      setProducts((prev) => prev.map((p) => (p.categoryId === c.id || (hasChildren && categories.some((x) => x.parentId === c.id && x.id === p.categoryId)) ? { ...p, categoryId: null } : p)));
    } catch { toast({ title: "Erro ao excluir categoria", variant: "destructive" }); }
  };

  // Muda a categoria de um produto direto pelo card, sem precisar abrir o
  // formulário de edição inteiro.
  const handleQuickCategoryChange = async (p: CatalogProduct, categoryId: number | null) => {
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, categoryId } : x)));
    try {
      await api.catalog.update(p.id, { categoryId });
    } catch {
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, categoryId: p.categoryId } : x)));
      toast({ title: "Erro ao mudar categoria", variant: "destructive" });
    }
  };

  const handleSaveWholesaleCode = async () => {
    if (savingWholesaleCode) return;
    setSavingWholesaleCode(true);
    try {
      const r = await api.catalog.setWholesaleCode(wholesaleCodeInput.trim());
      setHasWholesaleCode(r.hasCode); setWholesaleCodeInput(r.code ?? "");
      toast({ title: r.hasCode ? "Código de atacado atualizado" : "Preço de atacado desligado" });
    } catch (err) {
      toast({ title: "Erro ao salvar código", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSavingWholesaleCode(false);
    }
  };

  const filtered = products.filter((p) =>
    (filterStatus === "all" || p.status === "active") &&
    (filterCategory === "all" || p.categoryId === filterCategory) &&
    (!search || p.model.toLowerCase().includes(search.toLowerCase()) || storagesLabel(p).toLowerCase().includes(search.toLowerCase()))
  );

  const toggleSelectMode = () => { setSelectMode((v) => !v); setSelectedIds(new Set()); };
  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllFiltered = () => setSelectedIds(new Set(filtered.map((p) => p.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkDelete = async () => {
    if (bulkDeleting || selectedIds.size === 0) return;
    if (!confirm(`Excluir ${selectedIds.size} aparelho(s) selecionado(s)? As fotos também serão apagadas. Essa ação não pode ser desfeita.`)) return;
    setBulkDeleting(true);
    try {
      const ids = [...selectedIds];
      const r = await api.catalog.bulkRemove(ids);
      setProducts((prev) => prev.filter((p) => !selectedIds.has(p.id)));
      setSelectedIds(new Set());
      setSelectMode(false);
      toast({ title: `${r.deleted} aparelho(s) excluído(s)` });
    } catch (err) {
      toast({ title: "Erro ao excluir em massa", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setBulkDeleting(false);
    }
  };

  // ─── Formulário de produto ─────────────────────────────────────────────
  const openCreate = () => { setEditing(null); setForm({ ...emptyForm, variants: [{ ...emptyVariant }] }); setShowConditionInfo(false); setShowForm(true); };
  const openEdit = (p: CatalogProduct) => {
    setEditing(p);
    setForm({
      model: p.model, condition: p.condition, colors: p.colors.join(", "),
      description: p.description ?? "", status: p.status, categoryId: p.categoryId,
      variants: p.variants.length > 0
        ? p.variants.map((v) => ({
            id: v.id, storage: v.storage ?? "", color: v.color ?? "", costPrice: v.costPrice ?? "", costIncludesInvoice: v.costIncludesInvoice,
            marginPercentOverride: v.marginPercentOverride ?? "", salePrice: v.salePrice ?? "", wholesalePrice: v.wholesalePrice ?? "",
            wholesaleMarginPercentOverride: v.wholesaleMarginPercentOverride ?? "",
            stockQty: String(v.stockQty),
          }))
        : [{ ...emptyVariant }],
    });
    setShowConditionInfo(false);
    setShowPhotoSearch(false); setPhotoResults(null); setPhotoQuery("");
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditing(null); setShowPhotoSearch(false); setPhotoResults(null); };

  const updateVariant = (idx: number, patch: Partial<VariantFormRow>) => {
    setForm((f) => ({ ...f, variants: f.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)) }));
  };
  const addVariant = () => setForm((f) => ({ ...f, variants: [...f.variants, { ...emptyVariant }] }));
  const removeVariant = (idx: number) => setForm((f) => ({ ...f, variants: f.variants.length > 1 ? f.variants.filter((_, i) => i !== idx) : f.variants }));

  const calcVariantPrice = async (idx: number) => {
    const v = form.variants[idx];
    const custo = Number(v.costPrice);
    if (!Number.isFinite(custo) || custo <= 0) { toast({ title: "Informe o custo dessa variante primeiro", variant: "destructive" }); return; }
    try {
      const r = await api.catalog.simulatePrice({
        costPrice: custo, costIncludesInvoice: v.costIncludesInvoice,
        marginPercentOverride: v.marginPercentOverride ? Number(v.marginPercentOverride) : null,
        wholesaleMarginPercentOverride: v.wholesaleMarginPercentOverride ? Number(v.wholesaleMarginPercentOverride) : null,
      });
      const patch: Partial<VariantFormRow> = {};
      if (r.salePrice != null) patch.salePrice = String(r.salePrice);
      if (r.wholesalePrice != null) patch.wholesalePrice = String(r.wholesalePrice);
      patch.priceCashPreview = r.priceCash != null ? formatBRL(r.priceCash) : undefined;
      patch.installment12Preview = r.installment12 != null ? `12x de ${formatBRL(r.installment12.parcela)}` : undefined;
      patch.wholesaleInstallment12Preview = r.wholesaleInstallment12 != null ? `12x de ${formatBRL(r.wholesaleInstallment12.parcela)}` : undefined;
      updateVariant(idx, patch);
    } catch { toast({ title: "Erro ao calcular preço", variant: "destructive" }); }
  };

  const handleSave = async () => {
    if (saving) return;
    const model = form.model.trim();
    if (!model) { toast({ title: "Informe o modelo do aparelho", variant: "destructive" }); return; }
    setSaving(true);
    const payload: Record<string, unknown> = {
      model,
      condition: form.condition,
      colors: form.colors.split(",").map((c) => c.trim()).filter(Boolean),
      description: form.description.trim() || null,
      status: form.status,
      categoryId: form.categoryId,
      variants: form.variants.map((v) => ({
        id: v.id,
        storage: v.storage.trim() || null,
        color: v.color.trim() || null,
        costPrice: v.costPrice ? Number(v.costPrice) : null,
        costIncludesInvoice: v.costIncludesInvoice,
        marginPercentOverride: v.marginPercentOverride ? Number(v.marginPercentOverride) : null,
        salePrice: v.salePrice ? Number(v.salePrice) : null,
        wholesalePrice: v.wholesalePrice ? Number(v.wholesalePrice) : null,
        wholesaleMarginPercentOverride: v.wholesaleMarginPercentOverride ? Number(v.wholesaleMarginPercentOverride) : null,
        stockQty: Number(v.stockQty) || 0,
      })),
    };
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

  // Marca/desmarca uma foto como "da caixa" (embalagem lacrada) — só faz
  // diferença pra aparelhos "novo": a vitrine pública mostra ela primeiro
  // nesse caso, e some pra qualquer outra condição (ver publicPhotoIds na API).
  const handleToggleBoxPhoto = async (photoId: number, next: boolean) => {
    if (!editing) return;
    try {
      const updated = await api.catalog.setBoxPhoto(editing.id, photoId, next);
      const apply = (photos: typeof editing.photos) => photos.map((ph) => (ph.id === photoId ? updated : ph));
      setEditing((prev) => prev && { ...prev, photos: apply(prev.photos) });
      setProducts((prev) => prev.map((p) => (p.id === editing.id ? { ...p, photos: apply(p.photos) } : p)));
    } catch { toast({ title: "Erro ao marcar foto da caixa", variant: "destructive" }); }
  };

  // ─── Busca de fotos padronizadas na internet ────────────────────────────
  const openPhotoSearch = () => {
    setPhotoQuery(editing ? editing.model : form.model);
    setPhotoResults(null);
    setPhotoSearchError(null);
    setShowPhotoSearch(true);
  };

  const handlePhotoSearch = async () => {
    if (!photoQuery.trim() || searchingPhotos) return;
    setSearchingPhotos(true);
    setPhotoSearchError(null);
    try {
      const r = await api.catalog.photoSearch(photoQuery.trim());
      setPhotoResults(r.results);
      if (r.results.length === 0) toast({ title: "Nenhuma imagem encontrada pra essa busca" });
    } catch (err) {
      setPhotoResults(null);
      setPhotoSearchError(err instanceof Error ? err.message : "Busca de imagens indisponível");
    } finally {
      setSearchingPhotos(false);
    }
  };

  const handleUsePhotoResult = async (result: CatalogPhotoSearchResult) => {
    if (!editing || attachingPhotoUrl) return;
    setAttachingPhotoUrl(result.imageUrl);
    try {
      const photo = await api.catalog.addPhotoFromUrl(editing.id, result.imageUrl);
      setEditing((prev) => prev && { ...prev, photos: [...prev.photos, photo] });
      setProducts((prev) => prev.map((p) => (p.id === editing.id ? { ...p, photos: [...p.photos, photo] } : p)));
      toast({ title: "Foto adicionada" });
    } catch (err) {
      toast({ title: "Erro ao anexar imagem", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setAttachingPhotoUrl(null);
    }
  };

  // ─── Copiar mensagem formatada pro WhatsApp ────────────────────────────
  const productMessage = (p: CatalogProduct) => [
    `📱 ${p.model}`,
    `✨ Qualidade: ${CATALOG_CONDITIONS.find((c) => c.value === p.condition)?.label ?? p.condition}`,
    p.colors.length ? `🎨 Cores: ${p.colors.join(", ")}` : null,
    ...p.variants
      .filter((v) => v.salePrice != null)
      .map((v) => {
        const label = [v.storage, v.color].filter(Boolean).join(" ");
        return `💰 ${label ? `${label}: ` : ""}${formatBRL(v.salePrice)}${v.stockQty <= 0 ? " (sem estoque)" : ""}`;
      }),
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
  const openImport = () => {
    setImportText(""); setImportItems(null); setImportTab("approved");
    setImportNewCategoryPaths([]); setAuthorizeNewCategories(false);
    setShowImport(true);
  };

  const handleParse = async () => {
    if (parsing || !importText.trim()) return;
    setParsing(true);
    try {
      const r = await api.catalog.importParse(importText);
      setImportItems(r.items);
      setImportNewCategoryPaths(r.newCategoryPaths ?? []);
      setAuthorizeNewCategories(false);
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
  const updateImportVariant = (idx: number, vIdx: number, patch: Partial<CatalogImportVariant>) => {
    setImportItems((prev) => prev && prev.map((it, i) => (i === idx ? { ...it, variants: it.variants.map((v, j) => (j === vIdx ? { ...v, ...patch } : v)) } : it)));
  };
  const addImportVariant = (idx: number) => {
    setImportItems((prev) => prev && prev.map((it, i) => (i === idx ? { ...it, variants: [...it.variants, { storage: null, color: null, costPrice: null }] } : it)));
  };
  const removeImportVariant = (idx: number, vIdx: number) => {
    setImportItems((prev) => prev && prev.map((it, i) => (i === idx ? { ...it, variants: it.variants.length > 1 ? it.variants.filter((_, j) => j !== vIdx) : it.variants } : it)));
  };

  // Cria (ou reaproveita, se já existir) cada nível do caminho de categoria
  // sugerido — ex.: ["Celulares","Samsung"] cria "Samsung" como subcategoria
  // de "Celulares" (criando "Celulares" também, se nem ele existir ainda).
  // Só é chamada quando o lojista autorizou explicitamente.
  const ensureCategoryPath = async (path: string[], localCategories: CatalogCategory[], cache: Map<string, number>): Promise<{ id: number; categories: CatalogCategory[] }> => {
    let parentId: number | null = null;
    let key = "";
    let cats = localCategories;
    for (const name of path) {
      key = key ? `${key}>${name.toLowerCase()}` : name.toLowerCase();
      const cached = cache.get(key);
      if (cached != null) { parentId = cached; continue; }
      const existing = cats.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.parentId === parentId);
      if (existing) { cache.set(key, existing.id); parentId = existing.id; continue; }
      const created = await api.catalog.createCategory({ name, parentId });
      cache.set(key, created.id);
      cats = [...cats, created];
      parentId = created.id;
    }
    return { id: parentId as number, categories: cats };
  };

  const handleConfirmImport = async () => {
    if (!importItems || confirming) return;
    const toImport = importItems.filter((i) => i.model && i.model !== "(modelo não identificado)" && i.model !== "(sem modelo)");
    if (toImport.length === 0) { toast({ title: "Nenhum item pronto para importar", variant: "destructive" }); return; }
    setConfirming(true);
    try {
      let localCategories = categories;
      const pathIdCache = new Map<string, number>();
      if (authorizeNewCategories && importNewCategoryPaths.length > 0) {
        for (const path of importNewCategoryPaths) {
          const r = await ensureCategoryPath(path, localCategories, pathIdCache);
          localCategories = r.categories;
        }
        setCategories(localCategories);
      }
      const resolved = toImport.map((it) => {
        if (it.categoryId != null) return it;
        if (it.categoryPath && authorizeNewCategories) {
          const key = it.categoryPath.map((n) => n.toLowerCase()).join(">");
          const id = pathIdCache.get(key);
          if (id != null) return { ...it, categoryId: id };
        }
        return it; // sem categoria (o lojista pode ter escolhido uma manualmente — já está em it.categoryId)
      });
      const r = await api.catalog.importConfirm(resolved);
      setProducts((prev) => [...r.products.map((p) => ({ ...p, photos: [], variants: [] as CatalogProduct["variants"] })), ...prev]);
      // Sem GOOGLE_CSE_API_KEY/CX configurada no servidor a busca automática
      // nem roda — sem isso o lojista via "importado" sem nenhuma pista de
      // por que as fotos nunca vêm sozinhas.
      const photoNote = r.photoSearchConfigured === false
        ? " Busca automática de fotos não está configurada no servidor — adicione as fotos manualmente ou peça pro suporte configurar."
        : r.photosAttached
          ? ` ${r.photosAttached} já com foto encontrada na internet.`
          : " Nenhuma foto encontrada automaticamente — adicione manualmente na edição do produto.";
      toast({ title: `${r.imported} aparelho(s) importado(s)! Recarregando lista...${photoNote}` });
      setShowImport(false);
      load();
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

  const handleSaveWhatsapp = async () => {
    if (savingWhatsapp) return;
    setSavingWhatsapp(true);
    try {
      const r = await api.catalog.setWhatsapp(whatsappInput.trim());
      setWhatsapp(r.whatsapp);
      toast({ title: r.whatsapp ? "WhatsApp da vitrine atualizado" : "WhatsApp da vitrine removido" });
    } catch (err) {
      toast({ title: "Erro ao salvar WhatsApp", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSavingWhatsapp(false);
    }
  };

  const handleSaveWhatsappWholesale = async () => {
    if (savingWhatsappWholesale) return;
    setSavingWhatsappWholesale(true);
    try {
      const r = await api.catalog.setWhatsappWholesale(whatsappWholesaleInput.trim());
      setWhatsappWholesale(r.whatsapp);
      toast({ title: r.whatsapp ? "WhatsApp de atacado atualizado" : "WhatsApp de atacado removido (volta a usar o de varejo)" });
    } catch (err) {
      toast({ title: "Erro ao salvar WhatsApp de atacado", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSavingWhatsappWholesale(false);
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
            <button onClick={() => setShowCategories(true)} data-testid="button-catalog-categories"
              className="flex items-center gap-1.5 px-3 py-2 bg-secondary text-foreground rounded-xl text-xs font-semibold hover:bg-secondary/70 transition">
              <Tags className="w-3.5 h-3.5" /> Categorias
            </button>
            <button onClick={openCreate} data-testid="button-add-product"
              className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
              <Plus className="w-3.5 h-3.5" /> Novo aparelho
            </button>
          </div>
        )}
      </div>

      {/* Link público + WhatsApp */}
      <div className="bg-white rounded-xl border border-border p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
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
        {canManage && (
          <div className="flex flex-wrap items-center gap-3 pt-3 border-t">
            <MessageCircle className="w-4 h-4 text-emerald-600 shrink-0" />
            <div className="flex-1 min-w-[220px]">
              <p className="text-xs font-semibold text-muted-foreground mb-1">WhatsApp oficial da loja (botão "Falar no WhatsApp" da vitrine pública)</p>
              <div className="flex items-center gap-2">
                <input value={whatsappInput} onChange={(e) => setWhatsappInput(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="Ex.: 5511999998888 (DDI+DDD+número)" data-testid="input-catalog-whatsapp"
                  className="flex-1 min-w-[160px] rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                <button onClick={handleSaveWhatsapp} disabled={savingWhatsapp} data-testid="button-save-whatsapp"
                  className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                  {savingWhatsapp ? "Salvando..." : "Salvar"}
                </button>
              </div>
              {!whatsapp && <p className="text-[10px] text-amber-600 mt-1">Sem número configurado, a vitrine usa o telefone de contato administrativo como reserva.</p>}
            </div>
          </div>
        )}
        {canManage && (
          <div className="flex flex-wrap items-center gap-3 pt-3 border-t">
            <MessageCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <div className="flex-1 min-w-[220px]">
              <p className="text-xs font-semibold text-muted-foreground mb-1">WhatsApp de atacado (técnicos/lojistas com código de acesso) — em branco usa o mesmo número do varejo</p>
              <div className="flex items-center gap-2">
                <input value={whatsappWholesaleInput} onChange={(e) => setWhatsappWholesaleInput(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="Ex.: 5511999997777 (DDI+DDD+número)" data-testid="input-catalog-whatsapp-wholesale"
                  className="flex-1 min-w-[160px] rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                <button onClick={handleSaveWhatsappWholesale} disabled={savingWhatsappWholesale} data-testid="button-save-whatsapp-wholesale"
                  className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                  {savingWhatsappWholesale ? "Salvando..." : "Salvar"}
                </button>
              </div>
              {!whatsappWholesale && <p className="text-[10px] text-muted-foreground mt-1">Cliente que desbloquear o preço de atacado vai falar no mesmo WhatsApp do varejo, {whatsapp ?? "o número de contato administrativo"}.</p>}
            </div>
          </div>
        )}
        {canManage && (
          <div className="flex flex-wrap items-center gap-3 pt-3 border-t">
            <KeyRound className="w-4 h-4 text-amber-600 shrink-0" />
            <div className="flex-1 min-w-[220px]">
              <p className="text-xs font-semibold text-muted-foreground mb-1">Código de acesso ao preço de atacado (pra técnicos e lojistas)</p>
              <div className="flex items-center gap-2">
                <input value={wholesaleCodeInput} onChange={(e) => setWholesaleCodeInput(e.target.value)}
                  placeholder="Ex.: sheikcell2026" data-testid="input-wholesale-code"
                  className="flex-1 min-w-[160px] rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                <button onClick={handleSaveWholesaleCode} disabled={savingWholesaleCode} data-testid="button-save-wholesale-code"
                  className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                  {savingWholesaleCode ? "Salvando..." : "Salvar"}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {hasWholesaleCode
                  ? "Compartilhe esse código só com quem deve ver o preço de atacado — quem tiver o código destrava o preço na vitrine pública."
                  : "Sem código configurado, o preço de atacado fica desligado (mesmo que você preencha o campo em algum aparelho, ninguém vê)."}
              </p>
            </div>
          </div>
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
        {categories.length > 0 && (
          <select value={filterCategory === "all" ? "" : filterCategory} onChange={(e) => setFilterCategory(e.target.value ? Number(e.target.value) : "all")}
            data-testid="select-filter-category"
            className="rounded-full border px-3 py-1.5 text-xs font-semibold bg-white text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40">
            <option value="">Todas as categorias</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{categoryPathLabel(categories, c.id)}</option>)}
          </select>
        )}
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
        {canManage && products.length > 0 && (
          <button onClick={toggleSelectMode} data-testid="button-toggle-select-mode"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition ${selectMode ? "bg-red-100 text-red-700" : "bg-secondary text-muted-foreground hover:bg-secondary/70"}`}>
            <Check className="w-3.5 h-3.5" /> {selectMode ? "Cancelar seleção" : "Selecionar"}
          </button>
        )}
      </div>

      {selectMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed bg-secondary/30 px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">{selectedIds.size} selecionado(s) de {filtered.length} exibido(s)</span>
          <button onClick={selectAllFiltered} data-testid="button-select-all-filtered"
            className="text-xs font-semibold text-primary hover:underline">Selecionar todos os filtrados</button>
          {selectedIds.size > 0 && (
            <button onClick={clearSelection} data-testid="button-clear-selection"
              className="text-xs font-semibold text-muted-foreground hover:underline">Limpar seleção</button>
          )}
          <button onClick={handleBulkDelete} disabled={selectedIds.size === 0 || bulkDeleting} data-testid="button-bulk-delete"
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-40 transition">
            <Trash2 className="w-3.5 h-3.5" /> {bulkDeleting ? "Excluindo..." : `Excluir selecionados (${selectedIds.size})`}
          </button>
        </div>
      )}

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
            <div key={p.id} data-testid={`product-card-${p.id}`}
              onClick={() => selectMode && toggleSelected(p.id)}
              className={`bg-white rounded-xl border overflow-hidden flex flex-col ${selectMode ? "cursor-pointer" : ""} ${selectMode && selectedIds.has(p.id) ? "border-primary ring-2 ring-primary/40" : "border-border"}`}>
              <div className="relative aspect-square bg-neutral-100 flex items-center justify-center overflow-hidden">
                {selectMode && (
                  <div className={`absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center ${selectedIds.has(p.id) ? "bg-primary border-primary" : "bg-white/90 border-neutral-300"}`}>
                    {selectedIds.has(p.id) && <Check className="w-3.5 h-3.5 text-white" />}
                  </div>
                )}
                {p.photos[0] ? (
                  <img src={api.catalog.photoUrl(p.photos[0].id)} alt={p.model} className="w-full h-full object-cover" />
                ) : (
                  <Smartphone className="w-8 h-8 text-neutral-300" />
                )}
              </div>
              <div className="p-3 flex-1 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span title={CATALOG_CONDITION_CRITERIA[p.condition].criteria.map((c) => `${c.label}: ${c.text}`).join(" · ")}
                    className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600 cursor-help">
                    {CATALOG_CONDITIONS.find((c) => c.value === p.condition)?.label}
                  </span>
                  {p.status !== "active" && (
                    <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      {p.status === "sold" ? "Vendido" : "Inativo"}
                    </span>
                  )}
                </div>
                <p className="text-sm font-semibold leading-tight">{p.model}</p>
                {storagesLabel(p) && <p className="text-xs text-muted-foreground">{storagesLabel(p)}</p>}
                {p.variants.length > 1 && <p className="text-[10px] text-muted-foreground">{p.variants.length} variantes</p>}
                {canManage && !selectMode && (
                  <select value={p.categoryId ?? ""} onChange={(e) => handleQuickCategoryChange(p, e.target.value ? Number(e.target.value) : null)}
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`select-quick-category-${p.id}`} title="Mudar categoria"
                    className="text-[10px] rounded border px-1.5 py-1 bg-white text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40">
                    <option value="">Sem categoria</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{categoryPathLabel(categories, c.id)}</option>)}
                  </select>
                )}
                <p className="text-sm font-bold mt-auto">{priceRangeLabel(p)}</p>
                {!selectMode && (
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
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal: criar/editar produto */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3 py-6 overflow-y-auto" onClick={closeForm}>
          <div className="bg-card rounded-xl w-full max-w-2xl shadow-xl border overflow-hidden my-auto" onClick={(e) => e.stopPropagation()}>
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
                  <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                    Selo de qualidade
                    <button type="button" onClick={() => setShowConditionInfo((v) => !v)} data-testid="button-toggle-condition-info"
                      className="text-muted-foreground hover:text-primary"><Info className="w-3 h-3" /></button>
                  </label>
                  <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as CatalogCondition })} data-testid="select-product-condition"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                    {CATALOG_CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Cores (separadas por vírgula)</label>
                  <input value={form.colors} onChange={(e) => setForm({ ...form, colors: e.target.value })} data-testid="input-product-colors"
                    placeholder="Preto, Azul, Rosa" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-muted-foreground">Categoria (aba da vitrine pública)</label>
                  <select value={form.categoryId ?? ""} onChange={(e) => setForm({ ...form, categoryId: e.target.value ? Number(e.target.value) : null })}
                    data-testid="select-product-category"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                    <option value="">Sem categoria</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{categoryPathLabel(categories, c.id)}</option>)}
                  </select>
                </div>
              </div>

              {showConditionInfo && (
                <div className="rounded-lg border bg-secondary/30 p-3 space-y-1">
                  <p className="text-xs font-semibold">{CATALOG_CONDITION_CRITERIA[form.condition].label} — critério padrão SheikCell</p>
                  {CATALOG_CONDITION_CRITERIA[form.condition].criteria.map((c) => (
                    <p key={c.label} className="text-[11px] text-muted-foreground"><b>{c.label}:</b> {c.text}</p>
                  ))}
                </div>
              )}

              {/* Variantes de armazenamento */}
              <div className="rounded-lg border border-dashed p-3 space-y-3 bg-secondary/30">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground">Variantes (armazenamento + cor) — preço e estoque próprios de cada combinação</p>
                  <button type="button" onClick={addVariant} data-testid="button-add-variant"
                    className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
                    <Plus className="w-3 h-3" /> Adicionar variante
                  </button>
                </div>
                {form.variants.map((v, idx) => (
                  <div key={idx} className="rounded-lg border bg-white p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <input value={v.storage} onChange={(e) => updateVariant(idx, { storage: e.target.value })}
                        placeholder="Ex.: 256GB" data-testid={`input-variant-storage-${idx}`}
                        className="flex-1 rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
                      <input value={v.color} onChange={(e) => updateVariant(idx, { color: e.target.value })}
                        placeholder="Cor (opcional)" data-testid={`input-variant-color-${idx}`}
                        className="flex-1 rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
                      {form.variants.length > 1 && (
                        <button type="button" onClick={() => removeVariant(idx)} data-testid={`button-remove-variant-${idx}`}
                          className="p-1.5 rounded hover:bg-red-50 text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-muted-foreground">Custo (nota do fornecedor)</label>
                        <input type="number" value={v.costPrice} onChange={(e) => updateVariant(idx, { costPrice: e.target.value })}
                          placeholder="0,00" data-testid={`input-variant-cost-${idx}`}
                          className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground">Margem % (em branco = padrão)</label>
                        <input type="number" value={v.marginPercentOverride} onChange={(e) => updateVariant(idx, { marginPercentOverride: e.target.value })}
                          placeholder={settings ? String(settings.defaultMarginPercent) : ""} data-testid={`input-variant-margin-${idx}`}
                          className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input type="checkbox" checked={v.costIncludesInvoice} onChange={(e) => updateVariant(idx, { costIncludesInvoice: e.target.checked })} />
                      Custo já inclui a nota fiscal
                    </label>
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <label className="text-[10px] text-muted-foreground">Preço de venda (em branco = calcula do custo)</label>
                        <input type="number" value={v.salePrice} onChange={(e) => updateVariant(idx, { salePrice: e.target.value })}
                          placeholder="0,00" data-testid={`input-variant-sale-price-${idx}`}
                          className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-primary/40" />
                        {(v.priceCashPreview || v.installment12Preview) && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {v.priceCashPreview && <>à vista: <b>{v.priceCashPreview}</b></>}
                            {v.priceCashPreview && v.installment12Preview && " · "}
                            {v.installment12Preview && <>ou <b>{v.installment12Preview}</b></>}
                          </p>
                        )}
                      </div>
                      <button type="button" onClick={() => calcVariantPrice(idx)} title="Calcular a partir do custo" data-testid={`button-calc-variant-${idx}`}
                        className="p-2 rounded border hover:bg-secondary text-muted-foreground"><Calculator className="w-3.5 h-3.5" /></button>
                      <div className="w-20">
                        <label className="text-[10px] text-muted-foreground">Estoque</label>
                        <input type="number" value={v.stockQty} onChange={(e) => updateVariant(idx, { stockQty: e.target.value })} data-testid={`input-variant-stock-${idx}`}
                          className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
                      </div>
                    </div>
                    <div className="rounded border border-amber-200 bg-amber-50/50 p-2 space-y-2">
                      <p className="text-[10px] font-semibold text-amber-800 flex items-center gap-1"><Lock className="w-2.5 h-2.5" /> Preço de atacado — só aparece pra quem tem o código de acesso</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground">Margem de atacado % (em branco = padrão)</label>
                          <input type="number" value={v.wholesaleMarginPercentOverride} onChange={(e) => updateVariant(idx, { wholesaleMarginPercentOverride: e.target.value })}
                            placeholder={settings ? String(settings.wholesaleMarginPercent) : ""} data-testid={`input-variant-wholesale-margin-${idx}`}
                            className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400/60" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground">Preço de atacado (em branco = calcula do custo)</label>
                          <input type="number" value={v.wholesalePrice} onChange={(e) => updateVariant(idx, { wholesalePrice: e.target.value })}
                            placeholder="0,00" data-testid={`input-variant-wholesale-price-${idx}`}
                            className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-amber-400/60" />
                          {(v.wholesalePrice || v.wholesaleInstallment12Preview) && (
                            <p className="mt-0.5 text-[10px] text-amber-700">
                              {v.wholesalePrice && <>à vista: <b>{formatBRL(Number(v.wholesalePrice))}</b></>}
                              {v.wholesalePrice && v.wholesaleInstallment12Preview && " · "}
                              {v.wholesaleInstallment12Preview && <>ou <b>{v.wholesaleInstallment12Preview}</b></>}
                            </p>
                          )}
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground">Clique em <Calculator className="w-2.5 h-2.5 inline" /> acima pra calcular o preço de venda e o de atacado (à vista e 12x) juntos a partir do custo.</p>
                    </div>
                  </div>
                ))}
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

              <div>
                <label className="text-xs font-semibold text-muted-foreground">Descrição (opcional)</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} data-testid="input-product-description"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>

              {editing && (
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-muted-foreground">Fotos</label>
                    <button type="button" onClick={openPhotoSearch} data-testid="button-open-photo-search"
                      className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
                      <Search className="w-3 h-3" /> Buscar fotos na internet
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Marque <Package className="w-2.5 h-2.5 inline" /> na foto da caixa lacrada: pra aparelhos "novo" ela aparece primeiro na vitrine; pras demais condições, fotos de caixa não aparecem pro cliente.</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {editing.photos.map((ph) => (
                      <div key={ph.id} className="relative w-16 h-16 rounded-lg overflow-hidden border group">
                        <img src={api.catalog.photoUrl(ph.id)} alt="" className="w-full h-full object-cover" />
                        {ph.isBoxPhoto && (
                          <span className="absolute top-0.5 left-0.5 bg-primary text-white rounded p-0.5 pointer-events-none">
                            <Package className="w-3 h-3" />
                          </span>
                        )}
                        <div className="absolute inset-0 bg-black/50 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1 transition">
                          <button onClick={() => handleToggleBoxPhoto(ph.id, !ph.isBoxPhoto)} title={ph.isBoxPhoto ? "Desmarcar foto da caixa" : "Marcar como foto da caixa"}
                            data-testid={`button-toggle-box-photo-${ph.id}`}
                            className={`p-1 rounded ${ph.isBoxPhoto ? "bg-primary" : "hover:bg-white/20"}`}>
                            <Package className="w-4 h-4" />
                          </button>
                          <button onClick={() => handlePhotoRemove(ph.id)} data-testid={`button-remove-photo-${ph.id}`} className="p-1 rounded hover:bg-white/20">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                    <label className="w-16 h-16 rounded-lg border border-dashed flex items-center justify-center cursor-pointer hover:bg-secondary/50 transition">
                      {uploadingPhoto ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> : <ImagePlus className="w-5 h-5 text-muted-foreground" />}
                      <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" data-testid="input-product-photos"
                        onChange={(e) => handlePhotoUpload(e.target.files)} disabled={uploadingPhoto} />
                    </label>
                  </div>

                  {showPhotoSearch && (
                    <div className="mt-2 rounded-lg border bg-secondary/30 p-2.5 space-y-2">
                      <div className="flex items-center gap-2">
                        <input value={photoQuery} onChange={(e) => setPhotoQuery(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handlePhotoSearch()}
                          placeholder="Ex.: iPhone 15 Pro Max Preto" data-testid="input-photo-search-query"
                          className="flex-1 rounded border px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" />
                        <button type="button" onClick={handlePhotoSearch} disabled={searchingPhotos} data-testid="button-run-photo-search"
                          className="px-3 py-1.5 rounded bg-primary text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1">
                          {searchingPhotos ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Buscar
                        </button>
                      </div>
                      {photoSearchError && <p className="text-[11px] text-amber-700">{photoSearchError}</p>}
                      {photoResults && photoResults.length > 0 && (
                        <div className="grid grid-cols-4 gap-2">
                          {photoResults.map((r) => (
                            <button key={r.imageUrl} type="button" onClick={() => handleUsePhotoResult(r)} title={r.title}
                              disabled={attachingPhotoUrl != null} data-testid={`button-use-photo-result-${r.imageUrl}`}
                              className="relative aspect-square rounded overflow-hidden border hover:ring-2 hover:ring-primary/50 transition disabled:opacity-50">
                              <img src={r.thumbnailUrl || r.imageUrl} alt={r.title} className="w-full h-full object-cover" />
                              {attachingPhotoUrl === r.imageUrl && (
                                <div className="absolute inset-0 bg-black/40 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-white" /></div>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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
                  <p className="text-xs text-muted-foreground">Cole abaixo a lista de aparelhos do fornecedor (o texto que chega pelo WhatsApp, por exemplo). A IA identifica modelo, armazenamento, cor e o preço de custo automaticamente — e agrupa cores/memórias do mesmo modelo num só cadastro com várias variantes.</p>
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
                  {importNewCategoryPaths.length > 0 && (
                    <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 space-y-2">
                      <p className="text-xs font-semibold text-violet-800 flex items-center gap-1">
                        <Tags className="w-3.5 h-3.5" /> A IA sugere criar {importNewCategoryPaths.length} categoria(s)/subcategoria(s) nova(s):
                      </p>
                      <ul className="text-xs text-violet-700 list-disc list-inside">
                        {importNewCategoryPaths.map((path, i) => <li key={i}>{path.join(" > ")}</li>)}
                      </ul>
                      <label className="flex items-center gap-2 text-xs font-medium text-violet-900" data-testid="checkbox-authorize-new-categories">
                        <input type="checkbox" checked={authorizeNewCategories} onChange={(e) => setAuthorizeNewCategories(e.target.checked)} />
                        Autorizo criar essas categorias agora
                      </label>
                      {!authorizeNewCategories && (
                        <p className="text-[10px] text-muted-foreground">Sem autorização, esses itens importam sem categoria — você pode escolher uma categoria já existente pra cada um abaixo, ou categorizar depois.</p>
                      )}
                    </div>
                  )}
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
                      <div key={idx} className={`rounded-lg border p-2.5 space-y-2 ${it.status === "pending" ? "border-amber-300 bg-amber-50/50" : "border-border"}`}>
                        <div className="flex items-center gap-2">
                          <input value={it.model} onChange={(e) => updateImportItem(idx, { model: e.target.value })} data-testid={`import-item-model-${idx}`}
                            className="flex-1 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Modelo" />
                          <select value={it.condition} onChange={(e) => updateImportItem(idx, { condition: e.target.value as CatalogCondition })}
                            data-testid={`import-item-condition-${idx}`}
                            className="rounded border px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary/40">
                            {CATALOG_CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          {it.variants.map((v, vIdx) => (
                            <div key={vIdx} className="flex items-center gap-2">
                              <input value={v.storage ?? ""} onChange={(e) => updateImportVariant(idx, vIdx, { storage: e.target.value || null })}
                                className="flex-1 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Armazenamento" />
                              <input value={v.color ?? ""} onChange={(e) => updateImportVariant(idx, vIdx, { color: e.target.value || null })}
                                className="flex-1 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Cor" />
                              <input type="number" value={v.costPrice ?? ""} onChange={(e) => updateImportVariant(idx, vIdx, { costPrice: e.target.value ? Number(e.target.value) : null })}
                                className="flex-1 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" placeholder="Custo R$" />
                              {it.variants.length > 1 && (
                                <button onClick={() => removeImportVariant(idx, vIdx)} className="p-1 rounded hover:bg-red-50 text-red-600"><X className="w-3 h-3" /></button>
                              )}
                            </div>
                          ))}
                          <button onClick={() => addImportVariant(idx)} className="text-[10px] font-semibold text-primary hover:underline flex items-center gap-1">
                            <Plus className="w-2.5 h-2.5" /> Adicionar variante
                          </button>
                        </div>
                        <div>
                          <select value={it.categoryId ?? ""} data-testid={`import-item-category-${idx}`}
                            onChange={(e) => updateImportItem(idx, { categoryId: e.target.value ? Number(e.target.value) : null, categoryPath: e.target.value ? null : it.categoryPath })}
                            className="w-full rounded border px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary/40">
                            <option value="">Sem categoria</option>
                            {categories.map((c) => <option key={c.id} value={c.id}>{categoryPathLabel(categories, c.id)}</option>)}
                          </select>
                          {it.categoryPath && (
                            <p className="text-[10px] text-violet-700 mt-0.5">Sugestão da IA (categoria nova): {it.categoryPath.join(" > ")}</p>
                          )}
                        </div>
                        {it.issue && <p className="text-[10px] text-amber-700">{it.issue}</p>}
                        {it.rawLine && <p className="text-[10px] text-muted-foreground truncate">"{it.rawLine}"</p>}
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
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1"><Lock className="w-3 h-3 text-amber-600" /> Margem de atacado padrão (%) — preço pra técnicos/lojistas com código de acesso</label>
                  <input type="number" value={settingsForm.wholesaleMarginPercent}
                    onChange={(e) => setSettingsForm({ ...settingsForm, wholesaleMarginPercent: Number(e.target.value) })} data-testid="input-wholesale-margin"
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/60 bg-amber-50/50" />
                  <p className="text-[10px] text-muted-foreground mt-1">Preço de atacado = custo ÷ (1 − margem de atacado%), sem taxa de cartão (venda combinada fora do cartão). Normalmente menor que a margem de varejo.</p>
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
              <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5 bg-muted/30">
                <input type="checkbox" id="round-prices-up" checked={settingsForm.roundPricesUp}
                  onChange={(e) => setSettingsForm({ ...settingsForm, roundPricesUp: e.target.checked })}
                  data-testid="checkbox-round-prices-up"
                  className="mt-0.5 w-4 h-4 rounded border-muted-foreground/40 text-primary focus:ring-2 focus:ring-primary/40" />
                <label htmlFor="round-prices-up" className="text-xs cursor-pointer">
                  <span className="font-semibold text-muted-foreground">Arredondar preços pra cima</span>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Sempre arredonda o preço calculado pro final ",90" mais próximo pra cima, em faixas de R$50. Ex.: R$2.102,02 → R$2.149,90; R$2.150,00 → R$2.199,90.</p>
                </label>
              </div>
              <button onClick={handleSaveSettings} disabled={savingSettings} data-testid="button-save-pricing-settings"
                className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {savingSettings ? "Salvando..." : "Salvar configurações"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: categorias/abas personalizáveis */}
      {showCategories && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3 py-6 overflow-y-auto" onClick={() => setShowCategories(false)}>
          <div className="bg-card rounded-xl w-full max-w-lg shadow-xl border overflow-hidden my-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><Tags className="w-4 h-4 text-primary" /> Categorias e subcategorias</span>
              <button onClick={() => setShowCategories(false)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
              <p className="text-xs text-muted-foreground">Crie abas pra organizar a vitrine, tipo "Celulares" (com subcategorias "Samsung", "Apple") e "Peças de celular". Aparecem como abas na vitrine pública.</p>

              <div className="space-y-2">
                {topCategories.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">Nenhuma categoria ainda.</p>}
                {topCategories.map((c) => (
                  <div key={c.id} className="rounded-lg border p-2.5 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && handleRenameCategory(c.id, e.target.value.trim())}
                        data-testid={`input-category-name-${c.id}`}
                        className="flex-1 rounded border px-2 py-1.5 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-primary/40" />
                      <button onClick={() => handleDeleteCategory(c)} data-testid={`button-delete-category-${c.id}`}
                        className="p-1.5 rounded hover:bg-red-50 text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                    <div className="pl-3 space-y-1.5">
                      {childCategories(c.id).map((sub) => (
                        <div key={sub.id} className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">↳</span>
                          <input defaultValue={sub.name} onBlur={(e) => e.target.value.trim() && e.target.value !== sub.name && handleRenameCategory(sub.id, e.target.value.trim())}
                            data-testid={`input-category-name-${sub.id}`}
                            className="flex-1 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" />
                          <button onClick={() => handleDeleteCategory(sub)} data-testid={`button-delete-category-${sub.id}`}
                            className="p-1 rounded hover:bg-red-50 text-red-600"><Trash2 className="w-3 h-3" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-dashed p-3 space-y-2 bg-secondary/30">
                <p className="text-xs font-semibold text-muted-foreground">Nova categoria</p>
                <div className="flex items-center gap-2">
                  <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddCategory()}
                    placeholder="Ex.: Celulares, Samsung, Peças de celular" data-testid="input-new-category-name"
                    className="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                </div>
                <select value={newCategoryParent} onChange={(e) => setNewCategoryParent(e.target.value ? Number(e.target.value) : "")}
                  data-testid="select-new-category-parent"
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40">
                  <option value="">Categoria principal (aba de topo)</option>
                  {topCategories.map((c) => <option key={c.id} value={c.id}>Subcategoria de "{c.name}"</option>)}
                </select>
                <button onClick={handleAddCategory} disabled={savingCategory || !newCategoryName.trim()} data-testid="button-add-category"
                  className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition flex items-center justify-center gap-2">
                  <Plus className="w-3.5 h-3.5" /> Adicionar categoria
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
