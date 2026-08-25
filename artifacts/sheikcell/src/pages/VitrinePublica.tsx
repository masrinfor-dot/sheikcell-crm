import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { api, CATALOG_CONDITIONS, CATALOG_CONDITION_CRITERIA, type CatalogPublicProduct } from "@/lib/api";
import { Smartphone, MessageCircle, PackageX, Info } from "lucide-react";

// Vitrine PÚBLICA (sem login) — link compartilhável /vitrine/:slug, mostrado
// pro cliente final. Nunca expõe custo/margem, só o preço de venda. Cada
// produto pode ter várias variantes de armazenamento — o cliente escolhe
// qual quer antes de falar no WhatsApp.
function formatBRL(v: string | null): string | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function conditionLabel(c: string): string {
  return CATALOG_CONDITIONS.find((x) => x.value === c)?.label ?? c;
}

function waLink(phone: string | null, text: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (!digits.startsWith("55")) digits = `55${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function ProductCard({ p, whatsapp, storeName }: { p: CatalogPublicProduct; whatsapp: string | null; storeName: string }) {
  const [selectedId, setSelectedId] = useState(p.variants[0]?.id ?? null);
  const [showCriteria, setShowCriteria] = useState(false);
  const selected = p.variants.find((v) => v.id === selectedId) ?? p.variants[0] ?? null;
  const price = formatBRL(selected?.salePrice ?? null);
  const inStock = selected?.inStock ?? false;
  const productWa = waLink(
    whatsapp,
    `Olá! Tenho interesse no ${p.model}${selected?.storage ? ` ${selected.storage}` : ""} que vi na vitrine da ${storeName} (${price ?? "sob consulta"}).`,
  );
  const criteria = CATALOG_CONDITION_CRITERIA[p.condition]?.criteria ?? [];

  return (
    <div className="bg-white rounded-2xl border border-neutral-200 overflow-hidden flex flex-col">
      <div className="aspect-square bg-neutral-100 flex items-center justify-center overflow-hidden">
        {p.photos[0] ? (
          <img src={api.catalog.photoUrl(p.photos[0])} alt={p.model} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <Smartphone className="w-10 h-10 text-neutral-300" />
        )}
      </div>
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
        <p className="text-sm font-semibold text-neutral-900 leading-tight">{p.model}</p>
        {p.colors.length > 0 && <p className="text-[11px] text-neutral-400">{p.colors.join(" · ")}</p>}

        {p.variants.length > 1 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {p.variants.map((v) => (
              <button key={v.id} type="button" onClick={() => setSelectedId(v.id)}
                className={`px-2 py-1 rounded-lg text-[11px] font-semibold border transition ${
                  v.id === selectedId ? "bg-neutral-900 text-white border-neutral-900" : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400"
                } ${!v.inStock ? "opacity-50" : ""}`}>
                {v.storage ?? "Único"}
              </button>
            ))}
          </div>
        )}
        {p.variants.length === 1 && p.variants[0].storage && <p className="text-xs text-neutral-500">{p.variants[0].storage}</p>}

        <div className="mt-auto pt-1">
          <p className="text-base font-bold text-neutral-900">{price ?? "Sob consulta"}</p>
          {productWa && (
            <a href={productWa} target="_blank" rel="noreferrer"
              className="mt-2 inline-flex items-center justify-center gap-1.5 w-full py-2 rounded-xl bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 transition">
              <MessageCircle className="w-3.5 h-3.5" /> Falar no WhatsApp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VitrinePublica() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<{ storeName: string; whatsapp: string | null; products: CatalogPublicProduct[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) { setError("Link inválido"); return; }
    api.catalog.public(slug)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Vitrine não encontrada"));
  }, [slug]);

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

  const generalWa = waLink(data.whatsapp, `Olá! Vi a vitrine da ${data.storeName} e quero saber mais sobre os aparelhos disponíveis.`);

  return (
    <div className="min-h-screen bg-neutral-50">
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
          {generalWa && (
            <a href={generalWa} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 transition shrink-0">
              <MessageCircle className="w-4 h-4" /> Falar no WhatsApp
            </a>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {data.products.length === 0 ? (
          <div className="text-center py-24 text-neutral-400">
            <Smartphone className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Nenhum aparelho disponível no momento.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {data.products.map((p) => (
              <ProductCard key={p.id} p={p} whatsapp={data.whatsapp} storeName={data.storeName} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
