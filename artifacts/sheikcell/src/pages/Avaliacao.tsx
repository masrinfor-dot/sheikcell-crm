import { useState, useEffect } from "react";
import { api, canEditModule, type TradeInEvaluation, type TradeInMargins, type TradeInQuestion, type TradeInQuestionsConfig } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, Sparkles, History, ChevronDown, ChevronLeft, RefreshCw, BadgeDollarSign, Settings, X,
  ListChecks, Plus, Trash2, ArrowUp, ArrowDown,
} from "lucide-react";

// Fluxo em etapas inspirado na Trocafone (trocafacil.trocafone.com.br):
// 1) Aparelho (marca → modelo → memória → cor)  2) Condições  3) Oferta.
// As perguntas de condições são EDITÁVEIS pelo admin (por marca: Apple x
// Android) e vêm do servidor; cada opção pode bloquear a avaliação.
const isAppleBrand = (brand: string) => /apple|iphone/i.test(brand);

const BRANDS = ["Apple", "Samsung", "Motorola", "Xiaomi", "Realme", "Outra"];

// Sugestões de modelos por marca (datalist — pode digitar qualquer outro).
const MODELS_BY_BRAND: Record<string, string[]> = {
  Apple: ["iPhone 8", "iPhone X", "iPhone XR", "iPhone 11", "iPhone 11 Pro", "iPhone 12", "iPhone 12 Pro", "iPhone 13", "iPhone 13 Pro", "iPhone 14", "iPhone 14 Pro", "iPhone 15", "iPhone 15 Pro", "iPhone 16"],
  Samsung: ["Galaxy A05", "Galaxy A15", "Galaxy A25", "Galaxy A35", "Galaxy A55", "Galaxy M15", "Galaxy S21", "Galaxy S22", "Galaxy S23", "Galaxy S24", "Galaxy Z Flip 5"],
  Motorola: ["Moto E14", "Moto G04", "Moto G24", "Moto G54", "Moto G84", "Edge 40", "Edge 50"],
  Xiaomi: ["Redmi 13C", "Redmi Note 12", "Redmi Note 13", "Redmi Note 13 Pro", "Poco X6", "Poco X6 Pro"],
  Realme: ["C53", "C61", "Note 50", "11 Pro"],
};

const MEMORIES = ["16GB", "32GB", "64GB", "128GB", "256GB", "512GB", "1TB"];

// Modelo em branco para o editor de perguntas do admin.
const emptyQuestion = (): TradeInQuestion => ({
  key: "", label: "",
  options: [{ label: "", blocks: false }, { label: "", blocks: false }],
});

const MARGIN_TABLES: { table: 1 | 2 | 3; key: keyof TradeInMargins; label: string }[] = [
  { table: 1, key: "t1", label: "Margem maior" },
  { table: 2, key: "t2", label: "Margem média" },
  { table: 3, key: "t3", label: "Margem menor" },
];
const COLORS = ["Preto", "Branco", "Azul", "Verde", "Roxo", "Dourado", "Prata", "Rosa", "Vermelho", "Grafite", "Titânio"];

const STEPS = [
  { n: 1, label: "Aparelho", hint: "Marca, modelo e detalhes" },
  { n: 2, label: "Condições", hint: "Estado do aparelho" },
  { n: 3, label: "Oferta", hint: "Valor sugerido" },
];

