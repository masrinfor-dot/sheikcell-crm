import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation, Link } from "wouter";
import { api } from "@/lib/api";
import { waLink } from "@/lib/utils";
import { Smartphone, PackageX, ChevronLeft, CheckCircle2, Loader2, MessageCircle, AlertTriangle } from "lucide-react";

// Avaliação de usados PÚBLICA (vitrine, sem login) — link /avaliar/:slug,
// pedido do lojista (06/09): "colocar o botão de avaliação de usados, o
// mesmo que temos no CRM já com tabela de margem cadastrada e
// personalizável, como o cliente que vai fazer sua avaliação do usado".
// Nunca fecha negócio por aqui (CPF, IMEI, fotos continuam só no CRM, com
// atendente) — o cliente só recebe uma ESTIMATIVA. Ver tradeInPublicRouter
// (routes/tradeIn.ts) no backend.
//
// Atualização (06/09, pedido do lojista): nome/telefone agora são pedidos
// ANTES do checklist (não mais só no fim), e o fluxo tem dois "modos":
//   - Avaliação avulsa (quer só VENDER o usado) — termina redirecionando
//     pro WhatsApp da loja, com a estimativa e as respostas do checklist já
//     no texto da mensagem.
//   - "Trocar por este aparelho" (chegou aqui com ?troca=1, depois de
//     escolher um aparelho novo na vitrine e cair no carrinho) — termina
//     aplicando o valor estimado como desconto no carrinho (guardado em
//     localStorage, lido pela VitrinePublica) e volta pra vitrine, SEM abrir
//     o WhatsApp ainda — o cliente finaliza o pedido (aparelho novo + o
//     desconto do usado) pelo botão "Finalizar pedido no WhatsApp" do
//     carrinho, que já manda tudo numa mensagem só.
// Se a avaliação automática não rolar (avaria que precisa de atendente —
// "blocked"), não tem valor pra aplicar como desconto: sempre cai no
// WhatsApp nesse caso, mesmo em modo troca, pra loja negociar manualmente.

const isAppleBrand = (brand: string) => /apple|iphone/i.test(brand);
const BRANDS = ["Apple", "Samsung", "Motorola", "Xiaomi", "Realme", "Outra"];
const MEMORIES = ["16GB", "32GB", "64GB", "128GB", "256GB", "512GB", "1TB"];
const COLORS = ["Preto", "Branco", "Azul", "Verde", "Roxo", "Dourado", "Prata", "Rosa", "Vermelho", "Grafite", "Titânio"];

function tradeInStorageKey(slug: string) {
  return `sheikcell-vitrine-troca-${slug}`;
}

type PublicQuestion = { key: string; label: string; options: { label: string }[] };
type PublicQuestions = { apple: PublicQuestion[]; android: PublicQuestion[] };
type EstimateResult =
  | { method: "table" | "ai"; device: string; estimatedPrice: string }
  | { blocked: true; message: string };

