import { useState, useEffect, useMemo } from "react";
import { useParams } from "wouter";
import { api, CATALOG_CONDITIONS, CATALOG_CONDITION_CRITERIA, type CatalogPublicProduct, type CatalogCategory } from "@/lib/api";
import { Smartphone, MessageCircle, PackageX, Info, Lock, ShoppingCart, Plus, Minus, X, Unlock, Search } from "lucide-react";

// Vitrine PÚBLICA (sem login) — link compartilhável /vitrine/:slug, mostrado
// pro cliente final. Nunca expõe custo/margem, só o preço de venda (e o de
// atacado, pra quem desbloqueou com o código). Cada produto pode ter várias
// variantes de armazenamento e pode estar organizado numa categoria/aba.

type PublicData = {
  storeName: string; whatsapp: string | null; whatsappWholesale: string | null; hasWholesale: boolean; wholesaleUnlocked: boolean;
  categories: CatalogCategory[]; products: CatalogPublicProduct[];
};

// Rótulo de uma variante combinando armazenamento e cor, o que tiver
// preenchido (ex.: "256GB · Preto", "Preto" se não variar armazenamento,
// "256GB" se não variar cor, "Único" se nenhum dos dois for informado).
function variantLabel(v: { storage: string | null; color: string | null }): string {
  return [v.storage, v.color].filter(Boolean).join(" · ") || "Único";
}

// Mesma combinação, mas sem o fallback "Único" — pra linhas do carrinho e da
// mensagem do WhatsApp, onde é melhor não mostrar nada a mostrar um rótulo
// vazio de placeholder.
function cartVariantLabel(v: { storage: string | null; color: string | null }): string | null {
  return [v.storage, v.color].filter(Boolean).join(" · ") || null;
}

type CartItem = {
  productId: number; variantId: number; model: string; storage: string | null;
  qty: number; unitPrice: number | null; wholesale: boolean;
};

function formatBRL(v: number | string | null): string | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function conditionLabel(c: string): string {
  return CATALOG_CONDITIONS.find((x) => x.value === c)?.label ?? c;
}

// Valor de cada parcela pagando em até 12x no cartão, já formatado (ou null
// se o backend não conseguiu calcular — aparelho sem custo cadastrado).
function installment12Label(v: { installment12Value?: number | null } | null | undefined): string | null {
  const value = formatBRL(v?.installment12Value ?? null);
  return value ? `ou 12x de ${value} no cartão` : null;
}

