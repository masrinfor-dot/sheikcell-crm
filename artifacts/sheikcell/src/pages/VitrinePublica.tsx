import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { api, CATALOG_CONDITIONS, type CatalogPublicProduct } from "@/lib/api";
import { Smartphone, MessageCircle, PackageX } from "lucide-react";

// Vitrine PÚBLICA (sem login) — link compartilhável /vitrine/:slug, mostrado
// pro cliente final. Nunca expõe custo/margem, só o preço de venda.
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
            {data.products.map((p) => {
              const price = formatBRL(p.salePrice);
              const productWa = waLink(data.whatsapp, `Olá! Tenho interesse no ${p.model}${p.storage ? ` ${p.storage}` : ""} que vi na vitrine (${price ?? "sob consulta"}).`);
              return (
                <div key={p.id} className="bg-white rounded-2xl border border-neutral-200 overflow-hidden flex flex-col">
                  <div className="aspect-square bg-neutral-100 flex items-center justify-center overflow-hidden">
                    {p.photos[0] ? (
                      <img src={api.catalog.photoUrl(p.photos[0])} alt={p.model} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <Smartphone className="w-10 h-10 text-neutral-300" />
                    )}
                  </div>
                  <div className="p-3 flex flex-col gap-1.5 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600">
                        {conditionLabel(p.condition)}
                      </span>
                      {!p.inStock && (
                        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-100 text-red-600">Esgotado</span>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-neutral-900 leading-tight">{p.model}</p>
                    {p.storage && <p className="text-xs text-neutral-500">{p.storage}</p>}
                    {p.colors.length > 0 && <p className="text-[11px] text-neutral-400">{p.colors.join(" · ")}</p>}
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
            })}
          </div>
        )}
      </main>
    </div>
  );
}
