import { useState } from "react";
import {
  TrendingUp, AlertTriangle, CheckCircle, XCircle, DollarSign,
  Users, Target, Zap, MapPin, ShoppingBag, Radio, Star,
  BarChart2, Lightbulb, ArrowRight, Clock, Shield
} from "lucide-react";

type Tab = "resumo" | "canvas" | "viabilidade" | "financeiro" | "riscos" | "plano";

const tabs: { id: Tab; label: string }[] = [
  { id: "resumo", label: "Resumo Executivo" },
  { id: "canvas", label: "Business Model Canvas" },
  { id: "viabilidade", label: "Viabilidade" },
  { id: "financeiro", label: "Projeção Financeira" },
  { id: "riscos", label: "Riscos & Oportunidades" },
  { id: "plano", label: "Plano de Ação" },
];

const scoreColor = (score: number) => {
  if (score >= 7) return "text-green-600";
  if (score >= 5) return "text-yellow-600";
  return "text-red-500";
};

const scoreBg = (score: number) => {
  if (score >= 7) return "bg-green-100 border-green-200";
  if (score >= 5) return "bg-yellow-50 border-yellow-200";
  return "bg-red-50 border-red-200";
};

export default function AnalysisPage() {
  const [activeTab, setActiveTab] = useState<Tab>("resumo");

  return (
    <div className="min-h-screen bg-[hsl(220,20%,97%)]">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-700 to-purple-900 text-white">
        <div className="max-w-6xl mx-auto px-6 py-10">
          <div className="flex items-center gap-3 mb-2">
            <Radio className="w-7 h-7 text-purple-300" />
            <span className="text-purple-300 text-sm font-medium uppercase tracking-widest">Análise de Oportunidade de Negócio</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-2">Live Shop Regional</h1>
          <p className="text-purple-200 text-lg max-w-2xl">
            Plataforma de vendas ao vivo para empresários de Teófilo Otoni — MG, com influenciadores regionais e ecossistema de parceiros locais.
          </p>
          <div className="flex flex-wrap gap-4 mt-6">
            <div className="flex items-center gap-2 bg-white/10 rounded-lg px-4 py-2">
              <MapPin className="w-4 h-4 text-purple-300" />
              <span className="text-sm">Teófilo Otoni, MG</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 rounded-lg px-4 py-2">
              <ShoppingBag className="w-4 h-4 text-purple-300" />
              <span className="text-sm">Live Commerce B2B2C</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 rounded-lg px-4 py-2">
              <Users className="w-4 h-4 text-purple-300" />
              <span className="text-sm">Empresários Locais</span>
            </div>
          </div>
        </div>
      </div>

      {/* Score Banner */}
      <div className="bg-white border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Viabilidade Geral", score: 7.2, icon: TrendingUp },
              { label: "Potencial de Mercado", score: 8.0, icon: Target },
              { label: "Complexidade de Execução", score: 6.5, icon: Zap },
              { label: "Retorno Estimado", score: 7.5, icon: DollarSign },
            ].map(({ label, score, icon: Icon }) => (
              <div key={label} className={`rounded-xl border p-4 ${scoreBg(score)}`} data-testid={`score-${label}`}>
                <div className="flex items-center justify-between mb-1">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  <span className={`text-2xl font-bold ${scoreColor(score)}`}>{score}</span>
                </div>
                <p className="text-xs text-muted-foreground font-medium">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                data-testid={`tab-${tab.id}`}
                className={`px-4 py-4 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-purple-600 text-purple-700"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {activeTab === "resumo" && <ResumoTab />}
        {activeTab === "canvas" && <CanvasTab />}
        {activeTab === "viabilidade" && <ViabilidadeTab />}
        {activeTab === "financeiro" && <FinanceiroTab />}
        {activeTab === "riscos" && <RiscosTab />}
        {activeTab === "plano" && <PlanoTab />}
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: React.ElementType; title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-5 h-5 text-purple-600" />
        <h2 className="text-xl font-bold text-foreground">{title}</h2>
      </div>
      {subtitle && <p className="text-muted-foreground text-sm ml-7">{subtitle}</p>}
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-xl border border-border p-6 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function ResumoTab() {
  return (
    <div className="space-y-6">
      <SectionTitle icon={Star} title="Resumo Executivo" subtitle="Análise geral da oportunidade de negócio" />

      <Card className="border-l-4 border-l-purple-500">
        <h3 className="font-bold text-lg mb-2">O que é o negócio?</h3>
        <p className="text-muted-foreground leading-relaxed">
          Uma plataforma de <strong className="text-foreground">live commerce regional</strong> focada em Teófilo Otoni, MG. O modelo conecta empresários locais
          (lojistas, prestadores de serviço) com consumidores regionais por meio de transmissões ao vivo no Instagram e WhatsApp,
          utilizando influenciadores regionais como âncoras de conteúdo e vendas. A empresa opera como <strong className="text-foreground">intermediária de serviços</strong>,
          produzindo as lives, gerenciando o checkout e cobrando comissão sobre as vendas realizadas.
        </p>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-500" /> Pontos Fortes da Ideia
          </h3>
          <ul className="space-y-2">
            {[
              "Mercado regional com baixa concorrência estruturada",
              "Live commerce em crescimento acelerado no Brasil",
              "Maioria das empresas locais sem estrutura própria para lives",
              "Múltiplas fontes de receita (comissão + patrocínio + acesso)",
              "Baixo custo inicial comparado a e-commerce tradicional",
              "Canais existentes (Instagram/WhatsApp) — sem app proprietário obrigatório",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                <ArrowRight className="w-3 h-3 text-green-500 mt-0.5 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-500" /> Desafios Críticos
          </h3>
          <ul className="space-y-2">
            {[
              "Educação dos empresários: muitos desconhecem live commerce",
              "Dependência de influenciadores — risco de rotatividade",
              "Checkout/pagamento: integração técnica necessária",
              "Qualidade audiovisual consistente é essencial para conversão",
              "Ciclo de vendas B2B mais longo (conquista de empresários)",
              "Tráfego pago com custo recorrente alto para audiência regional",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                <ArrowRight className="w-3 h-3 text-yellow-500 mt-0.5 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="bg-purple-50 border-purple-200">
        <h3 className="font-bold text-purple-800 mb-2">Veredicto da Análise</h3>
        <p className="text-purple-700 leading-relaxed text-sm">
          A ideia tem <strong>viabilidade real e timing favorável</strong>. O live commerce cresce no Brasil, mas ainda não chegou estruturado
          às cidades do interior de MG. Quem chegar primeiro em Teófilo Otoni com execução consistente pode dominar o mercado local
          nos próximos 2-3 anos. O maior risco não é a ideia — é a execução operacional: qualidade das lives,
          relacionamento com empresários e consistência na geração de audiência. <strong>Recomendação: avançar com MVP controlado.</strong>
        </p>
      </Card>
    </div>
  );
}

function CanvasTab() {
  const blocks = [
    {
      title: "Parceiros-Chave",
      color: "bg-blue-50 border-blue-200",
      headerColor: "text-blue-700",
      items: [
        "Influenciadores regionais",
        "Bares e restaurantes (divulgação)",
        "Patrocinadores locais",
        "Plataformas: Instagram, WhatsApp",
        "Fornecedores de equipamento AV",
        "Gateway de pagamento (Mercado Pago, PagBank)",
      ],
    },
    {
      title: "Atividades-Chave",
      color: "bg-purple-50 border-purple-200",
      headerColor: "text-purple-700",
      items: [
        "Negociação com empresários",
        "Criação e operação das lives",
        "Produção audiovisual",
        "Gestão de tráfego pago",
        "Operação do checkout",
        "Curadoria de influenciadores",
      ],
    },
    {
      title: "Proposta de Valor",
      color: "bg-green-50 border-green-200",
      headerColor: "text-green-700",
      items: [
        "Visibilidade digital para negócios locais",
        "Vendas acima da média sem estrutura própria",
        "Posicionamento de marca regional",
        "Live commerce completo e gerenciado",
        "Audiência qualificada e segmentada",
      ],
    },
    {
      title: "Relacionamento c/ Clientes",
      color: "bg-orange-50 border-orange-200",
      headerColor: "text-orange-700",
      items: [
        "Atendimento consultivo presencial",
        "Relatórios de desempenho pós-live",
        "Suporte via WhatsApp",
        "Reuniões de resultado mensais",
      ],
    },
    {
      title: "Segmentos de Clientes",
      color: "bg-red-50 border-red-200",
      headerColor: "text-red-700",
      items: [
        "Lojistas e varejistas de TO",
        "Prestadores de serviço local",
        "Restaurantes e alimentação",
        "Moda, bijuterias, calçados",
        "Patrocinadores regionais",
        "Consumidores finais (B2C)",
      ],
    },
    {
      title: "Recursos-Chave",
      color: "bg-yellow-50 border-yellow-200",
      headerColor: "text-yellow-700",
      items: [
        "Equipe de produção audiovisual",
        "Rede de influenciadores regionais",
        "Plataforma/sistema de checkout",
        "Audiência nas redes sociais",
        "Relacionamento com empresários",
      ],
    },
    {
      title: "Canais",
      color: "bg-indigo-50 border-indigo-200",
      headerColor: "text-indigo-700",
      items: [
        "Instagram Live (canal principal)",
        "WhatsApp (vendas e suporte)",
        "Prospecção presencial B2B",
        "Indicações e parcerias",
        "Tráfego pago (Meta Ads)",
      ],
    },
    {
      title: "Estrutura de Custos",
      color: "bg-gray-50 border-gray-200",
      headerColor: "text-gray-700",
      items: [
        "Criação da plataforma / checkout",
        "Produção audiovisual (equipamentos)",
        "Tráfego pago (Meta Ads)",
        "Pagamento de influenciadores",
        "Salários equipe operacional",
        "Infraestrutura de internet",
      ],
    },
    {
      title: "Fontes de Receita",
      color: "bg-teal-50 border-teal-200",
      headerColor: "text-teal-700",
      items: [
        "Comissão sobre vendas (10-20%)",
        "Patrocínio de lives",
        "Pacotes de acesso/assinatura",
        "Tráfego pago gerenciado",
        "Produção avulsa de conteúdo",
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle icon={BarChart2} title="Business Model Canvas" subtitle="Mapeamento dos 9 blocos do modelo de negócio" />
      <div className="grid md:grid-cols-3 gap-4">
        {blocks.map((block) => (
          <div key={block.title} className={`rounded-xl border p-4 ${block.color}`}>
            <h3 className={`font-bold text-sm mb-3 ${block.headerColor}`}>{block.title}</h3>
            <ul className="space-y-1">
              {block.items.map((item) => (
                <li key={item} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <span className="text-muted-foreground mt-0.5">•</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function ViabilidadeTab() {
  const criteria = [
    {
      name: "Tamanho do Mercado Local",
      score: 7,
      comment: "TO tem ~140k hab. e economia ativa (pedras preciosas, comércio). Mercado expressivo para o interior.",
    },
    {
      name: "Demanda por Live Commerce",
      score: 8,
      comment: "Tendência nacional crescente. Interior ainda pouco explorado — janela de oportunidade aberta.",
    },
    {
      name: "Concorrência Direta",
      score: 9,
      comment: "Quase inexistente com estrutura profissional em TO. Vantagem de first-mover clara.",
    },
    {
      name: "Capacidade de Execução",
      score: 6,
      comment: "Requer equipe multidisciplinar (AV, vendas, influencers). Complexidade operacional média-alta.",
    },
    {
      name: "Modelo de Receita",
      score: 7,
      comment: "3 fontes de receita é positivo. Comissão depende de volume. Patrocínio requer audiência consolidada.",
    },
    {
      name: "Tecnologia Necessária",
      score: 7,
      comment: "Checkout integrável via soluções prontas (Mercado Pago, PagBank). Não exige plataforma do zero.",
    },
    {
      name: "Custo de Aquisição de Clientes",
      score: 6,
      comment: "B2B requer visitas e educação. Empresários mais conservadores — ciclo de venda mais longo.",
    },
    {
      name: "Sustentabilidade do Modelo",
      score: 7,
      comment: "Com volume, margem cresce. Risco: sazonalidade e dependência de influenciadores.",
    },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle icon={CheckCircle} title="Análise de Viabilidade" subtitle="Pontuação por critério (0-10)" />
      <div className="space-y-3">
        {criteria.map((c) => (
          <Card key={c.name} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-sm">{c.name}</h3>
              <span className={`text-lg font-bold ${scoreColor(c.score)}`}>{c.score}/10</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
              <div
                className={`h-2 rounded-full ${c.score >= 7 ? "bg-green-500" : c.score >= 5 ? "bg-yellow-400" : "bg-red-400"}`}
                style={{ width: `${c.score * 10}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{c.comment}</p>
          </Card>
        ))}
      </div>

      <Card className="bg-green-50 border-green-200">
        <h3 className="font-bold text-green-800 mb-2 flex items-center gap-2">
          <Lightbulb className="w-4 h-4" /> Conclusão de Viabilidade
        </h3>
        <p className="text-green-700 text-sm leading-relaxed">
          Média ponderada de <strong>7.1/10</strong> — negócio viável com execução disciplinada.
          O diferencial competitivo mais forte é o timing: o live commerce está crescendo,
          a concorrência local é fraca e a demanda dos consumidores por compras digitais regionais existe.
          A execução precisa priorizar qualidade de produção e conquista dos primeiros clientes empresariais.
        </p>
      </Card>
    </div>
  );
}

