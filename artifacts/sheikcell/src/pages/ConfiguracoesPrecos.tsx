import { useState, useEffect } from "react";
import { api, type CatalogPricingSettings, type CatalogCategory } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Tags, Lock, Wallet, Loader2 } from "lucide-react";

// Página "Configurações → Tabela de Preço" — pedido do lojista (09/09): a
// mesma configuração de precificação da Vitrine (margem, taxa de cartão por
// parcela, margem por categoria, arredondamento) que já existia só dentro do
// botão "Preço e cartão" da tela Vitrine Aparelhos, agora TAMBÉM aparece aqui
// nas Configurações gerais — mais fácil de achar, sem precisar entrar na
// tela de produtos. Os dois lugares batem no mesmo endpoint
// (GET/PUT /catalog/pricing-settings), então salvar aqui ou lá dá o mesmo
// resultado — nenhum dos dois foi removido.
const INSTALLMENT_OPTIONS = [1, 2, 3, 4, 6, 10, 12, 18];

export default function ConfiguracoesPrecos() {
  const { toast } = useToast();
  const [settingsForm, setSettingsForm] = useState<CatalogPricingSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);

  // Margem de avaliação de usados na Vitrine pública (cliente avalia o
  // próprio aparelho sozinho, sem vendedor) — mesma "Tabela 2 (média)" da
  // tela de Avaliação de Usados (ver /trade-in/margins). Mostrada aqui junto
  // do resto da precificação, igual já era feito no modal da Vitrine
  // Aparelhos. null = módulo de Avaliação de Usados não habilitado nesta
  // loja, ou ainda não carregou — nesse caso a seção some sozinha.
  const [tradeInMarginPct, setTradeInMarginPct] = useState<number | null>(null);
  const [savingTradeInMargin, setSavingTradeInMargin] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      api.catalog.pricingSettings(),
      api.catalog.categories(),
      api.tradeIn.margins().catch(() => null),
    ]).then(([settingsRes, catsRes, tradeInRes]) => {
      if (settingsRes.status === "fulfilled") setSettingsForm(settingsRes.value);
      if (catsRes.status === "fulfilled") setCategories(catsRes.value.categories);
      if (tradeInRes.status === "fulfilled" && tradeInRes.value) setTradeInMarginPct(tradeInRes.value.t2);
    }).finally(() => setLoading(false));
  }, []);

  const topCategories = categories.filter((c) => c.parentId == null);
  const childCategories = (parentId: number) => categories.filter((c) => c.parentId === parentId);

  const handleSave = async () => {
    if (!settingsForm || saving) return;
    setSaving(true);
    try {
      const saved = await api.catalog.savePricingSettings(settingsForm);
      setSettingsForm(saved);
      toast({ title: "Configurações de preço salvas" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTradeInMargin = async () => {
    if (tradeInMarginPct == null) return;
    const v = Math.round(tradeInMarginPct);
    if (!Number.isFinite(v) || v < 1 || v > 90) {
      toast({ title: "Margem inválida", description: "Use entre 1% e 90%.", variant: "destructive" });
      return;
    }
    setSavingTradeInMargin(true);
    try {
      const saved = await api.tradeIn.saveMargins({ t2: v });
      setTradeInMarginPct(saved.t2);
      toast({ title: "Margem de avaliação de usados atualizada!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingTradeInMargin(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-2xl flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  if (!settingsForm) {
    return <p className="text-sm text-muted-foreground">Não foi possível carregar as configurações de preço.</p>;
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="font-bold text-foreground flex items-center gap-2"><Tags className="w-5 h-5" /> Tabela de Preço</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Formação automática do preço de venda da Vitrine a partir do custo do aparelho: <b>preço = (custo + nota fiscal) ÷ (1 − margem% − taxa do cartão%)</b>.
        </p>
      </div>

      <div className="shk-card p-5 space-y-4">
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

        {tradeInMarginPct != null && (
          <div className="rounded-lg border px-3 py-2.5 bg-muted/20">
            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
              <Wallet className="w-3 h-3" /> Margem de avaliação de usados (Vitrine pública)
            </label>
            <p className="text-[10px] text-muted-foreground mt-0.5 mb-1.5">
              Margem usada quando o próprio cliente avalia o usado dele sozinho na Vitrine, sem vendedor
              (mesma "Tabela 2 — média" da tela de Avaliação de Usados; editar aqui já atualiza lá também).
            </p>
            <div className="flex items-center gap-2">
              <input type="number" min={1} max={90} value={tradeInMarginPct}
                onChange={(e) => setTradeInMarginPct(Number(e.target.value))}
                data-testid="input-tradein-vitrine-margin"
                className="w-24 rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              <span className="text-sm font-semibold text-muted-foreground">%</span>
              <button onClick={handleSaveTradeInMargin} disabled={savingTradeInMargin} data-testid="button-save-tradein-vitrine-margin"
                className="ml-auto px-3 py-2 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
                {savingTradeInMargin ? "Salvando..." : "Salvar margem de usados"}
              </button>
            </div>
          </div>
        )}

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

        <div>
          <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1"><Tags className="w-3 h-3" /> Margem de venda por categoria (%)</label>
          <p className="text-[10px] text-muted-foreground mt-0.5 mb-1.5">A margem varia por tipo de produto — em branco usa a margem padrão da loja ({settingsForm.defaultMarginPercent}%) pra essa categoria. Vale pra anúncios novos e pra importação; a margem digitada à mão num aparelho específico sempre tem prioridade sobre a da categoria.</p>
          {categories.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-2">Nenhuma categoria cadastrada ainda.</p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto rounded-lg border p-2">
              {topCategories.map((c) => (
                <div key={c.id} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-xs font-medium truncate">{c.name}</span>
                    <input type="number" value={settingsForm.categoryMarginOverrides[String(c.id)] ?? ""}
                      onChange={(e) => setSettingsForm({
                        ...settingsForm,
                        categoryMarginOverrides: e.target.value
                          ? { ...settingsForm.categoryMarginOverrides, [String(c.id)]: Number(e.target.value) }
                          : Object.fromEntries(Object.entries(settingsForm.categoryMarginOverrides).filter(([k]) => k !== String(c.id))),
                      })}
                      data-testid={`input-category-margin-${c.id}`}
                      placeholder={`${settingsForm.defaultMarginPercent}%`}
                      className="w-20 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" />
                  </div>
                  {childCategories(c.id).map((sub) => (
                    <div key={sub.id} className="flex items-center gap-2 pl-3">
                      <span className="text-muted-foreground text-xs">↳</span>
                      <span className="flex-1 text-xs truncate">{sub.name}</span>
                      <input type="number" value={settingsForm.categoryMarginOverrides[String(sub.id)] ?? ""}
                        onChange={(e) => setSettingsForm({
                          ...settingsForm,
                          categoryMarginOverrides: e.target.value
                            ? { ...settingsForm.categoryMarginOverrides, [String(sub.id)]: Number(e.target.value) }
                            : Object.fromEntries(Object.entries(settingsForm.categoryMarginOverrides).filter(([k]) => k !== String(sub.id))),
                        })}
                        data-testid={`input-category-margin-${sub.id}`}
                        placeholder={`${settingsForm.defaultMarginPercent}%`}
                        className="w-20 rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
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

        <button onClick={handleSave} disabled={saving} data-testid="button-save-pricing-settings"
          className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
          {saving ? "Salvando..." : "Salvar configurações"}
        </button>
      </div>
    </div>
  );
}
