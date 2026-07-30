import { useState, useEffect } from "react";
import { api, type TradeInEvaluation } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, Sparkles, History, ChevronDown, RefreshCw, BadgeDollarSign,
} from "lucide-react";

// Questionário de estado, inspirado no fluxo da Trocafone.
const QUESTIONS: { key: string; label: string; options: string[] }[] = [
  { key: "Liga e funciona", label: "O aparelho liga e funciona normalmente?", options: ["Sim, funciona tudo", "Liga, mas tem defeito", "Não liga"] },
  { key: "Tela", label: "Como está a tela?", options: ["Perfeita", "Riscos leves", "Trincada / quebrada", "Não acende"] },
  { key: "Carcaça / traseira", label: "Como está a carcaça (laterais e traseira)?", options: ["Perfeita", "Marcas de uso", "Amassada / trincada"] },
  { key: "Bateria", label: "Como está a bateria?", options: ["Ótima (saúde acima de 85%)", "Regular (descarrega rápido)", "Ruim / estufada"] },
  { key: "Face ID / biometria", label: "Face ID ou leitor de digital funciona?", options: ["Funciona", "Não funciona", "Não tem"] },
  { key: "Acessórios", label: "Acompanha acessórios?", options: ["Caixa e carregador originais", "Só carregador", "Sem acessórios"] },
  { key: "Conta desvinculada", label: "iCloud / conta Google já desvinculada?", options: ["Sim", "Ainda não"] },
];

export default function Avaliacao() {
  const { toast } = useToast();

  const [device, setDevice] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [evaluating, setEvaluating] = useState(false);
  const [result, setResult] = useState<{ device: string; marketPrice: string; suggestedPrice: string; summary: string } | null>(null);
  const [history, setHistory] = useState<TradeInEvaluation[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const fetchHistory = () => { api.tradeIn.list().then(setHistory).catch(() => {}); };
  useEffect(() => { fetchHistory(); }, []);

  const allAnswered = device.trim() && QUESTIONS.every((q) => answers[q.key]);

  const handleEvaluate = async () => {
    if (!allAnswered || evaluating) return;
    setEvaluating(true);
    setResult(null);
    try {
      const r = await api.tradeIn.evaluate({ device: device.trim(), answers });
      setResult(r);
      fetchHistory();
    } catch (err) {
      toast({ title: "Erro na avaliação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setEvaluating(false);
    }
  };

  const resetForm = () => { setDevice(""); setAnswers({}); setResult(null); };

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
        <div className="shk-card p-4 space-y-2 max-h-72 overflow-y-auto">
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">Nenhuma avaliação feita ainda.</p>
          ) : history.map((h) => (
            <div key={h.id} className="flex items-start justify-between gap-2 border-b border-border/50 pb-2 last:border-0">
              <div className="min-w-0">
                <p className="text-xs font-bold break-words">{h.device}</p>
                <p className="text-[10px] text-muted-foreground">
                  {h.userName ?? "—"} · {new Date(h.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <span className="text-xs font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full shrink-0">
                {h.suggestedPrice ?? "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Formulário */}
      <div className="shk-card p-4 md:p-5 space-y-4">
        <div>
          <label className="text-xs font-bold mb-1 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-primary" /> Qual é o aparelho?
          </label>
          <input value={device} onChange={(e) => setDevice(e.target.value)}
            placeholder="Ex.: iPhone 13 128GB, Samsung S23 256GB..."
            data-testid="input-tradein-device"
            className="w-full px-3 py-2.5 rounded-xl border border-border text-sm" />
        </div>

        {QUESTIONS.map((q) => (
          <div key={q.key}>
            <p className="text-xs font-bold mb-1.5">{q.label}</p>
            <div className="flex gap-1.5 flex-wrap">
              {q.options.map((opt) => (
                <button key={opt}
                  onClick={() => setAnswers((a) => ({ ...a, [q.key]: opt }))}
                  data-testid={`tradein-${q.key}-${opt}`}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                    answers[q.key] === opt
                      ? "bg-primary text-white border-primary"
                      : "bg-white text-muted-foreground border-border hover:bg-secondary"
                  }`}>
                  {opt}
                </button>
              ))}
            </div>
          </div>
        ))}

        <button onClick={handleEvaluate} disabled={!allAnswered || evaluating}
          data-testid="button-evaluate-tradein"
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
          {evaluating ? (<><RefreshCw className="w-4 h-4 animate-spin" /> Pesquisando preços e avaliando...</>) : (<><Sparkles className="w-4 h-4" /> Avaliar com IA</>)}
        </button>
        {!allAnswered && <p className="text-[11px] text-muted-foreground text-center">Preencha o aparelho e responda todas as perguntas para avaliar.</p>}
      </div>

      {/* Resultado */}
      {result && (
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
          <button onClick={resetForm}
            className="text-xs font-semibold text-primary underline">Fazer nova avaliação</button>
        </div>
      )}
    </div>
  );
}