function FinanceiroTab() {
  const custos = [
    { item: "Equipamento AV (câmera, iluminação, microfone)", valor: "R$ 5.000 - 12.000", tipo: "Único" },
    { item: "Desenvolvimento plataforma / checkout", valor: "R$ 3.000 - 8.000", tipo: "Único" },
    { item: "Tráfego pago mensal (Meta Ads)", valor: "R$ 1.500 - 3.000", tipo: "Mensal" },
    { item: "Influenciadores regionais", valor: "R$ 800 - 2.000", tipo: "Mensal" },
    { item: "Equipe operacional (1-2 pessoas)", valor: "R$ 2.500 - 4.000", tipo: "Mensal" },
    { item: "Internet (fibra dedicada)", valor: "R$ 300 - 500", tipo: "Mensal" },
  ];

  const projecao = [
    { mes: "Mês 1-3", clientes: "2-4", faturamento: "R$ 2.000 - 5.000", lucro: "Negativo (estruturação)" },
    { mes: "Mês 4-6", clientes: "5-10", faturamento: "R$ 5.000 - 12.000", lucro: "Ponto de equilíbrio" },
    { mes: "Mês 7-12", clientes: "10-20", faturamento: "R$ 12.000 - 30.000", lucro: "Positivo (R$ 3-8k)" },
    { mes: "Ano 2", clientes: "20-40", faturamento: "R$ 30.000 - 60.000", lucro: "Positivo (R$ 10-20k)" },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle icon={DollarSign} title="Projeção Financeira" subtitle="Estimativas conservadoras para os primeiros 24 meses" />

      <Card>
        <h3 className="font-bold mb-4">Investimento Inicial Estimado</h3>
        <div className="space-y-3">
          {custos.filter((c) => c.tipo === "Único").map((c) => (
            <div key={c.item} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <span className="text-sm text-muted-foreground">{c.item}</span>
              <div className="text-right">
                <span className="text-sm font-semibold">{c.valor}</span>
                <span className="text-xs text-muted-foreground ml-2">({c.tipo})</span>
              </div>
            </div>
          ))}
          <div className="pt-2 border-t-2 border-purple-200 flex items-center justify-between">
            <span className="font-bold">Total Investimento Inicial</span>
            <span className="font-bold text-purple-700">R$ 8.000 - 20.000</span>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-bold mb-4">Custos Operacionais Mensais</h3>
        <div className="space-y-3">
          {custos.filter((c) => c.tipo === "Mensal").map((c) => (
            <div key={c.item} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <span className="text-sm text-muted-foreground">{c.item}</span>
              <span className="text-sm font-semibold">{c.valor}</span>
            </div>
          ))}
          <div className="pt-2 border-t-2 border-purple-200 flex items-center justify-between">
            <span className="font-bold">Total Mensal (estimado)</span>
            <span className="font-bold text-purple-700">R$ 5.100 - 9.500</span>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-bold mb-4">Projeção de Crescimento</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 rounded-lg">
                <th className="text-left p-3 font-semibold text-muted-foreground">Período</th>
                <th className="text-left p-3 font-semibold text-muted-foreground">Clientes Ativos</th>
                <th className="text-left p-3 font-semibold text-muted-foreground">Faturamento</th>
                <th className="text-left p-3 font-semibold text-muted-foreground">Lucro Líquido</th>
              </tr>
            </thead>
            <tbody>
              {projecao.map((row, i) => (
                <tr key={row.mes} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="p-3 font-medium">{row.mes}</td>
                  <td className="p-3 text-muted-foreground">{row.clientes}</td>
                  <td className="p-3 text-green-700 font-medium">{row.faturamento}</td>
                  <td className={`p-3 font-medium ${row.lucro.includes("Negativo") ? "text-red-500" : row.lucro.includes("equilíbrio") ? "text-yellow-600" : "text-green-600"}`}>{row.lucro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="bg-yellow-50 border-yellow-200">
        <h3 className="font-bold text-yellow-800 mb-2">Modelo de Comissão — Como funciona a receita</h3>
        <div className="grid grid-cols-3 gap-4 text-center mt-3">
          {[
            { label: "Live com R$ 10.000 em vendas", comissao: "R$ 1.500 - 2.000", perc: "15-20%" },
            { label: "5 lives/mês nesse volume", comissao: "R$ 7.500 - 10.000", perc: "Mensal" },
            { label: "Break-even estimado", comissao: "~R$ 40k em vendas/mês", perc: "Mês 4-6" },
          ].map((item) => (
            <div key={item.label} className="bg-white rounded-lg p-3 border border-yellow-200">
              <p className="text-xs text-muted-foreground mb-1">{item.label}</p>
              <p className="font-bold text-yellow-800">{item.comissao}</p>
              <p className="text-xs text-yellow-600">{item.perc}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function RiscosTab() {
  const riscos = [
    {
      titulo: "Saída de Influenciadores",
      nivel: "alto",
      descricao: "Influenciador parceiro pode sair ou cobrar muito mais. Dependência perigosa.",
      mitigacao: "Ter 3-5 influenciadores ativos simultaneamente. Contratos com carência. Formar banco de talentos.",
    },
    {
      titulo: "Resistência dos Empresários",
      nivel: "alto",
      descricao: "Empresários conservadores podem rejeitar o formato ou desistir após 1-2 lives sem resultado imediato.",
      mitigacao: "Oferecer piloto com resultado garantido ou risco zero. Cases de sucesso desde a 1a live.",
    },
    {
      titulo: "Qualidade de Produção",
      nivel: "medio",
      descricao: "Live com má qualidade audiovisual prejudica a marca do cliente e a reputação da empresa.",
      mitigacao: "Investir em equipe e equipamento antes de escalar. Checklist de qualidade por live.",
    },
    {
      titulo: "Custo de Tráfego Pago",
      nivel: "medio",
      descricao: "Meta Ads pode ficar caro com pouco retorno em mercado pequeno.",
      mitigacao: "Priorizar audiência orgânica e parcerias. Usar tráfego pago só para lives específicas.",
    },
    {
      titulo: "Checkout / Pagamentos",
      nivel: "medio",
      descricao: "Problemas técnicos durante uma live podem arruinar a experiência e perder vendas.",
      mitigacao: "Usar solução consolidada (Mercado Pago), testar sempre antes. Plano B com link de venda manual.",
    },
    {
      titulo: "Sazonalidade",
      nivel: "baixo",
      descricao: "Datas comemorativas geram picos. Meses fracos podem comprometer o fluxo de caixa.",
      mitigacao: "Diversificar segmentos de clientes. Criar calendário anual com antecedência.",
    },
  ];

  const oportunidades = [
    "Expansão para cidades vizinhas (Governador Valadares, Caratinga) após consolidar TO",
    "Live para segmento de gemas e pedras — TO é capital nacional, enorme potencial",
    "Parceria com prefeitura para lives de economia local e turismo",
    "Venda de cursos e mentorias para outros empreendedores de interior replicarem o modelo",
    "Franquiar o modelo operacional para outras cidades do interior de MG",
    "Expansão para TikTok Live (crescimento acelerado no Brasil)",
  ];

  const nivelColor = (nivel: string) => {
    if (nivel === "alto") return "bg-red-100 text-red-700 border-red-200";
    if (nivel === "medio") return "bg-yellow-100 text-yellow-700 border-yellow-200";
    return "bg-green-100 text-green-700 border-green-200";
  };

  return (
    <div className="space-y-6">
      <SectionTitle icon={Shield} title="Riscos e Oportunidades" subtitle="Análise completa para tomada de decisão" />

      <div>
        <h3 className="font-bold mb-4 text-red-600 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> Riscos Identificados
        </h3>
        <div className="space-y-3">
          {riscos.map((r) => (
            <Card key={r.titulo} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-sm">{r.titulo}</h4>
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${nivelColor(r.nivel)}`}>
                      {r.nivel.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{r.descricao}</p>
                  <div className="bg-green-50 border border-green-100 rounded-lg p-2">
                    <p className="text-xs text-green-700"><strong>Mitigacao:</strong> {r.mitigacao}</p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-bold mb-4 text-green-600 flex items-center gap-2">
          <TrendingUp className="w-4 h-4" /> Oportunidades de Expansão
        </h3>
        <Card>
          <ul className="space-y-3">
            {oportunidades.map((op, i) => (
              <li key={op} className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs flex items-center justify-center font-bold shrink-0">
                  {i + 1}
                </span>
                <span className="text-sm text-muted-foreground">{op}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function PlanoTab() {
  const fases = [
    {
      fase: "Fase 1 — Estruturação",
      periodo: "Meses 1-2",
      cor: "border-purple-400 bg-purple-50",
      tituloCor: "text-purple-800",
      acoes: [
        "Definir e contratar 2-3 influenciadores regionais parceiros",
        "Adquirir equipamento de produção básico (câmera, ring light, microfone)",
        "Configurar checkout com Mercado Pago ou PagBank",
        "Criar perfil profissional nas redes e identidade visual da marca",
        "Prospectar 3-5 empresários para o projeto piloto",
        "Definir o modelo de contrato e comissão",
      ],
    },
    {
      fase: "Fase 2 — Piloto",
      periodo: "Meses 2-4",
      cor: "border-blue-400 bg-blue-50",
      tituloCor: "text-blue-800",
      acoes: [
        "Realizar primeiras 3-5 lives com empresários selecionados",
        "Documentar resultados e gerar cases de sucesso",
        "Testar diferentes formatos de live (demonstração, promoção, Q&A)",
        "Iniciar tráfego pago controlado (R$ 500-1.000/mês)",
        "Criar grupo de WhatsApp para audiência fiel",
        "Ajustar modelo de precificação baseado no piloto",
      ],
    },
    {
      fase: "Fase 3 — Escala",
      periodo: "Meses 4-8",
      cor: "border-green-400 bg-green-50",
      tituloCor: "text-green-800",
      acoes: [
        "Escalar para 10-15 clientes empresariais ativos",
        "Estruturar equipe: produtor + gestor de tráfego + vendedor B2B",
        "Lançar pacotes formalizados de patrocínio",
        "Criar calendário mensal de lives por segmento",
        "Desenvolver plataforma própria de checkout (se viável)",
        "Buscar patrocinadores âncora para lives mensais",
      ],
    },
    {
      fase: "Fase 4 — Consolidação",
      periodo: "Meses 8-12",
      cor: "border-orange-400 bg-orange-50",
      tituloCor: "text-orange-800",
      acoes: [
        "Consolidar marca como referência em live commerce regional",
        "Avaliar expansão para cidades vizinhas",
        "Explorar segmento de gemas e pedras preciosas de TO",
        "Criar programa de fidelidade para empresários parceiros",
        "Desenvolver treinamento para replicação do modelo",
        "Prospectar investidor ou parceiro estratégico",
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <SectionTitle icon={Clock} title="Plano de Acao" subtitle="Roadmap executivo para os primeiros 12 meses" />

      <div className="space-y-4">
        {fases.map((f) => (
          <div key={f.fase} className={`rounded-xl border-l-4 p-5 ${f.cor}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-bold ${f.tituloCor}`}>{f.fase}</h3>
              <span className="text-xs bg-white px-3 py-1 rounded-full border font-medium text-muted-foreground">{f.periodo}</span>
            </div>
            <ul className="space-y-2">
              {f.acoes.map((acao) => (
                <li key={acao} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CheckCircle className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
                  {acao}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <Card className="bg-purple-700 text-white border-0">
        <h3 className="font-bold text-lg mb-2">Proximos Passos Imediatos</h3>
        <p className="text-purple-200 text-sm mb-4">Para sair da analise e partir para a execucao esta semana:</p>
        <ul className="space-y-2">
          {[
            "Listar 5 empresarios locais que voce ja conhece para abordar",
            "Mapear 3 influenciadores regionais com mais de 5k seguidores em TO",
            "Pesquisar precos de equipamento AV basico (orçamento em 3 lojas)",
            "Criar conta business no Instagram e perfil da empresa",
            "Definir o nome e a identidade visual do negocio",
          ].map((step, i) => (
            <li key={step} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-white/20 text-white text-xs flex items-center justify-center font-bold shrink-0">
                {i + 1}
              </span>
              <span className="text-purple-100 text-sm">{step}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