function waLink(phone: string | null, text: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (!digits.startsWith("55")) digits = `55${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function wholesaleStorageKey(slug: string) {
  return `sheikcell-vitrine-atacado-${slug}`;
}

function ProductCard({
  p, wholesaleUnlocked, onAddToCart, onOpenDetail,
}: {
  p: CatalogPublicProduct; wholesaleUnlocked: boolean;
  onAddToCart: (item: { productId: number; variantId: number; model: string; storage: string | null; unitPrice: number | null; wholesale: boolean }) => void;
  onOpenDetail: (p: CatalogPublicProduct) => void;
}) {
  const [selectedId, setSelectedId] = useState(p.variants[0]?.id ?? null);
  const [showCriteria, setShowCriteria] = useState(false);
  const selected = p.variants.find((v) => v.id === selectedId) ?? p.variants[0] ?? null;
  // À vista (Pix/dinheiro, sem taxa de cartão) é o preço principal mostrado;
  // cai pro salePrice antigo se o backend não mandar priceCash (compatibilidade).
  const retailPrice = formatBRL(selected?.priceCash ?? selected?.salePrice ?? null);
  const installmentLabel = installment12Label(selected);
  const wholesalePrice = wholesaleUnlocked ? formatBRL(selected?.wholesalePrice ?? null) : null;
  const inStock = selected?.inStock ?? false;
  const criteria = CATALOG_CONDITION_CRITERIA[p.condition]?.criteria ?? [];

  return (
    <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden flex flex-col">
      <button type="button" onClick={() => onOpenDetail(p)} data-testid={`button-open-detail-${p.id}`}
        className="aspect-square bg-neutral-100 flex items-center justify-center overflow-hidden">
        {p.photos[0] ? (
          <img src={api.catalog.photoUrl(p.photos[0])} alt={p.model} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <Smartphone className="w-10 h-10 text-neutral-300" />
        )}
      </button>
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" onClick={() => setShowCriteria((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition">
            {conditionLabel(p.condition)} <Info className="w-2.5 h-2.5" />
          </button>
          {!inStock && (
            <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-100 text-red-600">Esgotado</span>
          )}
        </div>
        {showCriteria && (
          <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-2 space-y-0.5">
            {criteria.map((c) => (
              <p key={c.label} className="text-[10px] text-neutral-500"><b className="text-neutral-700">{c.label}:</b> {c.text}</p>
            ))}
          </div>
        )}
        <button type="button" onClick={() => onOpenDetail(p)} className="text-left">
          <p className="text-sm font-semibold text-neutral-900 leading-tight hover:underline">{p.model}</p>
        </button>
        {p.colors.length > 0 && <p className="text-[11px] text-neutral-400">{p.colors.join(" · ")}</p>}

        {p.variants.length > 1 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {p.variants.map((v) => (
              <button key={v.id} type="button" onClick={() => setSelectedId(v.id)}
                className={`px-2 py-1 rounded-lg text-[11px] font-semibold border transition ${
                  v.id === selectedId ? "bg-neutral-900 text-white border-neutral-900" : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400"
                } ${!v.inStock ? "opacity-50" : ""}`}>
                {variantLabel(v)}
              </button>
            ))}
          </div>
        )}
        {p.variants.length === 1 && (p.variants[0].storage || p.variants[0].color) && (
          <p className="text-xs text-neutral-500">{variantLabel(p.variants[0])}</p>
        )}

        <div className="mt-auto pt-1">
          <p className="text-base font-bold text-neutral-900">{retailPrice ?? "Sob consulta"}</p>
          {retailPrice && <p className="text-[10px] text-neutral-400">à vista (Pix)</p>}
          {installmentLabel && <p className="text-[11px] text-neutral-500">{installmentLabel}</p>}
          {wholesalePrice && (
            <p className="text-xs font-bold text-amber-700 flex items-center gap-1"><Lock className="w-3 h-3" /> Atacado: {wholesalePrice}</p>
          )}
          <button type="button" disabled={!inStock || !selected}
            onClick={() => selected && onAddToCart({
              productId: p.id, variantId: selected.id, model: p.model, storage: cartVariantLabel(selected),
              unitPrice: wholesaleUnlocked && selected.wholesalePrice != null ? Number(selected.wholesalePrice) : (selected.salePrice != null ? Number(selected.salePrice) : null),
              wholesale: wholesaleUnlocked && selected.wholesalePrice != null,
            })}
            className="mt-2 inline-flex items-center justify-center gap-1.5 w-full py-2 rounded-xl bg-neutral-900 text-white text-xs font-semibold hover:bg-neutral-800 transition disabled:opacity-40">
            <ShoppingCart className="w-3.5 h-3.5" /> Adicionar ao pedido
          </button>
        </div>
      </div>
    </div>
  );
}

// Modal de detalhe do produto — abre ao clicar na foto ou no nome do card.
// Mostra a foto em tamanho maior, descrição e critério de qualidade, e o
// seletor de variação em 2 etapas quando o aparelho tem cor E armazenamento
// variando (primeiro escolhe a cor, depois só os armazenamentos daquela
// cor aparecem pra escolher).
function ProductDetailModal({
  p, wholesaleUnlocked, onAddToCart, onClose,
}: {
  p: CatalogPublicProduct; wholesaleUnlocked: boolean;
  onAddToCart: (item: { productId: number; variantId: number; model: string; storage: string | null; unitPrice: number | null; wholesale: boolean }) => void;
  onClose: () => void;
}) {
  const [activePhoto, setActivePhoto] = useState(0);
  const [showCriteria, setShowCriteria] = useState(false);
  const colors = useMemo(() => [...new Set(p.variants.map((v) => v.color).filter((c): c is string => !!c))], [p]);
  const [selectedColor, setSelectedColor] = useState<string | null>(colors[0] ?? null);
  const variantsForColor = useMemo(
    () => p.variants.filter((v) => selectedColor == null || v.color === selectedColor),
    [p, selectedColor],
  );
  const [selectedId, setSelectedId] = useState(variantsForColor[0]?.id ?? p.variants[0]?.id ?? null);

  const handleSelectColor = (c: string) => {
    setSelectedColor(c);
    const match = p.variants.find((v) => v.color === c);
    if (match) setSelectedId(match.id);
  };

  const selected = p.variants.find((v) => v.id === selectedId) ?? p.variants[0] ?? null;
  const retailPrice = formatBRL(selected?.priceCash ?? selected?.salePrice ?? null);
  const installmentLabel = installment12Label(selected);
  const wholesalePrice = wholesaleUnlocked ? formatBRL(selected?.wholesalePrice ?? null) : null;
  const inStock = selected?.inStock ?? false;
  const criteria = CATALOG_CONDITION_CRITERIA[p.condition]?.criteria ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 px-3 py-6" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl border overflow-hidden my-auto max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <span className="font-semibold text-sm text-neutral-900 truncate pr-2">{p.model}</span>
          <button onClick={onClose} data-testid="button-close-detail" className="p-1 rounded hover:bg-neutral-100 shrink-0"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          <div className="aspect-square bg-neutral-100 rounded-xl overflow-hidden flex items-center justify-center">
            {p.photos.length > 0 ? (
              <img src={api.catalog.photoUrl(p.photos[activePhoto] ?? p.photos[0])} alt={p.model} className="w-full h-full object-cover" />
            ) : (
              <Smartphone className="w-16 h-16 text-neutral-300" />
            )}
          </div>
          {p.photos.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto">
              {p.photos.map((ph, i) => (
                <button key={ph} type="button" onClick={() => setActivePhoto(i)}
                  className={`w-12 h-12 rounded-lg overflow-hidden border-2 shrink-0 ${i === activePhoto ? "border-neutral-900" : "border-transparent"}`}>
                  <img src={api.catalog.photoUrl(ph)} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 flex-wrap">
            <button type="button" onClick={() => setShowCriteria((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition">
              {conditionLabel(p.condition)} <Info className="w-2.5 h-2.5" />
            </button>
            {!inStock && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-100 text-red-600">Esgotado</span>}
          </div>
          {showCriteria && (
            <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-2 space-y-0.5">
              {criteria.map((c) => (
                <p key={c.label} className="text-[10px] text-neutral-500"><b className="text-neutral-700">{c.label}:</b> {c.text}</p>
              ))}
            </div>
          )}
          {p.description && <p className="text-xs text-neutral-500">{p.description}</p>}

          {colors.length > 1 && (
            <div>
              <p className="text-[11px] font-semibold text-neutral-500 mb-1">Cor</p>
              <div className="flex flex-wrap gap-1.5">
                {colors.map((c) => (
                  <button key={c} type="button" onClick={() => handleSelectColor(c)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
                      c === selectedColor ? "bg-neutral-900 text-white border-neutral-900" : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400"
                    }`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          {variantsForColor.length > 1 && (
            <div>
              <p className="text-[11px] font-semibold text-neutral-500 mb-1">Armazenamento</p>
              <div className="flex flex-wrap gap-1.5">
                {variantsForColor.map((v) => (
                  <button key={v.id} type="button" onClick={() => setSelectedId(v.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
                      v.id === selectedId ? "bg-neutral-900 text-white border-neutral-900" : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400"
                    } ${!v.inStock ? "opacity-50" : ""}`}>
                    {v.storage ?? "Único"}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="pt-1">
            <p className="text-xl font-bold text-neutral-900">{retailPrice ?? "Sob consulta"}</p>
            {retailPrice && <p className="text-xs text-neutral-400">à vista (Pix)</p>}
            {installmentLabel && <p className="text-sm text-neutral-500">{installmentLabel}</p>}
            {wholesalePrice && (
              <p className="text-sm font-bold text-amber-700 flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Atacado: {wholesalePrice}</p>
            )}
            <button type="button" disabled={!inStock || !selected}
              onClick={() => selected && onAddToCart({
                productId: p.id, variantId: selected.id, model: p.model, storage: cartVariantLabel(selected),
                unitPrice: wholesaleUnlocked && selected.wholesalePrice != null ? Number(selected.wholesalePrice) : (selected.salePrice != null ? Number(selected.salePrice) : null),
                wholesale: wholesaleUnlocked && selected.wholesalePrice != null,
              })}
              data-testid="button-add-to-cart-detail"
              className="mt-2 inline-flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl bg-neutral-900 text-white text-sm font-semibold hover:bg-neutral-800 transition disabled:opacity-40">
              <ShoppingCart className="w-4 h-4" /> Adicionar ao pedido
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VitrinePublica() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedTop, setSelectedTop] = useState<number | "all">("all");
  const [selectedSub, setSelectedSub] = useState<number | "all">("all");

  // Busca/filtro dinâmico — tudo em cima da lista já carregada, sem precisar
  // ir de novo no servidor (a vitrine já tem todo o catálogo em mãos).
  const [searchQuery, setSearchQuery] = useState("");
  const [conditionFilter, setConditionFilter] = useState<string | "all">("all");
  const [storageFilter, setStorageFilter] = useState<string | "all">("all");
  const [colorFilter, setColorFilter] = useState<string | "all">("all");

  const [showUnlock, setShowUnlock] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [detailProduct, setDetailProduct] = useState<CatalogPublicProduct | null>(null);

  const loadData = (code?: string) => {
    if (!slug) { setError("Link inválido"); return; }
    api.catalog.public(slug, code)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Vitrine não encontrada"));
  };

  useEffect(() => {
    if (!slug) { setError("Link inválido"); return; }
    let savedCode: string | null = null;
    try { savedCode = localStorage.getItem(wholesaleStorageKey(slug)); } catch { /* privado/bloqueado — segue sem código salvo */ }
    loadData(savedCode ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const handleUnlock = async () => {
    if (!slug || !codeInput.trim() || unlocking) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const r = await api.catalog.public(slug, codeInput.trim());
      setData(r);
      if (r.wholesaleUnlocked) {
        try { localStorage.setItem(wholesaleStorageKey(slug), codeInput.trim()); } catch { /* segue sem persistir */ }
        setShowUnlock(false);
        setCodeInput("");
      } else {
        setUnlockError("Código inválido.");
      }
    } catch {
      setUnlockError("Não foi possível verificar o código agora.");
    } finally {
      setUnlocking(false);
    }
  };

  const addToCart = (item: { productId: number; variantId: number; model: string; storage: string | null; unitPrice: number | null; wholesale: boolean }) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.variantId === item.variantId);
      if (existing) return prev.map((c) => (c.variantId === item.variantId ? { ...c, qty: c.qty + 1 } : c));
      return [...prev, { ...item, qty: 1 }];
    });
    setShowCart(true);
  };

  const updateQty = (variantId: number, delta: number) => {
    setCart((prev) => prev
      .map((c) => (c.variantId === variantId ? { ...c, qty: c.qty + delta } : c))
      .filter((c) => c.qty > 0));
  };

  const removeFromCart = (variantId: number) => setCart((prev) => prev.filter((c) => c.variantId !== variantId));

  const cartTotal = cart.reduce((sum, c) => sum + (c.unitPrice ?? 0) * c.qty, 0);
  const cartCount = cart.reduce((sum, c) => sum + c.qty, 0);

  const checkoutMessage = useMemo(() => {
    if (cart.length === 0 || !data) return "";
    const lines = cart.map((c) =>
      `${c.qty}x ${c.model}${c.storage ? ` ${c.storage}` : ""} — ${formatBRL(c.unitPrice) ?? "sob consulta"}${c.wholesale ? " (atacado)" : ""}`
    );
    return [
      `Olá! Vi a vitrine da ${data.storeName} e quero fazer o seguinte pedido:`,
      "",
      ...lines,
      "",
      `Total: ${formatBRL(cartTotal)}`,
    ].join("\n");
  }, [cart, data, cartTotal]);

  // Enquanto o atacado não foi desbloqueado, sempre usa o WhatsApp de
  // varejo — o de atacado nem chega do backend nesse caso (ver rota
  // /catalog-public no backend).
  const effectiveWhatsapp = data?.wholesaleUnlocked ? (data?.whatsappWholesale ?? data?.whatsapp ?? null) : (data?.whatsapp ?? null);
  const checkoutWa = data ? waLink(effectiveWhatsapp, checkoutMessage) : null;

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 px-4">
        <div className="text-center text-neutral-500">
          <PackageX className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="w-8 h-8 rounded-full border-4 border-neutral-300 border-t-neutral-600 animate-spin" />
      </div>
    );
  }

  const generalWa = waLink(effectiveWhatsapp, `Olá! Vi a vitrine da ${data.storeName} e quero saber mais sobre os aparelhos disponíveis.`);
  const topCategories = data.categories.filter((c) => c.parentId == null);
  const subCategories = selectedTop === "all" ? [] : data.categories.filter((c) => c.parentId === selectedTop);

  const categoryFilteredProducts = data.products.filter((p) => {
    if (selectedTop === "all") return true;
    if (selectedSub !== "all") return p.categoryId === selectedSub;
    const childIds = subCategories.map((c) => c.id);
    return p.categoryId === selectedTop || (p.categoryId != null && childIds.includes(p.categoryId));
  });

  // Opções de armazenamento/cor disponíveis pra filtrar, calculadas em cima
  // do que sobrou depois do filtro de categoria — assim os filtros nunca
  // mostram uma opção que não existe mais na aba selecionada.
  const availableStorages = [...new Set(categoryFilteredProducts.flatMap((p) => p.variants.map((v) => v.storage).filter((s): s is string => !!s)))].sort();
  const availableColors = [...new Set(categoryFilteredProducts.flatMap((p) => p.variants.map((v) => v.color).filter((c): c is string => !!c)))].sort();

  const searchNorm = searchQuery.trim().toLowerCase();
  const filteredProducts = categoryFilteredProducts.filter((p) => {
    if (conditionFilter !== "all" && p.condition !== conditionFilter) return false;
    if (storageFilter !== "all" && !p.variants.some((v) => v.storage === storageFilter)) return false;
    if (colorFilter !== "all" && !p.variants.some((v) => v.color === colorFilter)) return false;
    if (!searchNorm) return true;
    return p.model.toLowerCase().includes(searchNorm)
      || p.colors.some((c) => c.toLowerCase().includes(searchNorm))
      || p.variants.some((v) => (v.storage ?? "").toLowerCase().includes(searchNorm) || (v.color ?? "").toLowerCase().includes(searchNorm));
  });

  return (
    <div className="min-h-screen bg-neutral-50 pb-20">
      <header className="sticky top-0 z-10 bg-white border-b border-neutral-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-neutral-900 text-white flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-bold text-neutral-900 leading-tight">{data.storeName}</h1>
              <p className="text-xs text-neutral-500">Vitrine de aparelhos</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data.hasWholesale && (
              <button type="button" onClick={() => setShowUnlock((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition shrink-0 ${
                  data.wholesaleUnlocked ? "bg-amber-100 text-amber-700" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}>
                {data.wholesaleUnlocked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                {data.wholesaleUnlocked ? "Atacado desbloqueado" : "Sou técnico/lojista"}
              </button>
            )}
            {generalWa && (
              <a href={generalWa} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 transition shrink-0">
                <MessageCircle className="w-4 h-4" /> WhatsApp
              </a>
            )}
          </div>
        </div>
        {showUnlock && !data.wholesaleUnlocked && (
          <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-3">
            <div className="max-w-5xl mx-auto flex items-center gap-2">
              <input value={codeInput} onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                placeholder="Código de acesso ao atacado" data-testid="input-wholesale-unlock-code"
                className="flex-1 max-w-xs rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400" />
              <button onClick={handleUnlock} disabled={unlocking} data-testid="button-wholesale-unlock"
                className="px-3 py-1.5 rounded-lg bg-neutral-900 text-white text-xs font-semibold disabled:opacity-50">
                {unlocking ? "Verificando..." : "Desbloquear"}
              </button>
              {unlockError && <p className="text-xs text-red-600">{unlockError}</p>}
            </div>
          </div>
        )}
        {topCategories.length > 0 && (
          <div className="border-t border-neutral-100 overflow-x-auto">
            <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-1.5">
              <button onClick={() => { setSelectedTop("all"); setSelectedSub("all"); }}
                className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition ${selectedTop === "all" ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
                Todos
              </button>
              {topCategories.map((c) => (
                <button key={c.id} onClick={() => { setSelectedTop(c.id); setSelectedSub("all"); }}
                  className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition ${selectedTop === c.id ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>
                  {c.name}
                </button>
              ))}
            </div>
            {subCategories.length > 0 && (
              <div className="max-w-5xl mx-auto px-4 pb-2 flex items-center gap-1.5 overflow-x-auto">
                <button onClick={() => setSelectedSub("all")}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap transition border ${selectedSub === "all" ? "bg-neutral-700 text-white border-neutral-700" : "bg-white text-neutral-500 border-neutral-200"}`}>
                  Todas
                </button>
                {subCategories.map((c) => (
                  <button key={c.id} onClick={() => setSelectedSub(c.id)}
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap transition border ${selectedSub === c.id ? "bg-neutral-700 text-white border-neutral-700" : "bg-white text-neutral-500 border-neutral-200"}`}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="max-w-5xl mx-auto px-4 pt-4 space-y-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por modelo, armazenamento ou cor..." data-testid="input-vitrine-search"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-neutral-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setConditionFilter("all")}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition ${conditionFilter === "all" ? "bg-neutral-900 text-white" : "bg-white border border-neutral-200 text-neutral-500"}`}>
            Todas as condições
          </button>
          {CATALOG_CONDITIONS.map((c) => (
            <button key={c.value} onClick={() => setConditionFilter(c.value)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition ${conditionFilter === c.value ? "bg-neutral-900 text-white" : "bg-white border border-neutral-200 text-neutral-500"}`}>
              {c.label}
            </button>
          ))}
          {availableStorages.length > 1 && (
            <select value={storageFilter === "all" ? "" : storageFilter} onChange={(e) => setStorageFilter(e.target.value || "all")}
              data-testid="select-filter-storage"
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white border border-neutral-200 text-neutral-500 focus:outline-none">
              <option value="">Todo armazenamento</option>
              {availableStorages.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {availableColors.length > 1 && (
            <select value={colorFilter === "all" ? "" : colorFilter} onChange={(e) => setColorFilter(e.target.value || "all")}
              data-testid="select-filter-color"
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white border border-neutral-200 text-neutral-500 focus:outline-none">
              <option value="">Toda cor</option>
              {availableColors.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {filteredProducts.length === 0 ? (
          <div className="text-center py-24 text-neutral-400">
            <Smartphone className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Nenhum aparelho encontrado com esses filtros.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {filteredProducts.map((p) => (
              <ProductCard key={p.id} p={p} wholesaleUnlocked={data.wholesaleUnlocked} onAddToCart={addToCart} onOpenDetail={setDetailProduct} />
            ))}
          </div>
        )}
      </main>

      {cartCount > 0 && !showCart && (
        <button onClick={() => setShowCart(true)} data-testid="button-open-cart"
          className="fixed bottom-4 right-4 z-20 flex items-center gap-2 px-4 py-3 rounded-full bg-neutral-900 text-white shadow-lg hover:bg-neutral-800 transition">
          <ShoppingCart className="w-4 h-4" />
          <span className="text-sm font-semibold">{cartCount} {cartCount === 1 ? "item" : "itens"} · {formatBRL(cartTotal)}</span>
        </button>
      )}

      {showCart && (
        <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 px-3 py-6" onClick={() => setShowCart(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Seu pedido</span>
              <button onClick={() => setShowCart(false)} className="p-1 rounded hover:bg-neutral-100"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
              {cart.length === 0 ? (
                <p className="text-sm text-neutral-400 text-center py-6">Seu pedido está vazio.</p>
              ) : (
                cart.map((c) => (
                  <div key={c.variantId} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-neutral-900 truncate">{c.model}{c.storage ? ` ${c.storage}` : ""}</p>
                      <p className="text-xs text-neutral-500">{formatBRL(c.unitPrice) ?? "sob consulta"}{c.wholesale ? " · atacado" : ""}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => updateQty(c.variantId, -1)} className="p-1 rounded border hover:bg-neutral-50"><Minus className="w-3 h-3" /></button>
                      <span className="text-sm font-semibold w-5 text-center">{c.qty}</span>
                      <button onClick={() => updateQty(c.variantId, 1)} className="p-1 rounded border hover:bg-neutral-50"><Plus className="w-3 h-3" /></button>
                      <button onClick={() => removeFromCart(c.variantId)} className="p-1 rounded hover:bg-red-50 text-red-600 ml-1"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))
              )}
            </div>
            {cart.length > 0 && (
              <div className="p-4 border-t space-y-2">
                <div className="flex items-center justify-between text-sm font-bold text-neutral-900">
                  <span>Total</span>
                  <span>{formatBRL(cartTotal)}</span>
                </div>
                {checkoutWa ? (
                  <a href={checkoutWa} target="_blank" rel="noreferrer" data-testid="button-checkout-whatsapp"
                    className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 transition">
                    <MessageCircle className="w-4 h-4" /> Finalizar pedido no WhatsApp
                  </a>
                ) : (
                  <p className="text-xs text-center text-neutral-400">WhatsApp da loja não configurado.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {detailProduct && (
        <ProductDetailModal
          key={detailProduct.id}
          p={detailProduct}
          wholesaleUnlocked={data.wholesaleUnlocked}
          onAddToCart={(item) => { addToCart(item); setDetailProduct(null); }}
          onClose={() => setDetailProduct(null)}
        />
      )}
    </div>
  );
}
