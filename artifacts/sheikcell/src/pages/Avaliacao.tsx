import { useState, useEffect } from "react";
import { api, canEditModule, type TradeInEvaluation, type TradeInMargins, type TradeInQuestion, type TradeInQuestionsConfig } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, Sparkles, History, ChevronDown, ChevronLeft, RefreshCw, BadgeDollarSign, Settings, X,
  ListChecks, Plus, Trash2, ArrowUp, ArrowDown, ImagePlus, Printer, Wallet, TrendingUp, LayoutDashboard,
} from "lucide-react";

// Formas de pagamento oferecidas ao fechar a compra (nota de compra) — texto
// livre no banco, mas a UI sugere as mais comuns pra loja não digitar toda vez.
const PAYMENT_METHODS = ["Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito", "Transferência bancária", "Outro"];

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
  { n: 4, label: "Fechar negócio", hint: "Dados do cliente e valor final" },
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
  // Nome do cliente já na simulação (etapas 1-3) — pedido do lojista pra saber
  // de quem é cada avaliação no histórico, mesmo antes de fechar negócio.
  const [customerName, setCustomerName] = useState("");
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
  const [result, setResult] = useState<{ id: number; device: string; marketPrice: string; suggestedPrice: string; summary: string } | null>(null);
  // Tabela usada quando a IA calculou a oferta (para recalcular ao trocar).
  const [resultTable, setResultTable] = useState<1 | 2 | 3>(2);
  const [offerTable, setOfferTable] = useState<1 | 2 | 3>(2);
  // Etapa 4: fechamento do negócio (dados do cliente vendedor + valor final).
  const [dealName, setDealName] = useState("");
  const [dealCpf, setDealCpf] = useState("");
  const [dealImei, setDealImei] = useState("");
  const [dealPrice, setDealPrice] = useState("");
  // Nota de compra completa: dados extras do vendedor + fotos comprobatórias.
  const [dealRg, setDealRg] = useState("");
  const [dealAddress, setDealAddress] = useState("");
  const [dealNeighborhood, setDealNeighborhood] = useState("");
  const [dealPhone, setDealPhone] = useState("");
  const [dealPaymentMethod, setDealPaymentMethod] = useState("");
  const [dealPixKey, setDealPixKey] = useState("");
  const [dealPixKeyHolder, setDealPixKeyHolder] = useState("");
  const [documentPhotos, setDocumentPhotos] = useState<string[]>([]);
  const [devicePhotos, setDevicePhotos] = useState<string[]>([]);
  const [paymentProofPhotos, setPaymentProofPhotos] = useState<string[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadingDevice, setUploadingDevice] = useState(false);
  const [uploadingPayment, setUploadingPayment] = useState(false);
  const [closingDeal, setClosingDeal] = useState(false);
  const [dealClosed, setDealClosed] = useState(false);
  const [history, setHistory] = useState<TradeInEvaluation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Aba "Celulares comprados" — só as avaliações já fechadas (compra
  // efetivada), separado do histórico geral (que mistura simulações não
  // fechadas). Reaproveita o mesmo mini-formulário de fechamento (via
  // histClosingId/openHistoryClose) pra permitir completar o IMEI depois,
  // quando o aparelho foi comprado com defeito e não deu pra conferir na hora.
  const [showPurchased, setShowPurchased] = useState(false);
  const [purchSearch, setPurchSearch] = useState("");
  // Pesquisa e filtros do histórico
  const [histSearch, setHistSearch] = useState("");
  const [histBrand, setHistBrand] = useState("");
  const [histMemory, setHistMemory] = useState("");
  // Finalizar compra direto de dentro do histórico (avaliação feita numa
  // sessão anterior, ou o cliente saiu pra pensar e voltou depois) — mesmos
  // campos da etapa 4, mas fechando uma avaliação passada em vez da atual.
  const [histClosingId, setHistClosingId] = useState<number | null>(null);
  const [histDealName, setHistDealName] = useState("");
  const [histDealCpf, setHistDealCpf] = useState("");
  const [histDealImei, setHistDealImei] = useState("");
  const [histDealPrice, setHistDealPrice] = useState("");
  const [histDealRg, setHistDealRg] = useState("");
  const [histDealAddress, setHistDealAddress] = useState("");
  const [histDealNeighborhood, setHistDealNeighborhood] = useState("");
  const [histDealPhone, setHistDealPhone] = useState("");
  const [histDealPaymentMethod, setHistDealPaymentMethod] = useState("");
  const [histDealPixKey, setHistDealPixKey] = useState("");
  const [histDealPixKeyHolder, setHistDealPixKeyHolder] = useState("");
  const [histClosing, setHistClosing] = useState(false);

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
  const customerNameOk = Boolean(customerName.trim());
  const questions: TradeInQuestion[] = qConfig ? (isAppleBrand(brand) ? qConfig.apple : qConfig.android) : [];
  const allAnswered = deviceOk && questions.length > 0 && questions.every((q) => answers[q.key]);
  const answeredCount = questions.filter((q) => answers[q.key]).length;
  // Alguma resposta marcada como "bloqueia avaliação"? Então a loja não avalia.
  const blockedAnswer = questions
    .map((qq) => ({ q: qq.key, a: answers[qq.key], opt: qq.options.find((o) => o.label === answers[qq.key]) }))
    .find((x) => x.a && x.opt?.blocks);

  // Etapa 1 → 2: busca o preço base (valor máximo em perfeito estado).
  const handleContinue = async () => {
    if (!deviceOk || !customerNameOk || loadingBase) return;
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
        basePrice: basePrice || undefined, answers, customerName: customerName.trim() || undefined,
      });
      setResult(r);
      setResultTable(marginTable);
      setOfferTable(marginTable);
      setDocumentPhotos([]); setDevicePhotos([]); setPaymentProofPhotos([]);
      // Pré-preenche o nome na etapa 4 (fechar negócio) com o nome já
      // informado na simulação — o vendedor ainda pode ajustar/corrigir.
      setDealName(customerName.trim());
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
    setCustomerName("");
    setBrand(""); setOtherBrand(false); setModel(""); setMemory(""); setColor("");
    setBasePrice(""); setBaseMarket("");
    setAnswers({}); setResult(null); setStep(1);
    setDealName(""); setDealCpf(""); setDealImei(""); setDealPrice("");
    setDealRg(""); setDealAddress(""); setDealNeighborhood(""); setDealPhone("");
    setDealPaymentMethod(""); setDealPixKey(""); setDealPixKeyHolder("");
    setDocumentPhotos([]); setDevicePhotos([]); setPaymentProofPhotos([]);
    setClosingDeal(false); setDealClosed(false);
  };

  const handleCloseDeal = async () => {
    if (!result || closingDeal) return;
    const name = dealName.trim();
    const cpf = dealCpf.trim();
    const imei = dealImei.trim();
    const price = dealPrice.trim();
    // IMEI é opcional aqui de propósito: às vezes o aparelho comprado chega
    // com defeito e nem liga pra conferir o IMEI na hora — dá pra completar
    // depois pela aba "Celulares comprados".
    if (!name || !cpf || !price) {
      toast({ title: "Preencha nome, CPF e valor para fechar o negócio", variant: "destructive" });
      return;
    }
    setClosingDeal(true);
    try {
      await api.tradeIn.close(result.id, {
        sellerCustomerName: name, sellerCpf: cpf, imei, finalAgreedPrice: price,
        sellerRg: dealRg.trim() || undefined, sellerAddress: dealAddress.trim() || undefined,
        sellerNeighborhood: dealNeighborhood.trim() || undefined, sellerPhone: dealPhone.trim() || undefined,
        paymentMethod: dealPaymentMethod.trim() || undefined, pixKey: dealPixKey.trim() || undefined,
        pixKeyHolder: dealPixKeyHolder.trim() || undefined,
      });
      setDealClosed(true);
      toast({ title: "Negócio fechado com sucesso" });
      fetchHistory();
    } catch (err) {
      toast({ title: "Erro ao fechar negócio", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setClosingDeal(false);
    }
  };

  // Fotos da nota de compra: 1 upload por vez (evita estourar o corpo da
  // requisição quando o vendedor seleciona várias fotos de uma vez).
  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const idx = dataUrl.indexOf(",");
        resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
      };
      reader.onerror = () => reject(reader.error ?? new Error("Erro ao ler arquivo"));
      reader.readAsDataURL(file);
    });

  const handleAddPhotos = async (kind: "document" | "device" | "payment", files: FileList | null) => {
    if (!files || files.length === 0 || !result) return;
    const setUploading = kind === "document" ? setUploadingDoc : kind === "device" ? setUploadingDevice : setUploadingPayment;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const base64 = await readFileAsBase64(file);
        const r = await api.tradeIn.uploadPhoto(result.id, kind, base64, file.type);
        setDocumentPhotos(r.documentPhotos);
        setDevicePhotos(r.devicePhotos);
        setPaymentProofPhotos(r.paymentProofPhotos);
      }
    } catch (err) {
      toast({ title: "Erro ao enviar foto", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleRemovePhoto = async (kind: "document" | "device" | "payment", url: string) => {
    if (!result) return;
    try {
      const r = await api.tradeIn.deletePhoto(result.id, kind, url);
      setDocumentPhotos(r.documentPhotos);
      setDevicePhotos(r.devicePhotos);
      setPaymentProofPhotos(r.paymentProofPhotos);
    } catch (err) {
      toast({ title: "Erro ao remover foto", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const escapeHtml = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

  // Abre uma janela nova com a nota de compra pronta pra imprimir (sem
  // depender de PDF/servidor — usa window.print() do próprio navegador).
  // Recebe os dados como parâmetro pra poder ser reaproveitada tanto pelo
  // fechamento ao vivo (etapa 4) quanto por uma avaliação já fechada, pelo
  // histórico (ver printNoteFromHistory).
  const printNote = (data: {
    device: string; brand: string; model: string; name: string; cpf: string; rg: string;
    address: string; neighborhood: string; phone: string;
    imei: string; price: string; dateStr: string;
    paymentMethod: string; pixKey: string; pixKeyHolder: string;
    documentPhotos?: string[]; devicePhotos?: string[]; paymentProofPhotos?: string[];
  }) => {
    const isPix = /pix/i.test(data.paymentMethod);
    const rows: [string, string][] = [
      ["Aparelho", data.device],
      ["Marca", data.brand || "—"],
      ["Modelo", data.model || "—"],
      ["Nome do vendedor", data.name || "—"],
      ["CPF", data.cpf || "—"],
      ["RG", data.rg || "—"],
      ["Endereço", data.address || "—"],
      ["Bairro", data.neighborhood || "—"],
      ["Telefone", data.phone || "—"],
      ["IMEI do aparelho", data.imei || "—"],
      ["Valor pago", data.price || "—"],
      ["Forma de pagamento", data.paymentMethod || "—"],
      ...(isPix ? ([["Chave Pix", data.pixKey || "—"], ["Titular da chave Pix", data.pixKeyHolder || "—"]] as [string, string][]) : []),
      ["Data", data.dateStr],
    ];
    // As fotos são salvas como URL relativa à raiz (ex.: "/api/chat/media/xxx"),
    // então precisam do origin da própria janela pra virar URL absoluta —
    // a janela de impressão é aberta em branco (about:blank) e não herda base URL.
    const toAbsUrl = (u: string) => (u.startsWith("http") ? u : `${window.location.origin}${u}`);
    const photoSection = (title: string, urls: string[] | undefined) => {
      if (!urls || urls.length === 0) return "";
      const imgs = urls.map((u) => `<img src="${escapeHtml(toAbsUrl(u))}" />`).join("");
      return `<div class="photos"><p class="ptitle">${escapeHtml(title)}</p><div class="pgrid">${imgs}</div></div>`;
    };
    const photosHtml = photoSection("Fotos do documento", data.documentPhotos)
      + photoSection("Fotos do aparelho", data.devicePhotos)
      + photoSection("Comprovante de pagamento", data.paymentProofPhotos);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nota de compra</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;padding:28px;color:#111}
  h1{font-size:18px;margin:0 0 2px}
  p.sub{font-size:11px;color:#666;margin:0 0 22px}
  table{width:100%;border-collapse:collapse}
  td{padding:8px 4px;border-bottom:1px solid #ddd;font-size:13px;vertical-align:top}
  td:first-child{font-weight:bold;width:38%;color:#444}
  .photos{margin-top:20px;page-break-inside:avoid}
  .photos .ptitle{font-size:12px;font-weight:bold;color:#444;margin:0 0 6px}
  .pgrid{display:flex;flex-wrap:wrap;gap:8px}
  .pgrid img{width:140px;height:140px;object-fit:cover;border:1px solid #ccc;border-radius:4px}
  .sign{margin-top:70px;display:flex;justify-content:space-between;gap:24px}
  .sign div{flex:1;text-align:center;border-top:1px solid #333;padding-top:6px;font-size:11px}
  @media print{ body{padding:0} .photos{page-break-inside:avoid} }
</style></head><body>
<h1>Nota de Compra de Aparelho Usado</h1>
<p class="sub">Sheikcell</p>
<table>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</table>
${photosHtml}
<div class="sign"><div>Assinatura do vendedor</div><div>Assinatura da loja</div></div>
</body></html>`;
    const w = window.open("", "_blank", "width=800,height=900");
    if (!w) {
      toast({ title: "Não foi possível abrir a janela de impressão", description: "Verifique se o navegador bloqueou pop-ups.", variant: "destructive" });
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.onload = () => { w.focus(); w.print(); };
  };

  // Fechamento ao vivo (etapa 4) — usa o estado atual do formulário.
  const handlePrintNote = () => {
    if (!result) return;
    printNote({
      device: result.device, brand, model, name: dealName, cpf: dealCpf, rg: dealRg, address: dealAddress,
      neighborhood: dealNeighborhood, phone: dealPhone, imei: dealImei, price: dealPrice,
      dateStr: new Date().toLocaleString("pt-BR"),
      paymentMethod: dealPaymentMethod, pixKey: dealPixKey, pixKeyHolder: dealPixKeyHolder,
      documentPhotos, devicePhotos, paymentProofPhotos,
    });
  };

  // Reimprimir a nota de uma avaliação já fechada, direto do histórico.
  const printNoteFromHistory = (h: TradeInEvaluation) => {
    printNote({
      device: h.device, brand: h.brand ?? "", model: h.model ?? "",
      name: h.sellerCustomerName ?? "", cpf: h.sellerCpf ?? "", rg: h.sellerRg ?? "",
      address: h.sellerAddress ?? "", neighborhood: h.sellerNeighborhood ?? "",
      phone: h.sellerPhone ?? "", imei: h.imei ?? "", price: h.finalAgreedPrice ?? "",
      dateStr: h.closedAt ? new Date(h.closedAt).toLocaleString("pt-BR") : new Date().toLocaleString("pt-BR"),
      paymentMethod: h.paymentMethod ?? "", pixKey: h.pixKey ?? "", pixKeyHolder: h.pixKeyHolder ?? "",
      documentPhotos: h.documentPhotos ?? [], devicePhotos: h.devicePhotos ?? [], paymentProofPhotos: h.paymentProofPhotos ?? [],
    });
  };

  // Abre o mini-formulário de "Finalizar compra" pra uma avaliação do
  // histórico. Serve pra dois casos: (1) fechar uma avaliação ainda aberta —
  // pré-preenche só o nome, com o que já foi informado na simulação; (2)
  // completar dados de uma compra JÁ fechada (ex.: IMEI que ficou de fora
  // porque o aparelho chegou com defeito) — nesse caso pré-preenche tudo com
  // o que já foi salvo, já que o endpoint de fechar é idempotente e reaplica
  // os campos.
  const openHistoryClose = (h: TradeInEvaluation) => {
    setHistClosingId(h.id);
    setHistDealName(h.sellerCustomerName || h.customerName || "");
    setHistDealCpf(h.sellerCpf ?? "");
    setHistDealImei(h.imei ?? "");
    setHistDealPrice(h.finalAgreedPrice ?? "");
    setHistDealRg(h.sellerRg ?? "");
    setHistDealAddress(h.sellerAddress ?? "");
    setHistDealNeighborhood(h.sellerNeighborhood ?? "");
    setHistDealPhone(h.sellerPhone ?? "");
    setHistDealPaymentMethod(h.paymentMethod ?? "");
    setHistDealPixKey(h.pixKey ?? "");
    setHistDealPixKeyHolder(h.pixKeyHolder ?? "");
  };

  const handleCloseFromHistory = async () => {
    if (histClosingId == null || histClosing) return;
    const name = histDealName.trim();
    const cpf = histDealCpf.trim();
    const imei = histDealImei.trim();
    const price = histDealPrice.trim();
    if (!name || !cpf || !price) {
      toast({ title: "Preencha nome, CPF e valor para fechar o negócio", variant: "destructive" });
      return;
    }
    setHistClosing(true);
    try {
      const saved = await api.tradeIn.close(histClosingId, {
        sellerCustomerName: name, sellerCpf: cpf, imei, finalAgreedPrice: price,
        sellerRg: histDealRg.trim() || undefined, sellerAddress: histDealAddress.trim() || undefined,
        sellerNeighborhood: histDealNeighborhood.trim() || undefined, sellerPhone: histDealPhone.trim() || undefined,
        paymentMethod: histDealPaymentMethod.trim() || undefined, pixKey: histDealPixKey.trim() || undefined,
        pixKeyHolder: histDealPixKeyHolder.trim() || undefined,
      });
      // Atualiza a linha na hora, sem esperar um refetch — soma ao fetchHistory()
      // (que também roda) pra manter tudo consistente com o servidor.
      setHistory((prev) => prev.map((h) => (h.id === histClosingId ? { ...h, ...saved } : h)));
      setHistClosingId(null);
      toast({ title: "Negócio fechado com sucesso" });
      fetchHistory();
    } catch (err) {
      toast({ title: "Erro ao fechar negócio", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setHistClosing(false);
    }
  };

  // Filtros do histórico: pesquisa livre (aparelho/vendedor/cliente/cor) + marca + memória.
  const brandOptions = [...new Set(history.map((h) => h.brand).filter(Boolean))] as string[];
  const memoryOptions = [...new Set(history.map((h) => h.memory).filter(Boolean))] as string[];
  const q = histSearch.trim().toLowerCase();
  const filteredHistory = history.filter((h) => {
    if (histBrand && h.brand !== histBrand) return false;
    if (histMemory && h.memory !== histMemory) return false;
    if (!q) return true;
    const hay = [h.device, h.brand, h.model, h.memory, h.color, h.userName, h.customerName, h.sellerCustomerName]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  // "Celulares comprados": só avaliações com negócio fechado (closedAt setado).
  const purchasedList = history.filter((h) => h.closedAt);
  const pq = purchSearch.trim().toLowerCase();
  const filteredPurchased = purchasedList.filter((h) => {
    if (!pq) return true;
    const hay = [h.device, h.brand, h.model, h.sellerCustomerName, h.customerName, h.sellerCpf, h.imei, h.pixKeyHolder]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(pq);
  });

  // Dashboard de compras: totais gerais + deste mês, a partir da lista
  // completa (sem o filtro da pesquisa, pra sempre mostrar o panorama real).
  const parsePriceNum = (v: string | null | undefined): number => {
    if (!v) return 0;
    const m = v.replace(/\./g, "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]!) : 0;
  };
  const now = new Date();
  const isThisMonth = (d: string | null | undefined) => {
    if (!d) return false;
    const dt = new Date(d);
    return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth();
  };
  const purchTotalValue = purchasedList.reduce((s, h) => s + parsePriceNum(h.finalAgreedPrice), 0);
  const purchThisMonth = purchasedList.filter((h) => isThisMonth(h.closedAt));
  const purchThisMonthValue = purchThisMonth.reduce((s, h) => s + parsePriceNum(h.finalAgreedPrice), 0);
  const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const purchByMethod = purchasedList.reduce<Record<string, number>>((acc, h) => {
    const key = h.paymentMethod || "Não informado";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const modelSuggestions = MODELS_BY_BRAND[brand.trim()] ?? [];
  const currentStep = step === 4 ? 4 : (result ? 3 : step);

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
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPurchased((v) => !v)} data-testid="button-toggle-tradein-purchased"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
            <Smartphone className="w-3.5 h-3.5" /> Celulares comprados
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPurchased ? "rotate-180" : ""}`} />
          </button>
          <button onClick={() => setShowHistory((v) => !v)} data-testid="button-toggle-tradein-history"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
            <History className="w-3.5 h-3.5" /> Últimas avaliações
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistory ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {/* Celulares comprados — só negócios já fechados */}
      {showPurchased && (
        <div className="shk-card p-4 space-y-3">
          {/* Dashboard: panorama geral das compras (não filtrado pela pesquisa abaixo) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-xl border border-border bg-secondary/30 p-2.5">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><LayoutDashboard className="w-3 h-3" /> Total comprado</p>
              <p className="text-lg font-extrabold mt-0.5" data-testid="text-dashboard-total-count">{purchasedList.length}</p>
            </div>
            <div className="rounded-xl border border-border bg-secondary/30 p-2.5">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><BadgeDollarSign className="w-3 h-3" /> Valor total pago</p>
              <p className="text-lg font-extrabold mt-0.5" data-testid="text-dashboard-total-value">{fmtBRL(purchTotalValue)}</p>
            </div>
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-2.5">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Este mês</p>
              <p className="text-lg font-extrabold mt-0.5 text-primary" data-testid="text-dashboard-month-count">{purchThisMonth.length}</p>
            </div>
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-2.5">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><Wallet className="w-3 h-3" /> Valor este mês</p>
              <p className="text-lg font-extrabold mt-0.5 text-primary" data-testid="text-dashboard-month-value">{fmtBRL(purchThisMonthValue)}</p>
            </div>
          </div>
          {Object.keys(purchByMethod).length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {Object.entries(purchByMethod).map(([method, count]) => (
                <span key={method} className="text-[10px] font-semibold text-muted-foreground bg-secondary/50 rounded-full px-2 py-1">
                  {method}: {count}
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <input value={purchSearch} onChange={(e) => setPurchSearch(e.target.value)}
              placeholder="🔎 Pesquisar aparelho, marca, modelo, cliente, CPF ou IMEI..."
              data-testid="input-tradein-purchased-search"
              className="flex-1 min-w-[180px] px-3 py-2 rounded-xl border border-border text-xs" />
          </div>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {filteredPurchased.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-2">
                {purchasedList.length === 0 ? "Nenhuma compra fechada ainda." : "Nada encontrado com essa pesquisa."}
              </p>
            ) : filteredPurchased.map((h) => (
              <div key={h.id} className="border-b border-border/50 pb-2 last:border-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold break-words">{h.device}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {h.sellerCustomerName ?? h.customerName ?? "Cliente não informado"} · CPF {h.sellerCpf ?? "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Comprado {h.closedAt ? new Date(h.closedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                      {h.sellerPhone ? ` · ${h.sellerPhone}` : ""}
                    </p>
                  </div>
                  <span className="text-xs font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full shrink-0">
                    {h.finalAgreedPrice ?? "—"}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {h.imei ? (
                    <span className="text-[10px] font-semibold text-muted-foreground">IMEI: {h.imei}</span>
                  ) : (
                    <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-full">
                      IMEI pendente
                    </span>
                  )}
                  {h.paymentMethod && (
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground bg-secondary/50 rounded-full px-2 py-0.5">
                      <Wallet className="w-3 h-3" /> {h.paymentMethod}
                    </span>
                  )}
                  {canEdit && histClosingId !== h.id && (
                    <button onClick={() => openHistoryClose(h)} data-testid={`button-purchased-edit-${h.id}`}
                      className="text-[10px] font-bold text-primary underline">
                      {h.imei ? "Editar dados" : "Completar IMEI"}
                    </button>
                  )}
                  <button onClick={() => printNoteFromHistory(h)} data-testid={`button-purchased-print-${h.id}`}
                    className="flex items-center gap-1 text-[10px] font-semibold text-primary">
                    <Printer className="w-3 h-3" /> Reimprimir nota
                  </button>
                </div>
                {(h.documentPhotos?.length || h.devicePhotos?.length || h.paymentProofPhotos?.length) ? (
                  <div className="flex gap-1.5 flex-wrap mt-1.5">
                    {[...(h.documentPhotos ?? []), ...(h.devicePhotos ?? []), ...(h.paymentProofPhotos ?? [])].map((url) => (
                      <img key={url} src={url} alt="" className="w-10 h-10 object-cover rounded-lg border border-border" />
                    ))}
                  </div>
                ) : null}
                {histClosingId === h.id && (
                  <div className="mt-2 p-2.5 rounded-xl border border-border bg-secondary/40 space-y-2">
                    <p className="text-[11px] font-bold">Completar dados desta compra</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input value={histDealName} onChange={(e) => setHistDealName(e.target.value)}
                        placeholder="Nome do cliente vendedor *" data-testid={`input-purchased-name-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealCpf} onChange={(e) => setHistDealCpf(e.target.value)}
                        placeholder="CPF *" data-testid={`input-purchased-cpf-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealImei} onChange={(e) => setHistDealImei(e.target.value)}
                        placeholder="IMEI (opcional)" data-testid={`input-purchased-imei-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealPrice} onChange={(e) => setHistDealPrice(e.target.value)}
                        placeholder="Valor final pago *" data-testid={`input-purchased-price-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealRg} onChange={(e) => setHistDealRg(e.target.value)}
                        placeholder="RG" data-testid={`input-purchased-rg-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealPhone} onChange={(e) => setHistDealPhone(e.target.value)}
                        placeholder="Telefone" data-testid={`input-purchased-phone-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealAddress} onChange={(e) => setHistDealAddress(e.target.value)}
                        placeholder="Endereço" data-testid={`input-purchased-address-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs sm:col-span-2" />
                      <PaymentFields testIdPrefix={`purchased-${h.id}`}
                        neighborhood={histDealNeighborhood} onNeighborhood={setHistDealNeighborhood}
                        paymentMethod={histDealPaymentMethod} onPaymentMethod={setHistDealPaymentMethod}
                        pixKey={histDealPixKey} onPixKey={setHistDealPixKey}
                        pixKeyHolder={histDealPixKeyHolder} onPixKeyHolder={setHistDealPixKeyHolder} />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleCloseFromHistory} disabled={histClosing} data-testid={`button-purchased-save-${h.id}`}
                        className="flex-1 px-3 py-2 rounded-lg bg-primary text-white text-xs font-bold disabled:opacity-40">
                        {histClosing ? "Salvando..." : "Salvar"}
                      </button>
                      <button onClick={() => setHistClosingId(null)} disabled={histClosing}
                        className="px-3 py-2 rounded-lg border border-border text-xs font-semibold">
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Histórico */}
      {showHistory && (
        <div className="shk-card p-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <input value={histSearch} onChange={(e) => setHistSearch(e.target.value)}
              placeholder="🔎 Pesquisar aparelho, cor, vendedor ou cliente..."
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
              <div key={h.id} className="border-b border-border/50 pb-2 last:border-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold break-words">{h.device}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {h.customerName ? `Cliente: ${h.customerName}` : "Cliente não informado"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Avaliado por {h.userName ?? "—"} · {new Date(h.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      {h.color ? ` · ${h.color}` : ""}
                    </p>
                  </div>
                  <span className="text-xs font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full shrink-0">
                    {h.suggestedPrice ?? "—"}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  {h.closedAt ? (
                    <>
                      <span className="text-[10px] font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full">
                        ✓ Negócio fechado{h.finalAgreedPrice ? ` · ${h.finalAgreedPrice}` : ""}
                      </span>
                      <button onClick={() => printNoteFromHistory(h)} data-testid={`button-history-print-${h.id}`}
                        className="flex items-center gap-1 text-[10px] font-semibold text-primary">
                        <Printer className="w-3 h-3" /> Reimprimir nota
                      </button>
                    </>
                  ) : canEdit ? (
                    histClosingId === h.id ? null : (
                      <button onClick={() => openHistoryClose(h)} data-testid={`button-history-finalize-${h.id}`}
                        className="text-[10px] font-bold text-primary underline">
                        Finalizar compra
                      </button>
                    )
                  ) : (
                    <span className="text-[10px] text-muted-foreground">Negócio ainda não fechado</span>
                  )}
                </div>
                {histClosingId === h.id && (
                  <div className="mt-2 p-2.5 rounded-xl border border-border bg-secondary/40 space-y-2">
                    <p className="text-[11px] font-bold">Fechar negócio desta avaliação</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input value={histDealName} onChange={(e) => setHistDealName(e.target.value)}
                        placeholder="Nome do cliente vendedor *" data-testid={`input-history-name-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealCpf} onChange={(e) => setHistDealCpf(e.target.value)}
                        placeholder="CPF *" data-testid={`input-history-cpf-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealImei} onChange={(e) => setHistDealImei(e.target.value)}
                        placeholder="IMEI (opcional)" data-testid={`input-history-imei-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealPrice} onChange={(e) => setHistDealPrice(e.target.value)}
                        placeholder="Valor final pago *" data-testid={`input-history-price-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealRg} onChange={(e) => setHistDealRg(e.target.value)}
                        placeholder="RG" data-testid={`input-history-rg-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealPhone} onChange={(e) => setHistDealPhone(e.target.value)}
                        placeholder="Telefone" data-testid={`input-history-phone-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
                      <input value={histDealAddress} onChange={(e) => setHistDealAddress(e.target.value)}
                        placeholder="Endereço" data-testid={`input-history-address-${h.id}`}
                        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs sm:col-span-2" />
                      <PaymentFields testIdPrefix={`history-${h.id}`}
                        neighborhood={histDealNeighborhood} onNeighborhood={setHistDealNeighborhood}
                        paymentMethod={histDealPaymentMethod} onPaymentMethod={setHistDealPaymentMethod}
                        pixKey={histDealPixKey} onPixKey={setHistDealPixKey}
                        pixKeyHolder={histDealPixKeyHolder} onPixKeyHolder={setHistDealPixKeyHolder} />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleCloseFromHistory} disabled={histClosing} data-testid={`button-history-close-${h.id}`}
                        className="flex-1 px-3 py-2 rounded-lg bg-primary text-white text-xs font-bold disabled:opacity-40">
                        {histClosing ? "Fechando..." : "Fechar negócio"}
                      </button>
                      <button onClick={() => setHistClosingId(null)} disabled={histClosing}
                        className="px-3 py-2 rounded-lg border border-border text-xs font-semibold">
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
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
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground mb-0.5">Nome do cliente *</p>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Nome de quem está fazendo a simulação" data-testid="input-tradein-customer-name"
              className="w-full px-3 py-2.5 rounded-xl border border-border text-sm" />
          </div>
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

          <button onClick={handleContinue} disabled={!deviceOk || !customerNameOk || loadingBase}
            data-testid="button-tradein-next"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40 transition">
            {loadingBase
              ? (<><RefreshCw className="w-4 h-4 animate-spin" /> Buscando preço base...</>)
              : "Ver preço base → Condições"}
          </button>
          {!customerNameOk ? (
            <p className="text-[11px] text-muted-foreground text-center">Informe o nome do cliente para continuar.</p>
          ) : !deviceOk && (
            <p className="text-[11px] text-muted-foreground text-center">Escolha a marca e informe o modelo para continuar.</p>
          )}
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
          <div className="flex gap-2 items-center flex-wrap">
            <button onClick={() => { setDealPrice(offerPrice(result.suggestedPrice)); setStep(4); }}
              data-testid="button-close-deal-start"
              className="text-xs font-bold text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-full transition">
              Fechar negócio
            </button>
            <button onClick={() => { setResult(null); setStep(2); }}
              className="text-xs font-semibold text-muted-foreground underline">Ajustar condições</button>
            <button onClick={resetForm} data-testid="button-tradein-new"
              className="text-xs font-semibold text-primary underline">Fazer nova avaliação</button>
          </div>
        </div>
      )}

      {currentStep === 4 && result && (
        <div className="shk-card p-5 border-2 border-green-200 bg-green-50/40 space-y-3">
          <p className="text-xs font-bold text-muted-foreground">{result.device}</p>
          {dealClosed ? (
            <div className="text-center py-4 space-y-3">
              <p className="text-sm font-bold text-green-700">Negócio fechado com sucesso!</p>
              <p className="text-xs text-muted-foreground">
                {dealName} · CPF {dealCpf} · IMEI {dealImei} · {dealPrice}
              </p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={handlePrintNote} data-testid="button-print-note"
                  className="flex items-center gap-1.5 text-xs font-bold text-white bg-primary hover:opacity-90 px-3 py-1.5 rounded-full transition">
                  <Printer className="w-3.5 h-3.5" /> Imprimir nota
                </button>
                <button onClick={resetForm} data-testid="button-tradein-new-after-close"
                  className="text-xs font-semibold text-primary underline">Fazer nova avaliação</button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">Nome do cliente vendedor</label>
                  <input value={dealName} onChange={(e) => setDealName(e.target.value)}
                    placeholder="Nome completo" data-testid="input-deal-name"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">CPF</label>
                  <input value={dealCpf} onChange={(e) => setDealCpf(e.target.value)}
                    placeholder="000.000.000-00" data-testid="input-deal-cpf"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">RG</label>
                  <input value={dealRg} onChange={(e) => setDealRg(e.target.value)}
                    placeholder="Opcional" data-testid="input-deal-rg"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">Telefone</label>
                  <input value={dealPhone} onChange={(e) => setDealPhone(e.target.value)}
                    placeholder="Opcional" data-testid="input-deal-phone"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">Endereço</label>
                  <input value={dealAddress} onChange={(e) => setDealAddress(e.target.value)}
                    placeholder="Opcional" data-testid="input-deal-address"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">Bairro</label>
                  <input value={dealNeighborhood} onChange={(e) => setDealNeighborhood(e.target.value)}
                    placeholder="Opcional" data-testid="input-deal-neighborhood"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">IMEI do aparelho</label>
                  <input value={dealImei} onChange={(e) => setDealImei(e.target.value)}
                    placeholder="Opcional — dá pra preencher depois" data-testid="input-deal-imei"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                  <p className="text-[9px] text-muted-foreground mt-0.5">Aparelho com defeito e não liga? Feche sem o IMEI e complete depois em "Celulares comprados".</p>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">Valor final negociado</label>
                  <input value={dealPrice} onChange={(e) => setDealPrice(e.target.value)}
                    placeholder="R$ 0,00" data-testid="input-deal-price"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase">Forma de pagamento</label>
                  <select value={dealPaymentMethod} onChange={(e) => setDealPaymentMethod(e.target.value)}
                    data-testid="select-deal-payment-method"
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                    <option value="">Opcional</option>
                    {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                {/pix/i.test(dealPaymentMethod) && (
                  <>
                    <div>
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Chave Pix</label>
                      <input value={dealPixKey} onChange={(e) => setDealPixKey(e.target.value)}
                        placeholder="CPF, e-mail, telefone ou aleatória" data-testid="input-deal-pix-key"
                        className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Titular da chave Pix</label>
                      <input value={dealPixKeyHolder} onChange={(e) => setDealPixKeyHolder(e.target.value)}
                        placeholder="Nome de quem recebeu" data-testid="input-deal-pix-holder"
                        className="w-full mt-1 px-3 py-2 rounded-xl border border-border text-sm" />
                    </div>
                  </>
                )}
              </div>

              {/* Fotos do documento, do aparelho e do comprovante de pagamento */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <PhotoPicker label="Fotos do documento" testId="document" photos={documentPhotos}
                  uploading={uploadingDoc} onAdd={(files) => handleAddPhotos("document", files)}
                  onRemove={(url) => handleRemovePhoto("document", url)} />
                <PhotoPicker label="Fotos do aparelho" testId="device" photos={devicePhotos}
                  uploading={uploadingDevice} onAdd={(files) => handleAddPhotos("device", files)}
                  onRemove={(url) => handleRemovePhoto("device", url)} />
                <PhotoPicker label="Comprovante de pagamento" testId="payment" photos={paymentProofPhotos}
                  uploading={uploadingPayment} onAdd={(files) => handleAddPhotos("payment", files)}
                  onRemove={(url) => handleRemovePhoto("payment", url)} />
              </div>

              <div className="flex gap-2">
                <button onClick={handleCloseDeal} disabled={closingDeal} data-testid="button-confirm-close-deal"
                  className="text-xs font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 px-4 py-2 rounded-full transition flex items-center gap-1.5">
                  {closingDeal ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
                  Confirmar fechamento
                </button>
                <button onClick={() => setStep(3)} className="text-xs font-semibold text-muted-foreground underline">Voltar</button>
              </div>
            </>
          )}
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

// Upload de fotos (documento/aparelho) com miniaturas e remoção — usado 2x
// na etapa 4 (nota de compra). 1 requisição por foto (ver saveTradeInPhoto
// no backend), então múltiplas fotos selecionadas de uma vez sobem em série.
function PhotoPicker({ label, testId, photos, uploading, onAdd, onRemove }: {
  label: string; testId: string; photos: string[]; uploading: boolean;
  onAdd: (files: FileList | null) => void; onRemove: (url: string) => void;
}) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-muted-foreground uppercase">{label}</label>
      <div className="mt-1 flex flex-wrap gap-2">
        {photos.map((url) => (
          <div key={url} className="relative w-16 h-16 rounded-lg overflow-hidden border border-border group">
            <img src={url} alt={label} className="w-full h-full object-cover" />
            <button type="button" onClick={() => onRemove(url)} title="Remover foto"
              data-testid={`button-remove-photo-${testId}`}
              className="absolute top-0.5 right-0.5 bg-black/60 hover:bg-red-600 text-white rounded-full p-0.5 transition">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <label className={`w-16 h-16 rounded-lg border-2 border-dashed border-border flex items-center justify-center cursor-pointer hover:bg-secondary transition ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
          {uploading ? <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" /> : <ImagePlus className="w-4 h-4 text-muted-foreground" />}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/heic" multiple className="hidden"
            data-testid={`input-photo-${testId}`}
            onChange={(e) => { onAdd(e.target.files); e.target.value = ""; }} />
        </label>
      </div>
    </div>
  );
}

// Bairro + forma de pagamento (e, se for Pix, chave + titular) — usado 2x nos
// mini-formulários de "finalizar/completar compra" do histórico e da aba
// "Celulares comprados" (ambos compartilham o mesmo estado histDeal*, só o
// testIdPrefix muda pra manter os data-testid únicos por linha).
function PaymentFields({ testIdPrefix, neighborhood, onNeighborhood, paymentMethod, onPaymentMethod, pixKey, onPixKey, pixKeyHolder, onPixKeyHolder }: {
  testIdPrefix: string;
  neighborhood: string; onNeighborhood: (v: string) => void;
  paymentMethod: string; onPaymentMethod: (v: string) => void;
  pixKey: string; onPixKey: (v: string) => void;
  pixKeyHolder: string; onPixKeyHolder: (v: string) => void;
}) {
  const isPix = /pix/i.test(paymentMethod);
  return (
    <>
      <input value={neighborhood} onChange={(e) => onNeighborhood(e.target.value)}
        placeholder="Bairro" data-testid={`input-${testIdPrefix}-neighborhood`}
        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
      <select value={paymentMethod} onChange={(e) => onPaymentMethod(e.target.value)}
        data-testid={`select-${testIdPrefix}-payment-method`}
        className="w-full px-2.5 py-2 rounded-lg border border-border text-xs bg-white">
        <option value="">Forma de pagamento</option>
        {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {isPix && (
        <>
          <input value={pixKey} onChange={(e) => onPixKey(e.target.value)}
            placeholder="Chave Pix" data-testid={`input-${testIdPrefix}-pix-key`}
            className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
          <input value={pixKeyHolder} onChange={(e) => onPixKeyHolder(e.target.value)}
            placeholder="Titular da chave Pix" data-testid={`input-${testIdPrefix}-pix-holder`}
            className="w-full px-2.5 py-2 rounded-lg border border-border text-xs" />
        </>
      )}
    </>
  );
}