export default function Avaliacao() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = canEditModule(user, "avaliacao");

  const [step, setStep] = useState(1);
  const [marginTable, setMarginTable] = useState<1 | 2 | 3>(2);
  const [margins, setMargins] = useState<TradeInMargins | null>(null);
  const [showMarginCfg, setShowMarginCfg] = useState(false);
  const [cfgMargins, setCfgMargins] = useState<TradeInMargins>({ t1: 40, t2: 30, t3: 20 });
  const [savingMargins, setSavingMargins] = useState(false);
  const [brand, setBrand] = useState("");
  const [otherBrand, setOtherBrand] = useState(false);
  const [model, setModel] = useState("");
  const [memory, setMemory] = useState("");
  const [color, setColor] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [evaluating, setEvaluating] = useState(false);
  const [loadingBase, setLoadingBase] = useState(false);
  const [basePrice, setBasePrice] = useState("");
  const [baseMarket, setBaseMarket] = useState("");
  const [result, setResult] = useState<{ device: string; marketPrice: string; suggestedPrice: string; summary: string } | null>(null);
  // Tabela usada quando a IA calculou a oferta (para recalcular ao trocar).
  const [resultTable, setResultTable] = useState<1 | 2 | 3>(2);
  const [offerTable, setOfferTable] = useState<1 | 2 | 3>(2);
  const [history, setHistory] = useState<TradeInEvaluation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Pesquisa e filtros do histórico
  const [histSearch, setHistSearch] = useState("");
  const [histBrand, setHistBrand] = useState("");
  const [histMemory, setHistMemory] = useState("");

  // Perguntas configuráveis (servidor) + editor do admin.
  const [qConfig, setQConfig] = useState<TradeInQuestionsConfig | null>(null);
  const [showQuestionCfg, setShowQuestionCfg] = useState(false);
  const [cfgQuestions, setCfgQuestions] = useState<TradeInQuestionsConfig | null>(null);
  const [cfgTab, setCfgTab] = useState<"apple" | "android">("apple");
  const [savingQuestions, setSavingQuestions] = useState(false);

  const fetchHistory = () => { api.tradeIn.list().then(setHistory).catch(() => {}); };
  useEffect(() => {
    fetchHistory();
    api.tradeIn.margins().then(setMargins).catch(() => {});
    api.tradeIn.questions().then(setQConfig).catch(() => {});
  }, []);

  const deviceOk = Boolean(brand.trim() && model.trim());
  const questions: TradeInQuestion[] = qConfig ? (isAppleBrand(brand) ? qConfig.apple : qConfig.android) : [];
  const allAnswered = deviceOk && questions.length > 0 && questions.every((q) => answers[q.key]);
  const answeredCount = questions.filter((q) => answers[q.key]).length;
  // Alguma resposta marcada como "bloqueia avaliação"? Então a loja não avalia.
  const blockedAnswer = questions
    .map((qq) => ({ q: qq.key, a: answers[qq.key], opt: qq.options.find((o) => o.label === answers[qq.key]) }))
    .find((x) => x.a && x.opt?.blocks);

  // Etapa 1 → 2: busca o preço base (valor máximo em perfeito estado).
  const handleContinue = async () => {
    if (!deviceOk || loadingBase) return;
    setLoadingBase(true);
    setBasePrice(""); setBaseMarket("");
    try {
      const r = await api.tradeIn.basePrice({
        brand: brand.trim(), model: model.trim(), memory: memory.trim(), color: color.trim(), marginTable,
      });
      setBasePrice(r.basePrice); setBaseMarket(r.marketPrice);
    } catch (err) {
      // Sem preço base, segue mesmo assim — a avaliação final ainda funciona.
      toast({ title: "Não consegui buscar o preço base", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setLoadingBase(false);
      setStep(2);
    }
  };

  const handleEvaluate = async () => {
    if (!allAnswered || evaluating || blockedAnswer) return;
    setEvaluating(true);
    setResult(null);
    try {
      const r = await api.tradeIn.evaluate({
        brand: brand.trim(), model: model.trim(), memory: memory.trim(), color: color.trim(), marginTable,
        basePrice: basePrice || undefined, answers,
      });
      setResult(r);
      setResultTable(marginTable);
      setOfferTable(marginTable);
      setStep(3);
      fetchHistory();
    } catch (err) {
      toast({ title: "Erro na avaliação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setEvaluating(false);
    }
  };

  // Recalcula a oferta na hora ao trocar a tabela de margem (sem chamar a IA):
  // preço novo = preço da IA × (100 − margem nova) / (100 − margem original).
  const offerPrice = (aiPrice: string): string => {
    if (offerTable === resultTable || !margins) return aiPrice;
    const pctOf = (t: 1 | 2 | 3) => (t === 1 ? margins.t1 : t === 2 ? margins.t2 : margins.t3);
    const origPay = 100 - pctOf(resultTable);
    const newPay = 100 - pctOf(offerTable);
    if (origPay <= 0) return aiPrice;
    // Aceita "R$ 1.800", "R$ 1.800,00", "1800" etc.
    const m = aiPrice.replace(/\./g, "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
    if (!m) return aiPrice;
    const value = parseFloat(m[1]!);
    if (!Number.isFinite(value) || value <= 0) return aiPrice;
    const scaled = Math.round((value * newPay) / origPay / 10) * 10; // arredonda de 10 em 10
    return scaled.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  };

  const resetForm = () => {
    setBrand(""); setOtherBrand(false); setModel(""); setMemory(""); setColor("");
    setBasePrice(""); setBaseMarket("");
    setAnswers({}); setResult(null); setStep(1);
  };

  // Filtros do histórico: pesquisa livre (aparelho/vendedor/cor) + marca + memória.
  const brandOptions = [...new Set(history.map((h) => h.brand).filter(Boolean))] as string[];
  const memoryOptions = [...new Set(history.map((h) => h.memory).filter(Boolean))] as string[];
  const q = histSearch.trim().toLowerCase();
  const filteredHistory = history.filter((h) => {
    if (histBrand && h.brand !== histBrand) return false;
    if (histMemory && h.memory !== histMemory) return false;
    if (!q) return true;
    const hay = [h.device, h.brand, h.model, h.memory, h.color, h.userName].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  const modelSuggestions = MODELS_BY_BRAND[brand.trim()] ?? [];
  const currentStep = result ? 3 : step;

  const chip = (selected: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
      selected ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border hover:bg-secondary"
    }`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <BadgeDollarSign className="w-5 h-5 text-primary" /> Avaliação de Usados
        </h2>
        <button onClick={() => setShowHistory((v) => !v)} data-testid="button-toggle-tradein-history"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
          <History className="w-3.5 h-3.5" /> Últimas avaliações
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistory ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Histórico */}
      {showHistory && (
        <div className="shk-card p-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <input value={histSearch} onChange={(e) => setHistSearch(e.target.value)}
              placeholder="🔎 Pesquisar aparelho, cor ou vendedor..."
              data-testid="input-tradein-history-search"
              className="flex-1 min-w-[180px] px-3 py-2 rounded-xl border border-border text-xs" />
            <select value={histBrand} onChange={(e) => setHistBrand(e.target.value)}
              data-testid="select-tradein-history-brand"
              className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
              <option value="">Marca: todas</option>
              {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={histMemory} onChange={(e) => setHistMemory(e.target.value)}
              data-testid="select-tradein-history-memory"
              className="px-2.5 py-2 rounded-xl border border-border text-xs bg-white">
              <option value="">Memória: todas</option>
              {memoryOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {(histSearch || histBrand || histMemory) && (
              <button onClick={() => { setHistSearch(""); setHistBrand(""); setHistMemory(""); }}
                className="text-xs font-semibold text-primary underline">Limpar</button>
            )}
          </div>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {filteredHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-2">
                {history.length === 0 ? "Nenhuma avaliação feita ainda." : "Nada encontrado com esses filtros."}
              </p>
            ) : filteredHistory.map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-2 border-b border-border/50 pb-2 last:border-0">
                <div className="min-w-0">
                  <p className="text-xs font-bold break-words">{h.device}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {h.userName ?? "—"} · {new Date(h.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {h.color ? ` · ${h.color}` : ""}
                  </p>
                </div>
                <span className="text-xs font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full shrink-0">
                  {h.suggestedPrice ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!canEdit ? (
        <div className="shk-card p-6 text-center text-muted-foreground">
          <p className="text-sm font-semibold">Você só tem acesso de visualização à Avaliação de Usados.</p>
          <p className="text-xs mt-1">Peça ao administrador para liberar edição — enquanto isso, consulte o histórico acima.</p>
        </div>
      ) : (
      <>
      {/* Barra de progresso das etapas (estilo Trocafone) */}
      <div className="shk-card p-4">
        <div className="flex items-center">
          {STEPS.map((s, i) => (
            <div key={s.n} className={`flex items-center ${i < STEPS.length - 1 ? "flex-1" : ""}`}>
              <div className="flex flex-col items-center text-center shrink-0">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-extrabold border-2 transition ${
                  currentStep === s.n
                    ? "bg-primary text-white border-primary"
                    : currentStep > s.n
                      ? "bg-green-500 text-white border-green-500"
                      : "bg-white text-muted-foreground border-border"
                }`}>
                  {currentStep > s.n ? "✓" : s.n}
                </div>
                <p className={`text-[11px] font-bold mt-1 ${currentStep >= s.n ? "text-foreground" : "text-muted-foreground"}`}>{s.label}</p>
                <p className="text-[9px] text-muted-foreground hidden sm:block">{s.hint}</p>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-2 mb-6 rounded ${currentStep > s.n ? "bg-green-500" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Etapa 1: Aparelho */}
      {currentStep === 1 && (
        <div className="shk-card p-4 md:p-5 space-y-4">
          <label className="text-sm font-bold flex items-center gap-1.5">
            <Smartphone className="w-4 h-4 text-primary" /> Qual é o aparelho?
          </label>
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Marca *</p>
            <div className="flex gap-1.5 flex-wrap">
              {BRANDS.map((b) => (
                <button key={b}
                  onClick={() => { setOtherBrand(b === "Outra"); setBrand(b === "Outra" ? "" : b); setModel(""); setAnswers({}); }}
                  data-testid={`tradein-brand-${b}`}
                  className={chip(b === "Outra" ? otherBrand : (!otherBrand && brand === b))}>
                  {b}
                </button>
              ))}
            </div>
            {otherBrand && (
              <input value={brand} onChange={(e) => setBrand(e.target.value)}
                placeholder="Digite a marca..." autoFocus data-testid="input-tradein-brand-other"
                className="mt-2 w-full px-3 py-2.5 rounded-xl border border-border text-sm" />
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-0.5">Modelo *</p>
              <input value={model} onChange={(e) => setModel(e.target.value)} list="tradein-models"
                placeholder={modelSuggestions[0] ? `Ex.: ${modelSuggestions[modelSuggestions.length - 1]}` : "Ex.: iPhone 13"}
                data-testid="input-tradein-model"
                className="w-full px-3 py-2.5 rounded-xl border border-border text-sm" />
              <datalist id="tradein-models">
                {modelSuggestions.map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-0.5">Memória</p>
              <select value={memory} onChange={(e) => setMemory(e.target.value)}
                data-testid="select-tradein-memory"
                className="w-full px-3 py-2.5 rounded-xl border border-border text-sm bg-white">
                <option value="">Não sei / outra</option>
                {MEMORIES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-0.5">Cor</p>
              <input value={color} onChange={(e) => setColor(e.target.value)} list="tradein-colors"
                placeholder="Ex.: Preto" data-testid="input-tradein-color"
                className="w-full px-3 py-2.5 rounded-xl border border-border text-sm" />
              <datalist id="tradein-colors">
                {COLORS.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
          </div>
          {/* Tabela de margem (1 maior, 2 média, 3 menor) — define o preço base */}
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold mb-1.5">Tabela de margem</p>
              {user?.role === "admin" && (
                <div className="flex items-center gap-3">
                  <button onClick={() => { if (margins) setCfgMargins(margins); setShowMarginCfg(true); }}
                    data-testid="button-margin-settings"
                    className="flex items-center gap-1 text-[11px] font-semibold text-primary">
                    <Settings className="w-3 h-3" /> Editar margens
                  </button>
                  <button onClick={() => {
                      if (qConfig) setCfgQuestions(JSON.parse(JSON.stringify(qConfig)) as TradeInQuestionsConfig);
                      setCfgTab(isAppleBrand(brand) ? "apple" : "android");
                      setShowQuestionCfg(true);
                    }}
                    data-testid="button-question-settings"
                    className="flex items-center gap-1 text-[11px] font-semibold text-primary">
                    <ListChecks className="w-3 h-3" /> Editar perguntas
                  </button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {MARGIN_TABLES.map((t) => (
                <button key={t.table} onClick={() => setMarginTable(t.table)}
                  data-testid={`tradein-margin-${t.table}`}
                  className={`rounded-xl border-2 p-2.5 text-center transition ${
                    marginTable === t.table ? "border-primary bg-primary/5" : "border-border bg-white hover:bg-secondary"
                  }`}>
                  <p className="text-[11px] font-bold">Tabela {t.table}</p>
                  <p className="text-[10px] text-muted-foreground">{t.label}</p>
                  <p className={`text-sm font-extrabold mt-0.5 ${marginTable === t.table ? "text-primary" : "text-foreground"}`}>
                    {margins ? `${margins[t.key]}%` : "—"}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <button onClick={handleContinue} disabled={!deviceOk || loadingBase}
            data-testid="button-tradein-next"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
            {loadingBase
              ? (<><RefreshCw className="w-4 h-4 animate-spin" /> Buscando preço base...</>)
              : "Ver preço base → Condições"}
          </button>
          {!deviceOk && <p className="text-[11px] text-muted-foreground text-center">Escolha a marca e informe o modelo para continuar.</p>}
        </div>
      )}

      {/* Etapa 2: Condições */}
      {currentStep === 2 && (
        <div className="shk-card p-4 md:p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold">{[brand, model, memory, color].filter(Boolean).join(" ")}</p>
              <p className="text-[11px] text-muted-foreground">Como está o aparelho? ({answeredCount}/{questions.length} respondidas)</p>
            </div>
            <button onClick={() => setStep(1)} data-testid="button-tradein-back"
              className="flex items-center gap-1 text-xs font-semibold text-primary shrink-0">
              <ChevronLeft className="w-3.5 h-3.5" /> Voltar
            </button>
          </div>

          {/* Preço base (estilo Trocafone): valor máximo em perfeito estado */}
          {basePrice && (
            <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3 text-center" data-testid="tradein-base-price">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase">Estimativa de valor até</p>
              <p className="text-xl font-extrabold text-primary">{basePrice}</p>
              <p className="text-[10px] text-muted-foreground">
                aparelho em perfeito estado{baseMarket ? ` · revenda ${baseMarket}` : ""} — o valor final depende das condições abaixo
              </p>
            </div>
          )}

          {questions.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">Carregando perguntas...</p>
          )}
          {questions.map((qq) => (
            <div key={qq.key}>
              <p className="text-xs font-bold mb-1.5">{qq.label}</p>
              <div className="flex gap-1.5 flex-wrap">
                {qq.options.map((opt) => (
                  <button key={opt.label}
                    onClick={() => setAnswers((a) => ({ ...a, [qq.key]: opt.label }))}
                    data-testid={`tradein-${qq.key}-${opt.label}`}
                    className={chip(answers[qq.key] === opt.label)}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {blockedAnswer && (
            <div className="rounded-xl border-2 border-red-200 bg-red-50 p-3 text-center" data-testid="tradein-blocked-warning">
              <p className="text-sm font-bold text-red-700">🚫 Não avaliamos aparelho com parte sem funcionar</p>
              <p className="text-xs text-red-600 mt-0.5">
                {blockedAnswer.q}: "{blockedAnswer.a}" — mude a resposta se marcou errado.
              </p>
            </div>
          )}
          <button onClick={handleEvaluate} disabled={!allAnswered || evaluating || Boolean(blockedAnswer)}
            data-testid="button-evaluate-tradein"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
            {evaluating ? (<><RefreshCw className="w-4 h-4 animate-spin" /> Pesquisando preços e avaliando...</>) : (<><Sparkles className="w-4 h-4" /> Ver oferta →</>)}
          </button>
          {!allAnswered && !blockedAnswer && <p className="text-[11px] text-muted-foreground text-center">Responda todas as perguntas para ver a oferta.</p>}
        </div>
      )}

      {/* Etapa 3: Oferta */}
      {currentStep === 3 && result && (
        <div className="shk-card p-5 border-2 border-green-200 bg-green-50/40 space-y-3">
          <p className="text-xs font-bold text-muted-foreground">{result.device}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-white rounded-xl border border-border p-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase">Preço de revenda (mercado)</p>
              <p className="text-sm font-bold mt-0.5">{result.marketPrice || "—"}</p>
            </div>
            <div className="bg-green-600 rounded-xl p-3 text-white">
              <p className="text-[10px] font-semibold uppercase text-white/80">Sugestão de valor de compra</p>
              <p className="text-xl font-extrabold mt-0.5" data-testid="text-suggested-price">{offerPrice(result.suggestedPrice)}</p>
              {offerTable !== resultTable && (
                <p className="text-[10px] mt-0.5 text-white/80">Recalculado para a Tabela {offerTable}</p>
              )}
            </div>
          </div>
          {/* Trocar a tabela de margem direto na oferta */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5">Tabela de margem</p>
            <div className="flex gap-2">
              {([1, 2, 3] as const).map((t) => {
                const pct = margins ? (t === 1 ? margins.t1 : t === 2 ? margins.t2 : margins.t3) : null;
                return (
                  <button key={t} onClick={() => setOfferTable(t)} data-testid={`button-offer-table-${t}`}
                    className={`flex-1 rounded-xl border-2 px-2 py-1.5 text-xs font-bold transition-colors ${
                      offerTable === t ? "border-green-600 bg-green-600 text-white" : "border-border bg-white hover:bg-secondary"
                    }`}>
                    Tabela {t}{pct != null ? ` · ${pct}%` : ""}
                  </button>
                );
              })}
            </div>
          </div>
          {result.summary && <p className="text-xs text-foreground/80 whitespace-pre-wrap">{result.summary}</p>}
          <p className="text-[10px] text-muted-foreground">⚠ Sugestão gerada por IA com base em preços pesquisados — confirme antes de fechar a compra.</p>
          <div className="flex gap-2">
            <button onClick={() => { setResult(null); setStep(2); }}
              className="text-xs font-semibold text-muted-foreground underline">Ajustar condições</button>
            <button onClick={resetForm} data-testid="button-tradein-new"
              className="text-xs font-semibold text-primary underline">Fazer nova avaliação</button>
          </div>
        </div>
      )}
      </>
      )}

      {/* Modal: editar perguntas do questionário (só admin) */}
      {showQuestionCfg && cfgQuestions && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowQuestionCfg(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 pb-3 space-y-3 border-b border-border">
              <div className="flex items-center justify-between">
                <h3 className="font-bold flex items-center gap-2"><ListChecks className="w-4 h-4 text-primary" /> Perguntas da avaliação</h3>
                <button onClick={() => setShowQuestionCfg(false)} data-testid="button-close-question-cfg"><X className="w-5 h-5 text-muted-foreground" /></button>
              </div>
              <p className="text-xs text-muted-foreground">
                Edite as perguntas e opções do questionário de condições. Marque <b>🚫 bloqueia</b> nas respostas que indicam
                parte sem funcionar — a loja não avalia o aparelho nesses casos. As perguntas podem ser diferentes para Apple e Android.
              </p>
              <div className="flex gap-2">
                {(["apple", "android"] as const).map((g) => (
                  <button key={g} onClick={() => setCfgTab(g)} data-testid={`tab-questions-${g}`}
                    className={`flex-1 rounded-xl border-2 px-3 py-1.5 text-xs font-bold transition ${
                      cfgTab === g ? "border-primary bg-primary/5 text-primary" : "border-border bg-white hover:bg-secondary"
                    }`}>
                    {g === "apple" ? "Apple (iPhone)" : "Android / outras"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {cfgQuestions[cfgTab].map((qq, qi) => (
                <div key={qi} className="rounded-xl border border-border p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
                      <input value={qq.key}
                        onChange={(e) => setCfgQuestions((c) => {
                          const n = structuredClone(c!); n[cfgTab][qi]!.key = e.target.value; return n;
                        })}
                        placeholder="Título curto (ex.: Tela)" maxLength={60}
                        data-testid={`input-question-key-${qi}`}
                        className="px-3 py-2 rounded-xl border border-border text-xs font-semibold" />
                      <input value={qq.label}
                        onChange={(e) => setCfgQuestions((c) => {
                          const n = structuredClone(c!); n[cfgTab][qi]!.label = e.target.value; return n;
                        })}
                        placeholder="Texto da pergunta" maxLength={200}
                        data-testid={`input-question-label-${qi}`}
                        className="px-3 py-2 rounded-xl border border-border text-xs" />
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <div className="flex gap-1">
                        <button disabled={qi === 0} title="Mover para cima"
                          onClick={() => setCfgQuestions((c) => {
                            const n = structuredClone(c!); const arr = n[cfgTab];
                            [arr[qi - 1], arr[qi]] = [arr[qi]!, arr[qi - 1]!]; return n;
                          })}
                          className="p-1 rounded-lg border border-border text-muted-foreground disabled:opacity-30 hover:bg-secondary">
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button disabled={qi === cfgQuestions[cfgTab].length - 1} title="Mover para baixo"
                          onClick={() => setCfgQuestions((c) => {
                            const n = structuredClone(c!); const arr = n[cfgTab];
                            [arr[qi], arr[qi + 1]] = [arr[qi + 1]!, arr[qi]!]; return n;
                          })}
                          className="p-1 rounded-lg border border-border text-muted-foreground disabled:opacity-30 hover:bg-secondary">
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button title="Remover pergunta" data-testid={`button-remove-question-${qi}`}
                          onClick={() => setCfgQuestions((c) => {
                            const n = structuredClone(c!); n[cfgTab].splice(qi, 1); return n;
                          })}
                          className="p-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {qq.options.map((opt, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input value={opt.label}
                          onChange={(e) => setCfgQuestions((c) => {
                            const n = structuredClone(c!); n[cfgTab][qi]!.options[oi]!.label = e.target.value; return n;
                          })}
                          placeholder={`Opção ${oi + 1}`} maxLength={80}
                          data-testid={`input-option-${qi}-${oi}`}
                          className="flex-1 px-3 py-1.5 rounded-xl border border-border text-xs" />
                        <label className={`flex items-center gap-1 text-[11px] font-semibold cursor-pointer select-none px-2 py-1.5 rounded-xl border transition ${
                          opt.blocks ? "border-red-300 bg-red-50 text-red-700" : "border-border text-muted-foreground"
                        }`}>
                          <input type="checkbox" checked={opt.blocks}
                            onChange={(e) => setCfgQuestions((c) => {
                              const n = structuredClone(c!); n[cfgTab][qi]!.options[oi]!.blocks = e.target.checked; return n;
                            })}
                            data-testid={`checkbox-blocks-${qi}-${oi}`}
                            className="accent-red-600" />
                          🚫 bloqueia
                        </label>
                        <button title="Remover opção" disabled={qq.options.length <= 2}
                          onClick={() => setCfgQuestions((c) => {
                            const n = structuredClone(c!); n[cfgTab][qi]!.options.splice(oi, 1); return n;
                          })}
                          className="p-1 rounded-lg text-muted-foreground disabled:opacity-30 hover:text-red-600">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {qq.options.length < 8 && (
                      <button onClick={() => setCfgQuestions((c) => {
                          const n = structuredClone(c!); n[cfgTab][qi]!.options.push({ label: "", blocks: false }); return n;
                        })}
                        data-testid={`button-add-option-${qi}`}
                        className="flex items-center gap-1 text-[11px] font-semibold text-primary">
                        <Plus className="w-3 h-3" /> Adicionar opção
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {cfgQuestions[cfgTab].length < 30 && (
                <button onClick={() => setCfgQuestions((c) => {
                    const n = structuredClone(c!); n[cfgTab].push(emptyQuestion()); return n;
                  })}
                  data-testid="button-add-question"
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 border-dashed border-border text-xs font-bold text-primary hover:bg-secondary transition">
                  <Plus className="w-4 h-4" /> Adicionar pergunta
                </button>
              )}
            </div>

            <div className="p-5 pt-3 border-t border-border flex items-center gap-3">
              <button
                onClick={async () => {
                  if (!confirm("Restaurar as perguntas padrão do sistema? As personalizações serão perdidas.")) return;
                  try {
                    const def = await api.tradeIn.resetQuestions();
                    setQConfig(def);
                    setCfgQuestions(JSON.parse(JSON.stringify(def)) as TradeInQuestionsConfig);
                    setAnswers({});
                    toast({ title: "Perguntas padrão restauradas" });
                  } catch (err) {
                    toast({ title: "Erro ao restaurar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                  }
                }}
                data-testid="button-reset-questions"
                className="text-xs font-semibold text-muted-foreground underline">
                Restaurar padrão
              </button>
              <button
                onClick={async () => {
                  setSavingQuestions(true);
                  try {
                    const saved = await api.tradeIn.saveQuestions(cfgQuestions);
                    setQConfig(saved);
                    setShowQuestionCfg(false);
                    setAnswers({}); // respostas antigas podem não existir mais
                    toast({ title: "Perguntas salvas! ✅" });
                  } catch (err) {
                    toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                  } finally {
                    setSavingQuestions(false);
                  }
                }}
                disabled={savingQuestions}
                data-testid="button-save-questions"
                className="flex-1 py-2.5 rounded-xl bg-primary text-white font-semibold text-sm disabled:opacity-50">
                {savingQuestions ? "Salvando..." : "Salvar perguntas"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: editar % das tabelas de margem (só admin) */}
      {showMarginCfg && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowMarginCfg(false)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Tabelas de margem</h3>
              <button onClick={() => setShowMarginCfg(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <p className="text-xs text-muted-foreground">
              A margem é o lucro da loja: com margem de 30%, a sugestão de compra fica em torno de 70% do valor de revenda.
            </p>
            {MARGIN_TABLES.map((t) => (
              <div key={t.table} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Tabela {t.table}</p>
                  <p className="text-[11px] text-muted-foreground">{t.label}</p>
                </div>
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={90} value={cfgMargins[t.key]}
                    onChange={(e) => setCfgMargins((m) => ({ ...m, [t.key]: Number(e.target.value) }))}
                    data-testid={`input-margin-${t.table}`}
                    className="w-20 px-3 py-2 rounded-xl border border-border text-sm text-right" />
                  <span className="text-sm font-semibold text-muted-foreground">%</span>
                </div>
              </div>
            ))}
            <button
              onClick={async () => {
                for (const t of MARGIN_TABLES) {
                  const v = Math.round(cfgMargins[t.key]);
                  if (!Number.isFinite(v) || v < 1 || v > 90) {
                    toast({ title: "Margem inválida", description: "Use entre 1% e 90%.", variant: "destructive" });
                    return;
                  }
                }
                setSavingMargins(true);
                try {
                  const saved = await api.tradeIn.saveMargins(cfgMargins);
                  setMargins(saved);
                  setShowMarginCfg(false);
                  toast({ title: "Margens salvas! ✅" });
                } catch (err) {
                  toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
                } finally {
                  setSavingMargins(false);
                }
              }}
              disabled={savingMargins}
              data-testid="button-save-margins"
              className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm disabled:opacity-50">
              {savingMargins ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
