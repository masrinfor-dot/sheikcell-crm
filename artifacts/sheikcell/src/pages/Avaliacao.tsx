import { useState, useEffect } from "react";
import { api, type TradeInEvaluation } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, Sparkles, History, ChevronDown, ChevronLeft, RefreshCw, BadgeDollarSign,
} from "lucide-react";

// Fluxo em etapas inspirado na Trocafone (trocafacil.trocafone.com.br):
// 1) Aparelho (marca → modelo → memória → cor)  2) Condições  3) Oferta.
const QUESTIONS: { key: string; label: string; options: string[] }[] = [
  { key: "Liga e funciona", label: "O aparelho liga e funciona normalmente?", options: ["Sim, funciona tudo", "Liga, mas tem defeito", "Não liga"] },
  { key: "Tela", label: "Como está a tela?", options: ["Perfeita", "Riscos leves", "Trincada / quebrada", "Não acende"] },
  { key: "Carcaça / traseira", label: "Como está a carcaça (laterais e traseira)?", options: ["Perfeita", "Marcas de uso", "Amassada / trincada"] },
  { key: "Bateria", label: "Como está a bateria?", options: ["Ótima (saúde acima de 85%)", "Regular (descarrega rápido)", "Ruim / estufada"] },
  { key: "Face ID / biometria", label: "Face ID ou leitor de digital funciona?", options: ["Funciona", "Não funciona", "Não tem"] },
  { key: "Acessórios", label: "Acompanha acessórios?", options: ["Caixa e carregador originais", "Só carregador", "Sem acessórios"] },
  { key: "Conta desvinculada", label: "iCloud / conta Google já desvinculada?", options: ["Sim", "Ainda não"] },
];

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
const COLORS = ["Preto", "Branco", "Azul", "Verde", "Roxo", "Dourado", "Prata", "Rosa", "Vermelho", "Grafite", "Titânio"];

const STEPS = [
  { n: 1, label: "Aparelho", hint: "Marca, modelo e detalhes" },
  { n: 2, label: "Condições", hint: "Estado do aparelho" },
  { n: 3, label: "Oferta", hint: "Valor sugerido" },
];

export default function Avaliacao() {
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [brand, setBrand] = useState("");
  const [otherBrand, setOtherBrand] = useState(false);
  const [model, setModel] = useState("");
  const [memory, setMemory] = useState("");
  const [color, setColor] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [evaluating, setEvaluating] = useState(false);
  const [result, setResult] = useState<{ device: string; marketPrice: string; suggestedPrice: string; summary: string } | null>(null);
  const [history, setHistory] = useState<TradeInEvaluation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Pesquisa e filtros do histórico
  const [histSearch, setHistSearch] = useState("");
  const [histBrand, setHistBrand] = useState("");
  const [histMemory, setHistMemory] = useState("");

  const fetchHistory = () => { api.tradeIn.list().then(setHistory).catch(() => {}); };
  useEffect(() => { fetchHistory(); }, []);

  const deviceOk = Boolean(brand.trim() && model.trim());
  const allAnswered = deviceOk && QUESTIONS.every((q) => answers[q.key]);
  const answeredCount = QUESTIONS.filter((q) => answers[q.key]).length;

  const handleEvaluate = async () => {
    if (!allAnswered || evaluating) return;
    setEvaluating(true);
    setResult(null);
    try {
      const r = await api.tradeIn.evaluate({
        brand: brand.trim(), model: model.trim(), memory: memory.trim(), color: color.trim(), answers,
      });
      setResult(r);
      setStep(3);
      fetchHistory();
    } catch (err) {
      toast({ title: "Erro na avaliação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setEvaluating(false);
    }
  };

  const resetForm = () => {
    setBrand(""); setOtherBrand(false); setModel(""); setMemory(""); setColor("");
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
                  onClick={() => { setOtherBrand(b === "Outra"); setBrand(b === "Outra" ? "" : b); setModel(""); }}
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
          <button onClick={() => deviceOk && setStep(2)} disabled={!deviceOk}
            data-testid="button-tradein-next"
            className="w-full px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
            Continuar → Condições
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
              <p className="text-[11px] text-muted-foreground">Como está o aparelho? ({answeredCount}/{QUESTIONS.length} respondidas)</p>
            </div>
            <button onClick={() => setStep(1)} data-testid="button-tradein-back"
              className="flex items-center gap-1 text-xs font-semibold text-primary shrink-0">
              <ChevronLeft className="w-3.5 h-3.5" /> Voltar
            </button>
          </div>

          {QUESTIONS.map((qq) => (
            <div key={qq.key}>
              <p className="text-xs font-bold mb-1.5">{qq.label}</p>
              <div className="flex gap-1.5 flex-wrap">
                {qq.options.map((opt) => (
                  <button key={opt}
                    onClick={() => setAnswers((a) => ({ ...a, [qq.key]: opt }))}
                    data-testid={`tradein-${qq.key}-${opt}`}
                    className={chip(answers[qq.key] === opt)}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <button onClick={handleEvaluate} disabled={!allAnswered || evaluating}
            data-testid="button-evaluate-tradein"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
            {evaluating ? (<><RefreshCw className="w-4 h-4 animate-spin" /> Pesquisando preços e avaliando...</>) : (<><Sparkles className="w-4 h-4" /> Ver oferta →</>)}
          </button>
          {!allAnswered && <p className="text-[11px] text-muted-foreground text-center">Responda todas as perguntas para ver a oferta.</p>}
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
              <p className="text-xl font-extrabold mt-0.5" data-testid="text-suggested-price">{result.suggestedPrice}</p>
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
    </div>
  );
}
