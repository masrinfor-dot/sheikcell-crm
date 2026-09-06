import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { api } from "@/lib/api";
import { Smartphone, PackageX, ChevronLeft, CheckCircle2, Loader2 } from "lucide-react";

// Avaliação de usados PÚBLICA (vitrine, sem login) — link /avaliar/:slug,
// pedido do lojista (06/09): "colocar o botão de avaliação de usados, o
// mesmo que temos no CRM já com tabela de margem cadastrada e
// personalizável, como o cliente que vai fazer sua avaliação do usado".
// Nunca fecha negócio por aqui (CPF, IMEI, fotos continuam só no CRM, com
// atendente) — o cliente só recebe uma ESTIMATIVA e pode deixar contato pra
// loja confirmar. Ver tradeInPublicRouter (routes/tradeIn.ts) no backend.

const isAppleBrand = (brand: string) => /apple|iphone/i.test(brand);
const BRANDS = ["Apple", "Samsung", "Motorola", "Xiaomi", "Realme", "Outra"];
const MEMORIES = ["16GB", "32GB", "64GB", "128GB", "256GB", "512GB", "1TB"];
const COLORS = ["Preto", "Branco", "Azul", "Verde", "Roxo", "Dourado", "Prata", "Rosa", "Vermelho", "Grafite", "Titânio"];

type PublicQuestion = { key: string; label: string; options: { label: string }[] };
type PublicQuestions = { apple: PublicQuestion[]; android: PublicQuestion[] };
type EstimateResult =
  | { method: "table" | "ai"; device: string; estimatedPrice: string }
  | { blocked: true; message: string };