export default function AvaliacaoPublica() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  // ?troca=1 — veio do botão "Trocar por este aparelho" num produto da
  // vitrine (já tem algo no carrinho esperando o desconto).
  const isTroca = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("troca") === "1";

  const [storeName, setStoreName] = useState<string | null>(null);
  const [whatsapp, setWhatsapp] = useState<string | null>(null);
  const [questions, setQuestions] = useState<PublicQuestions | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Passo 0 = nome/telefone (sempre primeiro agora), 1 = dados do aparelho,
  // 2 = checklist de estado, 3 = resultado + ação final.
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);

  const [leadName, setLeadName] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);

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

  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!slug) { setError("Link inválido"); return; }
    Promise.all([
      api.catalog.public(slug).then((d) => { setStoreName(d.storeName); setWhatsapp(d.whatsapp); }).catch(() => {}),
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

  const confirmContact = () => {
    setContactError(null);
    if (!leadName.trim()) { setContactError("Informe seu nome"); return; }
    if (leadPhone.replace(/\D/g, "").length < 10) { setContactError("Informe um telefone válido (com DDD)"); return; }
    setStep(1);
  };

  const submitEstimate = async () => {
    if (!slug || estimating) return;
    setEstimating(true);
    setEstimateError(null);
    setBlockedMessage(null);
    try {
      const r: EstimateResult = await api.tradeInPublic.estimate(slug, { brand: brand.trim(), model: model.trim(), memory, color, answers });
      if ("blocked" in r && r.blocked) {
        setBlockedMessage(r.message);
        setStep(3);
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

  const device = [brand.trim(), model.trim(), memory, color].filter(Boolean).join(" ");
  const conditionLines = questionList
    .filter((q) => answers[q.key])
    .map((q) => `${q.label}: ${answers[q.key]}`);

  // Mensagem pronta pro WhatsApp — calculada sempre (não só depois do
  // clique), assim o link fica pronto num <a> normal em vez de window.open
  // async (que navegador costuma bloquear se não for direto no clique).
  const whatsappMessage = useMemo(() => {
    const lines = [
      blockedMessage
        ? `Olá! Quero vender meu ${device || "aparelho"} — pedi uma avaliação no site mas esse caso precisa ser visto por vocês.`
        : `Olá! Fiz uma avaliação do meu ${device || "aparelho"} no site e quero ${isTroca ? "usar ele de entrada numa troca" : "vender"}.`,
      "",
      `Aparelho: ${device || "-"}`,
      ...(conditionLines.length > 0 ? ["Estado:", ...conditionLines.map((l) => `- ${l}`)] : []),
      ...(result ? [`Valor estimado: ${result.estimatedPrice} (a confirmar depois de conferir o aparelho)`] : []),
      "",
      `Nome: ${leadName.trim()}`,
      `Telefone: ${leadPhone.trim()}`,
    ];
    return lines.join("\n");
  }, [blockedMessage, device, conditionLines, result, isTroca, leadName, leadPhone]);

  const waUrl = waLink(whatsapp, whatsappMessage);

  // Registra o lead no CRM da loja (fire-and-forget na hora do clique final
  // — nunca deve travar o redirecionamento/aplicação do desconto se falhar,
  // mas ainda tentamos avisar se der erro ANTES de sair da página, no modo
  // troca, já que aí não tem WhatsApp como rede de segurança).
  const registerLead = () =>
    slug ? api.tradeInPublic.lead(slug, {
      name: leadName.trim(), phone: leadPhone, brand: brand.trim(), model: model.trim(), memory, color,
      answers, estimatedPrice: result?.estimatedPrice,
    }) : Promise.resolve();

  const finishStandalone = () => {
    setFinished(true);
    registerLead().catch(() => { /* best-effort — a mensagem do WhatsApp já tem tudo */ });
  };

  const finishTroca = async () => {
    if (!slug || finishing || !result) return;
    setFinishing(true);
    setFinishError(null);
    try {
      await registerLead();
      try {
        localStorage.setItem(tradeInStorageKey(slug), JSON.stringify({
          device, estimatedPriceLabel: result.estimatedPrice,
          estimatedPriceValue: (() => {
            const m = result.estimatedPrice.match(/[\d.,]+/);
            if (!m) return null;
            let s = m[0];
            s = s.includes(",") && s.includes(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(",", ".");
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
          })(),
        }));
      } catch { /* privado/bloqueado — segue sem persistir o desconto */ }
      navigate(`/vitrine/${slug}`);
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : "Não foi possível registrar sua avaliação agora. Tente de novo.");
    } finally {
      setFinishing(false);
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
            <p className="text-xs text-neutral-500">{isTroca ? "Troque seu usado por um aparelho novo" : "Avalie seu aparelho usado"}</p>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-5 space-y-4">
        {step === 0 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-4 space-y-3">
            <p className="text-sm font-bold text-neutral-900">
              {isTroca ? "Antes de avaliar seu usado, como podemos te chamar?" : "Antes de começar, como podemos te chamar?"}
            </p>
            <p className="text-xs text-neutral-500">A gente usa isso só pra confirmar o valor com você depois — nada é publicado.</p>
            <input value={leadName} onChange={(e) => setLeadName(e.target.value)} placeholder="Seu nome" maxLength={120}
              data-testid="input-lead-name" className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm" />
            <input value={leadPhone} onChange={(e) => setLeadPhone(e.target.value)} placeholder="WhatsApp (com DDD)" maxLength={20}
              data-testid="input-lead-phone" className="w-full px-3 py-2 rounded-xl border border-neutral-200 text-sm" />
            {contactError && <p className="text-xs text-red-600 font-medium">{contactError}</p>}
            <button type="button" onClick={confirmContact} data-testid="button-confirm-contact"
              className="w-full py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm">
              Continuar
            </button>
            {!isTroca && slug && (
              <p className="text-xs text-neutral-500 text-center pt-1">
                Quer trocar por um aparelho novo?{" "}
                <Link href={`/vitrine/${slug}`} className="text-neutral-900 font-semibold underline">Escolha o aparelho na loja</Link>
                {" "}e toque em "Trocar por este aparelho".
              </p>
            )}
          </div>
        )}

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
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep(0)} className="py-2.5 px-4 rounded-xl bg-neutral-100 text-neutral-700 font-semibold text-sm">Voltar</button>
              <button type="button" disabled={!deviceOk} onClick={() => setStep(2)}
                className="flex-1 py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm disabled:opacity-40">
                Continuar
              </button>
            </div>
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

        {step === 3 && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4 text-center">
            {result && !blockedMessage && (
              <>
                <p className="text-sm font-semibold text-neutral-600">Valor estimado de compra do seu {model}</p>
                <p className="text-3xl font-extrabold text-emerald-600">{result.estimatedPrice}</p>
                <p className="text-xs text-neutral-500 flex items-start gap-1.5 text-left bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
                  Essa é uma estimativa — o valor final é confirmado pela nossa equipe depois de conferir o aparelho pessoalmente (checklist).
                </p>
              </>
            )}
            {blockedMessage && (
              <p className="text-sm font-semibold text-neutral-900">{blockedMessage}</p>
            )}

            {finished ? (
              <div className="space-y-2 py-2">
                <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-600" />
                <p className="text-sm font-bold text-neutral-900">Prontinho!</p>
                <p className="text-xs text-neutral-500">Se o WhatsApp não abriu automaticamente, toque no botão abaixo.</p>
                {waUrl && (
                  <a href={waUrl} target="_blank" rel="noreferrer" data-testid="link-open-whatsapp"
                    className="inline-flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 transition">
                    <MessageCircle className="w-4 h-4" /> Abrir WhatsApp
                  </a>
                )}
              </div>
            ) : blockedMessage || !isTroca ? (
              waUrl ? (
                <a href={waUrl} target="_blank" rel="noreferrer" onClick={finishStandalone} data-testid="button-finish-whatsapp"
                  className="inline-flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl bg-emerald-500 text-white font-semibold text-sm hover:bg-emerald-600 transition">
                  <MessageCircle className="w-4 h-4" /> Falar no WhatsApp
                </a>
              ) : (
                <p className="text-xs text-neutral-400">WhatsApp da loja não configurado — tente novamente mais tarde.</p>
              )
            ) : (
              <>
                {finishError && <p className="text-xs text-red-600 font-medium">{finishError}</p>}
                <button type="button" onClick={finishTroca} disabled={finishing} data-testid="button-apply-tradein"
                  className="w-full py-2.5 rounded-xl bg-neutral-900 text-white font-semibold text-sm disabled:opacity-40 flex items-center justify-center gap-2">
                  {finishing ? <><Loader2 className="w-4 h-4 animate-spin" /> Aplicando...</> : "Aplicar desconto no carrinho"}
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