export default function AvaliacaoPublica() {
  const { slug } = useParams<{ slug: string }>();
  const [storeName, setStoreName] = useState<string | null>(null);
  const [questions, setQuestions] = useState<PublicQuestions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [brand, setBrand] = useState("");
  const [otherBrand, setOtherBrand] = useState(false);
  const [model, setModel] = useState("");
  const [memory, setMemory] = useState("");
  const [color, setColor] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ estimatedPrice: string } | null>(null);

  const [leadName, setLeadName] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [sendingLead, setSendingLead] = useState(false);
  const [leadSent, setLeadSent] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) { setError("Link inválido"); return; }
    Promise.all([
      api.catalog.public(slug).then((d) => setStoreName(d.storeName)).catch(() => {}),
      api.tradeInPublic.questions(slug).then(setQuestions),
    ]).catch((e) => setError(e instanceof Error ? e.message : "Avaliação não disponível"));
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

  if (!questions) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="w-8 h-8 rounded-full border-4 border-neutral-300 border-t-neutral-600 animate-spin" />
      </div>
    );
  }

  const questionList = isAppleBrand(brand) ? questions.apple : questions.android;
  const deviceOk = Boolean(brand.trim() && model.trim());
  const allAnswered = questionList.length > 0 && questionList.every((q) => answers[q.key]);

  const submitEstimate = async () => {
    if (!slug || estimating) return;
    setEstimating(true);
    setEstimateError(null);
    setBlockedMessage(null);
    try {
      const r: EstimateResult = await api.tradeInPublic.estimate(slug, { brand: brand.trim(), model: model.trim(), memory, color, answers });
      if ("blocked" in r && r.blocked) {
        setBlockedMessage(r.message);
        setStep(4); // vai direto pro formulário de contato
      } else if ("estimatedPrice" in r) {
        setResult({ estimatedPrice: r.estimatedPrice });
        setStep(3);
      }
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : "Não foi possível calcular a estimativa agora.");
    } finally {
      setEstimating(false);
    }
  };

  const submitLead = async () => {
    if (!slug || sendingLead) return;
    setLeadError(null);
    if (!leadName.trim()) { setLeadError("Informe seu nome"); return; }
    if (leadPhone.replace(/\D/g, "").length < 10) { setLeadError("Informe um telefone válido (com DDD)"); return; }
    setSendingLead(true);
    try {
      await api.tradeInPublic.lead(slug, {
        name: leadName.trim(), phone: leadPhone, brand: brand.trim(), model: model.trim(), memory, color,
        answers, estimatedPrice: result?.estimatedPrice,
      });
      setLeadSent(true);
    } catch (err) {
      setLeadError(err instanceof Error ? err.message : "Não foi possível enviar. Tente de novo.");
    } finally {
      setSendingLead(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 pb-16">
      <header className="sticky top-0 z-10 bg-white border-b border-neutral-200">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center gap-3">
          {slug && (
            <Link href={`/vitrine/${slug}`} className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-500 shrink-0">
              <ChevronLeft className="w-5 h-5" />
            </Link>
          )}
          <div className="w-9 h-9 rounded-xl bg-neutral-900 text-white flex items-center justify-center shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-neutral-900 leading-tight">{storeName ?? "Avaliação de usados"}</h1>
            <p className="text-xs text-neutral-500">Avalie seu aparelho usado</p>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-5 space-y-4">
        {step === 1 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-4 space-y-3">
            <p className="text-sm font-bold text-neutral-900">Conte pra gente sobre o seu aparelho</p>
            <div>
              <p className="text-xs font-semibold text-neutral-600 mb-1">Marca</p>
              <div className="grid grid-cols-3 gap-1.5">
                {BRANDS.map((b) => (
                  <button key={b} type="button"
                    onClick={() => { if (b === "Outra") { setOtherBrand(true); setBrand(""); } else { setOtherBrand(false); setBrand(b); } }}
                    className={`rounded-xl border-2 px-2 py-2 text-xs font-semibold transition ${
                      (b === "Outra" ? otherBrand : brand === b && !otherBrand) ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700"
                    }`}>
                    {b}
                  </button>
                ))}
              </div>
              {otherBrand && (
                <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Digite a marca" maxLength={40}
                  className="mt-2 w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm" />
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-neutral-600 mb-1">Modelo</p>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Ex.: iPhone 13" maxLength={60}
                className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-xs font-semibold text-neutral-600 mb-1">Armazenamento</p>
                <select value={memory} onChange={(e) => setMemory(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm bg-white">
                  <option value="">Selecione</option>
                  {MEMORIES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <p className="text-xs font-semibold text-neutral-600 mb-1">Cor</p>
                <select value={color} onChange={(e) => setColor(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm bg-white">
                  <option value="">Selecione</option>
                  {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <button type="button" disabled={!deviceOk} onClick={() => setStep(2)}
              className="w-full py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm disabled:opacity-40">
              Continuar
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-4 space-y-3">
            <p className="text-sm font-bold text-neutral-900">Como está o aparelho?</p>
            <p className="text-xs text-neutral-500">Compramos com qualquer estado — seja bem sincero, isso só ajusta o valor final.</p>
            {questionList.map((q) => (
              <div key={q.key}>
                <p className="text-xs font-semibold text-neutral-700 mb-1">{q.label}</p>
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((o) => (
                    <button key={o.label} type="button"
                      onClick={() => setAnswers((a) => ({ ...a, [q.key]: o.label }))}
                      className={`rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition ${
                        answers[q.key] === o.label ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700"
                      }`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {estimateError && <p className="text-xs text-red-600 font-medium">{estimateError}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep(1)} className="py-2.5 px-4 rounded-xl bg-neutral-100 text-neutral-700 font-semibold text-sm">Voltar</button>
              <button type="button" disabled={!allAnswered || estimating} onClick={submitEstimate}
                className="flex-1 py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm disabled:opacity-40 flex items-center justify-center gap-2">
                {estimating ? <><Loader2 className="w-4 h-4 animate-spin" /> Calculando...</> : "Ver valor estimado"}
              </button>
            </div>
          </div>
        )}

        {step === 3 && result && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4 text-center">
            <p className="text-sm font-semibold text-neutral-600">Valor estimado de compra do seu {model}</p>
            <p className="text-3xl font-extrabold text-emerald-600">{result.estimatedPrice}</p>
            <p className="text-xs text-neutral-500">
              Essa é uma estimativa — o valor final é confirmado pela nossa equipe na hora de fechar (pode variar um pouco depois de conferir o aparelho pessoalmente).
            </p>
            <button type="button" onClick={() => setStep(4)}
              className="w-full py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm">
              Quero vender — deixar meu contato
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-3">
            {leadSent ? (
              <div className="text-center space-y-2 py-4">
                <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-600" />
                <p className="text-sm font-bold text-neutral-900">Contato enviado!</p>
                <p className="text-xs text-neutral-500">A loja vai entrar em contato pra confirmar o valor e combinar a entrega do aparelho.</p>
              </div>
            ) : (
              <>
                <p className="text-sm font-bold text-neutral-900">
                  {blockedMessage ?? "Deixe seu contato que a loja confirma o valor e combina a entrega"}
                </p>
                <input value={leadName} onChange={(e) => setLeadName(e.target.value)} placeholder="Seu nome" maxLength={120}
                  className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm" />
                <input value={leadPhone} onChange={(e) => setLeadPhone(e.target.value)} placeholder="WhatsApp (com DDD)" maxLength={20}
                  className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm" />
                {leadError && <p className="text-xs text-red-600 font-medium">{leadError}</p>}
                <button type="button" disabled={sendingLead} onClick={submitLead}
                  className="w-full py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm disabled:opacity-40">
                  {sendingLead ? "Enviando..." : "Enviar"}
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
