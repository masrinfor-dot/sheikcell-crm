import { useState, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  api, API_BASE, canEditModule,
  type RhStage, type RhQuestion, type RhCandidate, type RhPosition, type RhProfileType,
  type Employee, type WorkShift, type TimeClockEntry, type TimeBankResult, type TimeBankSummaryRow, type LeaveRecord, type TimeBankClosure,
  type Store, type User, type EmployeeDocument, type EmployeeContractTemplate, type VacationRequest,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Settings2, Copy, RefreshCw, Plus, Trash2, X, CheckCircle, XCircle,
  Video, ChevronDown, ChevronUp, Save, Link2, UserSquare2, CalendarClock, Clock, Wallet, Pencil, Archive, PlayCircle,
  AlertTriangle, Image as ImageIcon, Smartphone, Printer, Star, Briefcase, Sparkles, MapPin,
  Upload, Download, FileText, FolderArchive, UserPlus, FileSignature, Eye, IdCard, RotateCcw, Palmtree,
} from "lucide-react";

// Perfil comportamental (estilo DISC simplificado, 4 tipos definidos pelo
// lojista) — calculado automaticamente a partir das respostas da(s)
// pergunta(s) de teste de perfil (ver optionProfiles/computeProfileResult no
// backend, rh.ts). Textos exatamente como definidos pelo lojista.
const PROFILE_TYPES: RhProfileType[] = ["analitico", "dominante", "apoiador", "inovador"];
const PROFILE_META: Record<RhProfileType, {
  label: string; emoji: string; cls: string;
  foco: string; pontosFortes: string; desafios: string; motivacao: string;
}> = {
  analitico: {
    label: "Analítico", emoji: "📊", cls: "bg-blue-50 text-blue-700 border-blue-200",
    foco: "Precisão, dados e fatos.",
    pontosFortes: "Organização, atenção aos detalhes e qualidade.",
    desafios: "Perfeccionismo e lentidão para decidir.",
    motivacao: "Processos claros e tarefas lógicas.",
  },
  dominante: {
    label: "Dominante", emoji: "🎯", cls: "bg-red-50 text-red-700 border-red-200",
    foco: "Resultados, metas e velocidade.",
    pontosFortes: "Determinação, liderança e foco em soluções.",
    desafios: "Impaciência e autoritarismo.",
    motivacao: "Desafios, autonomia e poder de decisão.",
  },
  apoiador: {
    label: "Apoiador", emoji: "🤝", cls: "bg-green-50 text-green-700 border-green-200",
    foco: "Pessoas, harmonia e ritmo constante.",
    pontosFortes: "Empatia, lealdade e bom ouvinte.",
    desafios: "Resistência a mudanças e dificuldade em dizer não.",
    motivacao: "Ambientes seguros e colaboração.",
  },
  inovador: {
    label: "Inovador", emoji: "💡", cls: "bg-amber-50 text-amber-700 border-amber-200",
    foco: "Ideias, criatividade e conexões.",
    pontosFortes: "Comunicação, otimismo e adaptabilidade.",
    desafios: "Falta de foco e desorganização com prazos.",
    motivacao: "Reconhecimento social e liberdade para criar.",
  },
};

const STATUS_META: Record<RhCandidate["status"], { label: string; cls: string }> = {
  novo: { label: "Novo", cls: "bg-blue-50 text-blue-600 border-blue-100" },
  pre_aprovado: { label: "Pré-aprovado", cls: "bg-indigo-50 text-indigo-600 border-indigo-100" },
  aprovado: { label: "Aprovado", cls: "bg-green-50 text-green-700 border-green-100" },
  reprovado: { label: "Reprovado", cls: "bg-red-50 text-red-600 border-red-100" },
};

// Motivos rápidos pra registrar junto da troca de status (pedido 11/09:
// "criar motivo para pre aprovação, aprovado e reprovado"). "Outro" sempre
// último, abre campo de texto livre (mesmo padrão de finalizeReasonOptions
// no Chat) — nenhum motivo é obrigatório, só ajuda a não deixar solto.
const STATUS_REASON_OPTIONS: Record<Exclude<RhCandidate["status"], "novo">, string[]> = {
  pre_aprovado: ["Foi bem na pré-entrevista", "Perfil alinhado com a vaga", "Aguardando segunda etapa/entrevista"],
  aprovado: ["Foi bem na entrevista", "Perfil ideal para a vaga", "Referências confirmadas"],
  reprovado: ["Não compareceu à entrevista", "Falta de conta bancária", "Perfil não alinhado com a vaga", "Pretensão salarial incompatível", "Já contratado por outra vaga"],
};

// Roteiro fixo da entrevista online (Google Meet) — pedido 11/09: "criar
// roteiro de perguntas para entrevista virtual, confirmação de dados
// pessoais, perguntas sobre perfil, experiência e motivo de querer
// trabalhar". Cada pergunta tem uma anotação (texto livre) preenchida em
// tempo real durante a ligação — ver interviewNotes em RhCandidate.
const INTERVIEW_SCRIPT: { category: string; questions: { id: string; label: string }[] }[] = [
  {
    category: "Confirmação de dados pessoais",
    questions: [
      { id: "confirma_nome", label: "Confirme seu nome completo e telefone." },
      { id: "confirma_endereco", label: "Você mora no bairro/cidade que informou na candidatura?" },
      { id: "confirma_disponibilidade", label: "Tem disponibilidade para o horário/escala da vaga?" },
    ],
  },
  {
    category: "Perfil",
    questions: [
      { id: "perfil_descricao", label: "Como você se descreveria em 3 palavras?" },
      { id: "perfil_pressao", label: "Como você lida com pressão ou prazo apertado?" },
      { id: "perfil_equipe", label: "Prefere trabalhar em equipe ou individualmente? Por quê?" },
    ],
  },
  {
    category: "Experiência",
    questions: [
      { id: "exp_recente", label: "Fale sobre sua experiência profissional mais recente." },
      { id: "exp_vendas", label: "Já trabalhou com vendas/atendimento ao cliente? Como foi?" },
      { id: "exp_desafio", label: "Conte uma situação difícil no trabalho e como resolveu." },
    ],
  },
  {
    category: "Motivo de querer trabalhar aqui",
    questions: [
      { id: "motivo_vaga", label: "Por que você quer trabalhar nessa vaga/empresa?" },
      { id: "motivo_atrai", label: "O que mais te atrai nessa oportunidade?" },
    ],
  },
];

const CONTRACT_LABELS: Record<string, string> = { clt: "CLT", pj: "PJ", estagio: "Estágio" };
const LEAVE_LABELS: Record<string, string> = {
  ferias: "Férias", atestado: "Atestado", falta_justificada: "Falta justificada",
  falta_injustificada: "Falta injustificada", outro: "Outro",
};
const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const VIDEO_SECONDS_PRESETS = [30, 60, 120, 180, 300, 600];

function formatMinutes(mins: number): string {
  const sign = mins < 0 ? "-" : "";
  const abs = Math.abs(Math.round(mins));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}h${m.toString().padStart(2, "0")}`;
}

// Data civil no fuso America/Sao_Paulo (não UTC) — mesma convenção do
// backend (ver dayKeySaoPaulo em lib/timeBank.ts), evita desalinhar a janela
// "hoje"/"este mês" perto da virada de dia.
function todayStr(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }
function firstOfMonthStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}-01`;
}

// Aba "RH": Recrutamento (processo seletivo já existente) + Departamento
// Pessoal (colaboradores, escalas, ponto, banco de horas, afastamentos) —
// mesmo módulo/permissão (moduleAccess.rh), duas frentes na mesma tela.
export default function RH() {
  const { user } = useAuth();
  const canEdit = canEditModule(user, "rh");
  const [group, setGroup] = useState<"recrutamento" | "dp">("recrutamento");
  const [dpView, setDpView] = useState<"colaboradores" | "escalas" | "ponto" | "banco-horas" | "afastamentos" | "ferias" | "fechamentos">("colaboradores");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2"><Users className="w-5 h-5 text-primary" /> RH</h2>
        <div className="flex gap-1.5">
          <button onClick={() => setGroup("recrutamento")} data-testid="button-rh-group-recrutamento"
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${group === "recrutamento" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
            Recrutamento
          </button>
          <button onClick={() => setGroup("dp")} data-testid="button-rh-group-dp"
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${group === "dp" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
            Departamento Pessoal
          </button>
        </div>
      </div>

      {group === "recrutamento" ? (
        <Recrutamento canEdit={canEdit} />
      ) : (
        <div className="space-y-4">
          <div className="flex gap-1.5 flex-wrap">
            {([
              { key: "colaboradores", label: "Colaboradores", icon: UserSquare2 },
              { key: "escalas", label: "Escalas", icon: CalendarClock },
              { key: "ponto", label: "Registros de Ponto", icon: Clock },
              { key: "banco-horas", label: "Banco de horas", icon: Wallet },
              { key: "afastamentos", label: "Afastamentos", icon: CalendarClock },
              { key: "ferias", label: "Férias", icon: Palmtree },
              { key: "fechamentos", label: "Fechamentos", icon: Archive },
            ] as const).map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => setDpView(key)} data-testid={`button-dp-${key}`}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${dpView === key ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>
          {dpView === "colaboradores" && <Colaboradores canEdit={canEdit} />}
          {dpView === "escalas" && <Escalas canEdit={canEdit} />}
          {dpView === "ponto" && <PontoAdmin canEdit={canEdit} isAdmin={user?.role === "admin"} />}
          {dpView === "banco-horas" && <BancoHoras canEdit={canEdit} />}
          {dpView === "afastamentos" && <Afastamentos canEdit={canEdit} />}
          {dpView === "ferias" && <Ferias canEdit={canEdit} />}
          {dpView === "fechamentos" && <Fechamentos canEdit={canEdit} />}
        </div>
      )}
    </div>
  );
}

// Histórico de candidaturas repetidas: junta candidatos que são a mesma
// pessoa se candidatando de novo (CPF, telefone ou e-mail em comum). Não
// existe coluna de CPF na tabela — o processo é configurável pelo admin, então
// procuramos por qualquer pergunta cujo rótulo contenha "cpf" nas etapas
// daquela candidatura específica (stagesSnapshot, já congelado por resposta).
// Puramente visual: cada candidatura continua sendo seu próprio registro, sem
// nenhuma escrita no banco.
function onlyDigits(v: string): string {
  return v.replace(/\D/g, "");
}

function extractCpf(c: RhCandidate): string | null {
  // CPF é obrigatório desde a personalização por cargo — candidaturas novas
  // sempre têm a coluna preenchida. O scan abaixo é só fallback pra
  // candidatura de antes desta feature, quando CPF era só mais uma pergunta
  // solta no processo (se a loja tivesse configurado uma).
  if (c.cpf && c.cpf.length === 11) return c.cpf;
  if (!c.stagesSnapshot) return null;
  for (const stage of c.stagesSnapshot) {
    for (const q of stage.questions) {
      if (!/cpf/i.test(q.label)) continue;
      const raw = c.answers[stage.id]?.[q.id];
      const digits = raw ? onlyDigits(raw) : "";
      if (digits.length === 11) return digits;
    }
  }
  return null;
}

function candidatePersonKeys(c: RhCandidate): string[] {
  const keys: string[] = [];
  const cpf = extractCpf(c);
  if (cpf) keys.push(`cpf:${cpf}`);
  const phoneDigits = onlyDigits(c.phone);
  if (phoneDigits.length >= 8) keys.push(`tel:${phoneDigits}`);
  if (c.email && c.email.trim()) keys.push(`mail:${c.email.trim().toLowerCase()}`);
  return keys;
}

// Union-Find simples: agrupa candidaturas que compartilham qualquer chave
// (CPF, telefone ou e-mail) — a mesma pessoa pode ter preenchido os dados de
// forma levemente diferente entre uma tentativa e outra.
function groupCandidatesByPerson(list: RhCandidate[]): Map<number, RhCandidate[]> {
  const parent = new Map<number, number>();
  for (const c of list) parent.set(c.id, c.id);
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const byKey = new Map<string, number[]>();
  for (const c of list) {
    for (const k of candidatePersonKeys(c)) {
      const arr = byKey.get(k) ?? [];
      arr.push(c.id);
      byKey.set(k, arr);
    }
  }
  for (const ids of byKey.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);
  }
  const groups = new Map<number, RhCandidate[]>();
  for (const c of list) {
    const root = find(c.id);
    const arr = groups.get(root) ?? [];
    arr.push(c);
    groups.set(root, arr);
  }
  return groups;
}

// ── Recrutamento (processo seletivo, já existia) ────────────────────────────
function Recrutamento({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [view, setView] = useState<"candidatos" | "processo" | "contratacoes">("candidatos");
  // Colaborador cuja contratação deve abrir automaticamente assim que a
  // view "Contratações" montar (setado ao clicar "Iniciar contratação" no
  // candidato aprovado) — consumido uma vez pelo componente Contratacoes.
  const [hiringToOpen, setHiringToOpen] = useState<number | null>(null);
  const [startingHiring, setStartingHiring] = useState(false);
  const [token, setToken] = useState("");
  const [stages, setStages] = useState<RhStage[]>([]);
  const [candidates, setCandidates] = useState<RhCandidate[]>([]);
  const [opened, setOpened] = useState<RhCandidate | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"todos" | RhCandidate["status"]>("todos");
  // Filtro por cidade/bairro — só faz sentido pra quem tem esses campos
  // preenchidos (candidatura a partir de 08/09; ver Candidatura.tsx). "todas"/
  // "todos" = sem filtro. Trocar a cidade reseta o bairro (a lista de bairros
  // é sempre relativa à cidade escolhida, pra não misturar bairro de cidades
  // diferentes com nome parecido).
  const [cityFilter, setCityFilter] = useState<string>("todas");
  const [bairroFilter, setBairroFilter] = useState<string>("todos");
  // Filtro por vaga/cargo escolhido pelo candidato (ex: "Técnico Vendedor") —
  // mesmo padrão do filtro de cidade/bairro. "todas" = sem filtro.
  const [positionFilter, setPositionFilter] = useState<string>("todas");
  const [notesDraft, setNotesDraft] = useState("");
  const [expandedHistory, setExpandedHistory] = useState<Set<number>>(new Set());
  // Motivo da troca de status (pré-aprovar/aprovar/reprovar) — abre um
  // seletor de motivos rápidos + "Outro" antes de confirmar a troca de fato.
  const [pendingStatusChange, setPendingStatusChange] = useState<{ status: Exclude<RhCandidate["status"], "novo">; reason: string; customReason: string } | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);
  // Anotações da entrevista online (Meet) — rascunho local por pergunta do
  // roteiro fixo (ver INTERVIEW_SCRIPT), carregado do candidato aberto e
  // salvo manualmente (mesmo padrão de notesDraft/saveNotes acima).
  const [interviewDraft, setInterviewDraft] = useState<Record<string, string>>({});
  const [savingInterview, setSavingInterview] = useState(false);

  // Cargos (item: processo seletivo personalizado por função). Sem nenhum
  // cargo cadastrado, o processo é o único de sempre (stages acima). Assim
  // que existe 1+ cargo, o link público passa a pedir a escolha da vaga.
  const [positions, setPositions] = useState<RhPosition[]>([]);
  const [editingPositionId, setEditingPositionId] = useState<number | null>(null);
  const [positionDraft, setPositionDraft] = useState<{ name: string; active: boolean; stages: RhStage[] } | null>(null);
  const [savingPosition, setSavingPosition] = useState(false);
  const [newPositionName, setNewPositionName] = useState("");
  const [creatingPosition, setCreatingPosition] = useState(false);

  useEffect(() => {
    api.rh.settings().then((s) => { setToken(s.publicToken); setStages(s.stages); }).catch(() => {});
    api.rh.candidates().then(setCandidates).catch(() => {});
    api.rh.positions.list().then(setPositions).catch(() => {});
  }, []);

  const setPositionDraftStages: Dispatch<SetStateAction<RhStage[]>> = (updater) => {
    setPositionDraft((d) => {
      if (!d) return d;
      const nextStages = typeof updater === "function" ? (updater as (prev: RhStage[]) => RhStage[])(d.stages) : updater;
      return { ...d, stages: nextStages };
    });
  };

  const openPosition = (p: RhPosition) => {
    setEditingPositionId(p.id);
    setPositionDraft({ name: p.name, active: p.active, stages: p.stages });
  };

  const createPosition = async () => {
    if (!newPositionName.trim() || creatingPosition) return;
    setCreatingPosition(true);
    try {
      // O primeiro cargo já nasce com o processo atual (stages global) — não
      // perde a personalização que a loja já tinha feito antes dos cargos.
      const seedStages = positions.length === 0 ? stages : undefined;
      const created = await api.rh.positions.create({ name: newPositionName.trim(), stages: seedStages });
      setPositions((prev) => [...prev, created]);
      setNewPositionName("");
      openPosition(created);
      toast({ title: "Cargo criado!" });
    } catch (err) {
      toast({ title: "Erro ao criar cargo", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setCreatingPosition(false);
    }
  };

  const savePosition = async () => {
    if (!positionDraft || editingPositionId == null || savingPosition) return;
    setSavingPosition(true);
    try {
      const updated = await api.rh.positions.update(editingPositionId, {
        name: positionDraft.name, active: positionDraft.active, stages: positionDraft.stages,
      });
      setPositions((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      toast({ title: "Cargo salvo!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingPosition(false);
    }
  };

  const removePosition = async () => {
    if (editingPositionId == null) return;
    const p = positions.find((x) => x.id === editingPositionId);
    if (!p) return;
    if (!window.confirm(`Excluir o cargo "${p.name}"? As candidaturas já recebidas mantêm o nome do cargo, mas o processo dele será apagado.`)) return;
    try {
      await api.rh.positions.remove(editingPositionId);
      setPositions((prev) => prev.filter((x) => x.id !== editingPositionId));
      setEditingPositionId(null);
      setPositionDraft(null);
      toast({ title: "Cargo excluído" });
    } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  const publicUrl = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/candidatura/${token}`;

  const copyLink = () => {
    navigator.clipboard.writeText(publicUrl)
      .then(() => toast({ title: "Link copiado! Envie para os candidatos." }))
      .catch(() => toast({ title: publicUrl }));
  };

  const regenerate = async () => {
    if (!window.confirm("Gerar um novo link? O link antigo para de funcionar na hora.")) return;
    try {
      const r = await api.rh.regenerateToken();
      setToken(r.publicToken);
      toast({ title: "Novo link gerado" });
    } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  const saveStages = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.rh.saveSettings(stages);
      toast({ title: "Processo salvo!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const setStatus = async (c: RhCandidate, status: RhCandidate["status"], reason?: string | null) => {
    setSavingStatus(true);
    try {
      const patch: { status: RhCandidate["status"]; statusReason?: string | null } = { status };
      if (reason !== undefined) patch.statusReason = reason;
      await api.rh.updateCandidate(c.id, patch);
      setCandidates((prev) => prev.map((x) => (x.id === c.id ? { ...x, status, ...(reason !== undefined ? { statusReason: reason } : {}) } : x)));
      setOpened((o) => (o?.id === c.id ? { ...o, status, ...(reason !== undefined ? { statusReason: reason } : {}) } : o));
      setPendingStatusChange(null);
    } catch { toast({ title: "Erro", variant: "destructive" }); } finally { setSavingStatus(false); }
  };

  // Confirma a troca de status pendente com o motivo escolhido (chip ou
  // "Outro" com texto livre). Motivo em branco = troca sem motivo mesmo
  // (não é obrigatório, só ajuda a não deixar solto).
  const confirmStatusChange = () => {
    if (!opened || !pendingStatusChange) return;
    const reason = pendingStatusChange.reason === "outro" ? pendingStatusChange.customReason.trim() : pendingStatusChange.reason;
    setStatus(opened, pendingStatusChange.status, reason || null);
  };

  const saveInterviewNotes = async () => {
    if (!opened || savingInterview) return;
    setSavingInterview(true);
    try {
      const cleaned = Object.fromEntries(Object.entries(interviewDraft).filter(([, v]) => v.trim()));
      const result = await api.rh.updateCandidate(opened.id, { interviewNotes: cleaned });
      setCandidates((prev) => prev.map((x) => (x.id === opened.id ? { ...x, interviewNotes: result.interviewNotes } : x)));
      setOpened((o) => (o?.id === opened.id ? { ...o, interviewNotes: result.interviewNotes } : o));
      toast({ title: "Anotações da entrevista salvas" });
    } catch { toast({ title: "Erro", variant: "destructive" }); } finally { setSavingInterview(false); }
  };

  // Imprime a entrevista: abre uma aba só com o conteúdo formatado (em vez de
  // brigar com o CSS do dashboard inteiro via @media print) e já chama a
  // caixa de impressão do navegador.
  const printCandidate = (c: RhCandidate) => {
    const stagesToRender = c.stagesSnapshot ?? stages;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sections = stagesToRender.map((s) => {
      if (s.type === "video") return "";
      const ans = c.answers?.[s.id];
      if (!ans) return "";
      const rows = s.questions.map((q) => `
        <div class="q">
          <p class="label">${esc(q.label)}</p>
          <p class="answer">${esc(ans[q.id] ?? "—")}</p>
        </div>`).join("");
      return `<h2>${esc(s.title)}</h2>${rows}`;
    }).join("");
    const profileHtml = c.profileResult ? `
      <div class="profile">
        <p class="label">Perfil comportamental</p>
        <p class="answer">${esc(PROFILE_META[c.profileResult].emoji)} ${esc(PROFILE_META[c.profileResult].label)} — ${esc(PROFILE_META[c.profileResult].foco)}</p>
      </div>` : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Entrevista — ${esc(c.name)}</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 32px; max-width: 720px; margin: 0 auto; }
        h1 { font-size: 20px; margin-bottom: 4px; }
        .meta { color: #555; font-size: 12px; margin-bottom: 4px; }
        .status { display: inline-block; font-size: 11px; font-weight: bold; padding: 3px 10px; border-radius: 999px; border: 1px solid #ccc; margin-top: 8px; }
        h2 { font-size: 14px; margin-top: 24px; margin-bottom: 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
        .q { margin-bottom: 10px; }
        .label { font-size: 11px; color: #666; margin: 0 0 2px; }
        .answer { font-size: 13px; margin: 0; white-space: pre-wrap; }
        .profile { margin-top: 12px; padding: 10px 12px; background: #f0f4ff; border-radius: 8px; }
        .notes { margin-top: 24px; padding: 12px; background: #f5f5f5; border-radius: 8px; }
        .notes p.label { margin-bottom: 4px; }
        @media print { body { padding: 0; } }
      </style></head><body>
      <h1>${esc(c.name)}</h1>
      <p class="meta">${esc(c.phone)}${c.email ? ` · ${esc(c.email)}` : ""}${(c.city || c.neighborhood) ? ` · ${esc([c.neighborhood, c.city].filter(Boolean).join(", "))}` : ""}</p>
      <p class="meta">Candidatura em ${new Date(c.createdAt).toLocaleString("pt-BR")}</p>
      <span class="status">${esc(STATUS_META[c.status].label)}</span>
      ${profileHtml}
      ${sections}
      ${c.notes ? `<div class="notes"><p class="label">Anotações internas</p><p class="answer">${esc(c.notes)}</p></div>` : ""}
    </body></html>`;
    const win = window.open("", "_blank");
    if (!win) { toast({ title: "Não foi possível abrir a janela de impressão — verifique o bloqueador de pop-ups", variant: "destructive" }); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  // Abre (ou reabre, se já existir) a contratação deste candidato aprovado —
  // cria o colaborador com hiringStatus "em_contratacao" e leva pra view
  // "Contratação", já abrindo o assistente dele.
  const startHiring = async (c: RhCandidate) => {
    if (startingHiring) return;
    setStartingHiring(true);
    try {
      const emp = await api.rhDp.hiring.start({ candidateId: c.id });
      setOpened(null);
      setHiringToOpen(emp.id);
      setView("contratacoes");
    } catch (err) {
      toast({ title: "Erro ao iniciar contratação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setStartingHiring(false);
    }
  };

  const removeCandidate = async (c: RhCandidate) => {
    if (!window.confirm(`Excluir a candidatura de ${c.name}?`)) return;
    try {
      await api.rh.removeCandidate(c.id);
      setCandidates((prev) => prev.filter((x) => x.id !== c.id));
      setOpened(null);
    } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  const saveNotes = async () => {
    if (!opened) return;
    try {
      await api.rh.updateCandidate(opened.id, { notes: notesDraft });
      setCandidates((prev) => prev.map((x) => (x.id === opened.id ? { ...x, notes: notesDraft } : x)));
      toast({ title: "Anotação salva" });
    } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  // Cidades com pelo menos 1 candidato preenchido, em ordem alfabética —
  // dropdown em vez de texto livre pra não depender de digitar igualzinho
  // (evita "São Paulo" x "sao paulo" virarem opções diferentes).
  const cityOptions = Array.from(new Set(candidates.map((c) => c.city).filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  // Bairros relativos à cidade escolhida (todas as cidades, se nenhuma estiver selecionada).
  const bairroOptions = Array.from(new Set(
    candidates
      .filter((c) => cityFilter === "todas" || c.city === cityFilter)
      .map((c) => c.neighborhood)
      .filter((v): v is string => !!v),
  )).sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Vagas com pelo menos 1 candidato — mesmo raciocínio de cityOptions
  // (dropdown em vez de texto livre). "Sem vaga" cobre candidatura do
  // processo legado (loja sem cargo configurado na época).
  const positionOptions = Array.from(new Set(candidates.map((c) => c.positionName).filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  const hasLegacyCandidate = candidates.some((c) => !c.positionName);

  const shown = candidates.filter((c) =>
    (filter === "todos" || c.status === filter) &&
    (cityFilter === "todas" || c.city === cityFilter) &&
    (bairroFilter === "todos" || c.neighborhood === bairroFilter) &&
    (positionFilter === "todas" || (positionFilter === "sem_vaga" ? !c.positionName : c.positionName === positionFilter)));

  // Outras candidaturas da mesma pessoa (por CPF/telefone/e-mail), mais
  // recentes primeiro — calculado sobre TODOS os candidatos (não só os que
  // passam no filtro de status), pra sempre mostrar o histórico completo.
  const historyById = new Map<number, RhCandidate[]>();
  for (const members of groupCandidatesByPerson(candidates).values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    for (const m of sorted) historyById.set(m.id, sorted.filter((x) => x.id !== m.id));
  }
  const toggleHistory = (id: number) =>
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <div className="flex gap-1.5">
          <button onClick={() => setView("candidatos")}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${view === "candidatos" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
            Candidatos ({candidates.length})
          </button>
          <button onClick={() => setView("processo")} data-testid="button-rh-processo"
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border flex items-center gap-1 ${view === "processo" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
            <Settings2 className="w-3.5 h-3.5" /> Personalizar processo
          </button>
          <button onClick={() => setView("contratacoes")} data-testid="button-rh-contratacoes"
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border flex items-center gap-1 ${view === "contratacoes" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
            <FolderArchive className="w-3.5 h-3.5" /> Contratação
          </button>
        </div>
      </div>

      {/* Link público */}
      <div className="shk-card p-4 flex items-center gap-2 flex-wrap">
        <Link2 className="w-4 h-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold">Link para os candidatos</p>
          <p className="text-[11px] text-muted-foreground truncate">{publicUrl}</p>
        </div>
        <button onClick={copyLink} data-testid="button-copy-rh-link"
          className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold"><Copy className="w-3.5 h-3.5" /> Copiar</button>
        <button onClick={regenerate} disabled={!canEdit}
          title={canEdit ? "Gerar novo link (o antigo para de funcionar)" : "Você só tem acesso de visualização ao RH"}
          className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>

      {view === "candidatos" ? (
        <>
          <div className="flex gap-1.5 flex-wrap">
            {(["todos", "novo", "pre_aprovado", "aprovado", "reprovado"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border capitalize ${filter === f ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                {f === "todos" ? "Todos" : STATUS_META[f].label}
              </button>
            ))}
            {/* Filtro por vaga/cargo escolhido (ex: "Técnico Vendedor") — só
                aparece quando há pelo menos 1 cargo cadastrado, senão não faz
                sentido (toda candidatura seria "sem vaga"). */}
            {positions.length > 0 && (
              <select value={positionFilter} data-testid="select-rh-position-filter"
                onChange={(e) => setPositionFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-full text-xs font-semibold border bg-white text-foreground border-border">
                <option value="todas">Todas as vagas</option>
                {positionOptions.map((p) => <option key={p} value={p}>{p}</option>)}
                {hasLegacyCandidate && <option value="sem_vaga">Sem vaga (processo antigo)</option>}
              </select>
            )}
            {/* Filtro por cidade/bairro — só aparece quando há pelo menos 1
                candidato com cidade preenchida (campo novo, opcional, ver
                Candidatura.tsx); candidatura antiga não tem esse dado. */}
            {cityOptions.length > 0 && (
              <>
                <select value={cityFilter} data-testid="select-rh-city-filter"
                  onChange={(e) => { setCityFilter(e.target.value); setBairroFilter("todos"); }}
                  className="px-2.5 py-1.5 rounded-full text-xs font-semibold border bg-white text-foreground border-border">
                  <option value="todas">Todas as cidades</option>
                  {cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                {bairroOptions.length > 0 && (
                  <select value={bairroFilter} data-testid="select-rh-bairro-filter"
                    onChange={(e) => setBairroFilter(e.target.value)}
                    className="px-2.5 py-1.5 rounded-full text-xs font-semibold border bg-white text-foreground border-border">
                    <option value="todos">Todos os bairros</option>
                    {bairroOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                )}
              </>
            )}
          </div>
          {shown.length === 0 ? (
            <div className="shk-card p-8 text-center text-muted-foreground">
              <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-semibold">Nenhum candidato {filter !== "todos" ? `com status "${STATUS_META[filter as RhCandidate["status"]].label}"` : "ainda"}</p>
              <p className="text-xs mt-1">Copie o link acima e divulgue para receber candidaturas.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {shown.map((c) => {
                const history = historyById.get(c.id) ?? [];
                const expanded = expandedHistory.has(c.id);
                return (
                  <div key={c.id}>
                    <button onClick={() => { setOpened(c); setNotesDraft(c.notes ?? ""); setInterviewDraft(c.interviewNotes ?? {}); setPendingStatusChange(null); }} data-testid={`candidate-${c.id}`}
                      className="shk-card p-4 w-full text-left flex items-center gap-3 hover:bg-secondary/30 transition">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-sm">{c.name}</p>
                          <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${STATUS_META[c.status].cls}`}>{STATUS_META[c.status].label}</span>
                          {c.positionName && (
                            <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border-border flex items-center gap-1">
                              <Briefcase className="w-3 h-3" /> {c.positionName}
                            </span>
                          )}
                          {c.profileResult && (
                            <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${PROFILE_META[c.profileResult].cls}`}>
                              {PROFILE_META[c.profileResult].emoji} {PROFILE_META[c.profileResult].label}
                            </span>
                          )}
                          {c.hasVideo && <Video className="w-3.5 h-3.5 text-primary" />}
                        </div>
                        <p className="text-[11px] text-muted-foreground">{c.phone}{c.email ? ` · ${c.email}` : ""}{c.cpf ? ` · CPF ${c.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")}` : ""}{(c.city || c.neighborhood) ? ` · ${[c.neighborhood, c.city].filter(Boolean).join(", ")}` : ""} · {new Date(c.createdAt).toLocaleDateString("pt-BR")}</p>
                      </div>
                    </button>
                    {history.length > 0 && (
                      <div className="pl-3 mt-1">
                        <button type="button" onClick={() => toggleHistory(c.id)} data-testid={`button-history-${c.id}`}
                          className="text-[11px] text-primary font-semibold flex items-center gap-1 py-0.5">
                          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {history.length === 1 ? "1 candidatura anterior desta pessoa" : `${history.length} candidaturas anteriores desta pessoa`}
                        </button>
                        {expanded && (
                          <div className="mt-1 space-y-1">
                            {history.map((h) => (
                              <button key={h.id} type="button" onClick={() => { setOpened(h); setNotesDraft(h.notes ?? ""); }} data-testid={`candidate-history-${h.id}`}
                                className="shk-card p-2.5 w-full text-left flex items-center gap-2 text-xs hover:bg-secondary/30 transition">
                                <span className={`text-[10px] font-bold border px-1.5 py-0.5 rounded-full ${STATUS_META[h.status].cls}`}>{STATUS_META[h.status].label}</span>
                                <span className="text-muted-foreground">{new Date(h.createdAt).toLocaleDateString("pt-BR")}</span>
                                {h.hasVideo && <Video className="w-3 h-3 text-primary" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : view === "processo" ? (
        /* Cargos + editor do processo — some visível pra "view" (mantendo
           tudo navegável e legível), mas nenhum campo/botão aceita interação. */
        <div className="space-y-3">
          {!canEdit && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
              Você só tem acesso de visualização ao RH — peça ao administrador para liberar edição.
            </p>
          )}

          <div className="shk-card p-4 space-y-3">
            <p className="text-xs font-bold flex items-center gap-1.5"><Briefcase className="w-3.5 h-3.5 text-primary" /> Cargos com processo próprio</p>
            <p className="text-[11px] text-muted-foreground">
              Cadastre um cargo pra cada função (ex.: Vendedor, Administrativo, Gerente, Estoque). Assim que existir pelo menos 1 cargo, quem acessa o link escolhe a vaga antes de responder — 1 só, nunca várias — e o questionário mostrado é o daquela função.
            </p>
            {positions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {positions.map((p) => (
                  <button key={p.id} onClick={() => openPosition(p)} data-testid={`button-position-${p.id}`}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                      editingPositionId === p.id ? "bg-primary text-white border-primary"
                      : p.active ? "bg-white text-foreground border-border hover:bg-secondary"
                      : "bg-secondary text-muted-foreground border-border opacity-60"
                    }`}>
                    {p.name}{!p.active ? " (inativo)" : ""}
                  </button>
                ))}
              </div>
            )}
            {canEdit && (
              <div className="flex gap-2">
                <input value={newPositionName} onChange={(e) => setNewPositionName(e.target.value)} placeholder="Nome do cargo (ex.: Vendedor)"
                  data-testid="input-new-position"
                  className="flex-1 px-3 py-2 rounded-xl border border-border text-xs" />
                <button onClick={createPosition} disabled={!newPositionName.trim() || creatingPosition} data-testid="button-create-position"
                  className="flex items-center gap-1 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                  <Plus className="w-3.5 h-3.5" /> {creatingPosition ? "Criando..." : "Criar cargo"}
                </button>
              </div>
            )}
          </div>

          {editingPositionId != null && positionDraft ? (
            <div className="shk-card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <input value={positionDraft.name} disabled={!canEdit}
                  onChange={(e) => setPositionDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                  className="flex-1 px-3 py-2 rounded-xl border border-border text-sm font-bold disabled:opacity-60" />
                <label className="flex items-center gap-1 text-[11px] font-medium shrink-0">
                  <input type="checkbox" checked={positionDraft.active} disabled={!canEdit}
                    onChange={(e) => setPositionDraft((d) => (d ? { ...d, active: e.target.checked } : d))} /> Ativo
                </label>
                <button onClick={removePosition} disabled={!canEdit} data-testid="button-remove-position"
                  className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <StageEditor stages={positionDraft.stages} setStages={setPositionDraftStages}
                canEdit={canEdit} onSave={savePosition} saving={savingPosition} saveLabel="Salvar cargo"
                positionName={positionDraft.name} />
            </div>
          ) : positions.length === 0 ? (
            <>
              <p className="text-[11px] text-muted-foreground">Sem nenhum cargo cadastrado, o processo abaixo vale pra qualquer pessoa que acessar o link — do jeito que já era.</p>
              <StageEditor stages={stages} setStages={setStages} canEdit={canEdit} onSave={saveStages} saving={saving} />
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">Clique num cargo acima pra editar o processo dele.</p>
          )}
        </div>
      ) : (
        <Contratacoes canEdit={canEdit} openEmployeeId={hiringToOpen} onOpenedConsumed={() => setHiringToOpen(null)} />
      )}

      {/* Modal do candidato */}
      {opened && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold">{opened.name}</h3>
              <button onClick={() => { setOpened(null); setPendingStatusChange(null); }}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="mb-3">
              <p className="text-xs text-muted-foreground">
                {opened.phone}{opened.email ? ` · ${opened.email}` : ""}{opened.cpf ? ` · CPF ${opened.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")}` : ""}{(opened.city || opened.neighborhood) ? ` · ${[opened.neighborhood, opened.city].filter(Boolean).join(", ")}` : ""} · {new Date(opened.createdAt).toLocaleString("pt-BR")}
              </p>
              {opened.positionName && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><Briefcase className="w-3.5 h-3.5 text-primary" /> Vaga: <span className="font-semibold">{opened.positionName}</span></p>
              )}
            </div>

            {opened.profileResult && (
              <div className={`rounded-xl border p-3 mb-4 ${PROFILE_META[opened.profileResult].cls}`} data-testid="candidate-profile-result">
                <p className="text-xs font-bold flex items-center gap-1.5">
                  {PROFILE_META[opened.profileResult].emoji} Perfil comportamental: {PROFILE_META[opened.profileResult].label}
                </p>
                <p className="text-[11px] mt-1"><span className="font-semibold">Foco:</span> {PROFILE_META[opened.profileResult].foco}</p>
                <p className="text-[11px]"><span className="font-semibold">Pontos fortes:</span> {PROFILE_META[opened.profileResult].pontosFortes}</p>
                <p className="text-[11px]"><span className="font-semibold">Desafios:</span> {PROFILE_META[opened.profileResult].desafios}</p>
                <p className="text-[11px]"><span className="font-semibold">Motivação:</span> {PROFILE_META[opened.profileResult].motivacao}</p>
                {opened.profileScores && (
                  <p className="text-[10px] mt-1.5 opacity-70">
                    {PROFILE_TYPES.map((p) => `${PROFILE_META[p].emoji} ${opened.profileScores![p]}`).join("  ·  ")}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-1.5 mb-1 flex-wrap">
              <button onClick={() => setPendingStatusChange({ status: "pre_aprovado", reason: "", customReason: "" })} data-testid="button-preapprove-candidate" disabled={!canEdit}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border disabled:opacity-40 ${opened.status === "pre_aprovado" ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-indigo-600 border-indigo-200"}`}>
                <Star className="w-3.5 h-3.5" /> Pré-aprovar
              </button>
              <button onClick={() => setPendingStatusChange({ status: "aprovado", reason: "", customReason: "" })} data-testid="button-approve-candidate" disabled={!canEdit}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border disabled:opacity-40 ${opened.status === "aprovado" ? "bg-green-600 text-white border-green-600" : "bg-white text-green-700 border-green-200"}`}>
                <CheckCircle className="w-3.5 h-3.5" /> Aprovar
              </button>
              <button onClick={() => setPendingStatusChange({ status: "reprovado", reason: "", customReason: "" })} disabled={!canEdit}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border disabled:opacity-40 ${opened.status === "reprovado" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-200"}`}>
                <XCircle className="w-3.5 h-3.5" /> Reprovar
              </button>
              <button onClick={() => printCandidate(opened)} data-testid="button-print-candidate"
                className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border bg-white text-muted-foreground border-border hover:bg-secondary transition">
                <Printer className="w-3.5 h-3.5" /> Imprimir
              </button>
              {opened.status === "aprovado" && (
                <button onClick={() => startHiring(opened)} disabled={!canEdit || startingHiring} data-testid="button-start-hiring"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 transition disabled:opacity-50">
                  <UserPlus className="w-3.5 h-3.5" /> {startingHiring ? "Abrindo..." : "Iniciar contratação"}
                </button>
              )}
              <button onClick={() => removeCandidate(opened)} disabled={!canEdit}
                className="ml-auto p-1.5 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-40"><Trash2 className="w-4 h-4" /></button>
            </div>
            {opened.statusReason && !pendingStatusChange && (
              <p className="text-[11px] text-muted-foreground mb-3">Motivo: <span className="font-medium">{opened.statusReason}</span></p>
            )}

            {/* Motivo da troca de status — some sozinho depois de confirmar
                (setPendingStatusChange(null) dentro de setStatus/confirmStatusChange). */}
            {pendingStatusChange && (
              <div className="rounded-xl border border-border bg-secondary/30 p-3 mb-4 space-y-2">
                <p className="text-xs font-bold">Motivo pra {STATUS_META[pendingStatusChange.status].label.toLowerCase()} (opcional)</p>
                <div className="flex gap-1.5 flex-wrap">
                  {STATUS_REASON_OPTIONS[pendingStatusChange.status].map((r) => (
                    <button key={r} onClick={() => setPendingStatusChange((p) => (p ? { ...p, reason: r } : p))}
                      className={`text-[11px] px-2.5 py-1 rounded-full border font-medium ${pendingStatusChange.reason === r ? "bg-primary text-white border-primary" : "bg-white text-foreground border-border"}`}>
                      {r}
                    </button>
                  ))}
                  <button onClick={() => setPendingStatusChange((p) => (p ? { ...p, reason: "outro" } : p))}
                    className={`text-[11px] px-2.5 py-1 rounded-full border font-medium ${pendingStatusChange.reason === "outro" ? "bg-primary text-white border-primary" : "bg-white text-foreground border-border"}`}>
                    Outro
                  </button>
                </div>
                {pendingStatusChange.reason === "outro" && (
                  <input value={pendingStatusChange.customReason} onChange={(e) => setPendingStatusChange((p) => (p ? { ...p, customReason: e.target.value } : p))}
                    placeholder="Descreva o motivo..." maxLength={300}
                    className="w-full px-3 py-1.5 rounded-lg border border-border text-xs" />
                )}
                <div className="flex gap-1.5 justify-end">
                  <button onClick={() => setPendingStatusChange(null)} className="text-[11px] px-3 py-1.5 rounded-lg text-muted-foreground font-semibold">Cancelar</button>
                  <button onClick={confirmStatusChange} disabled={savingStatus} data-testid="button-confirm-status-reason"
                    className="text-[11px] px-3 py-1.5 rounded-lg bg-primary text-white font-bold disabled:opacity-50">
                    {savingStatus ? "Salvando..." : "Confirmar"}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
              {/* Entrevista online (Google Meet) — roteiro fixo com anotação
                  por pergunta, preenchida em tempo real durante a ligação. */}
              <div className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-bold flex items-center gap-1.5"><Video className="w-3.5 h-3.5 text-primary" /> Entrevista online</p>
                  <a href="https://meet.google.com/new" target="_blank" rel="noopener noreferrer" data-testid="button-open-meet"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border bg-white text-primary border-primary/30 hover:bg-primary/5 transition">
                    <Video className="w-3 h-3" /> Abrir Google Meet
                  </a>
                </div>
                <div className="space-y-3">
                  {INTERVIEW_SCRIPT.map((section) => (
                    <div key={section.category}>
                      <p className="text-[11px] font-bold text-muted-foreground mb-1">{section.category}</p>
                      <div className="space-y-1.5">
                        {section.questions.map((q) => (
                          <div key={q.id}>
                            <p className="text-[11px] text-muted-foreground mb-0.5">{q.label}</p>
                            <textarea value={interviewDraft[q.id] ?? ""} disabled={!canEdit}
                              onChange={(e) => setInterviewDraft((prev) => ({ ...prev, [q.id]: e.target.value }))}
                              rows={1} placeholder="Anotação da resposta..." data-testid={`textarea-interview-${q.id}`}
                              className="w-full px-2.5 py-1.5 rounded-lg border border-border text-xs resize-none disabled:opacity-60" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {canEdit && (
                  <button onClick={saveInterviewNotes} disabled={savingInterview} data-testid="button-save-interview"
                    className="mt-2 px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-bold disabled:opacity-50">
                    {savingInterview ? "Salvando..." : "Salvar anotações da entrevista"}
                  </button>
                )}
              </div>

              {(opened.stagesSnapshot ?? stages).map((s) => {
                const ans = opened.answers?.[s.id];
                if (s.type === "video") {
                  return opened.hasVideo ? (
                    <div key={s.id}>
                      <p className="text-xs font-bold mb-1.5">{s.title}</p>
                      <video src={`${API_BASE}/rh/candidates/${opened.id}/video`} controls playsInline className="w-full aspect-video bg-black rounded-xl" />
                    </div>
                  ) : null;
                }
                if (!ans) return null;
                return (
                  <div key={s.id}>
                    <p className="text-xs font-bold mb-1.5">{s.title}</p>
                    <div className="space-y-2">
                      {s.questions.map((q) => (
                        <div key={q.id} className="bg-secondary/40 rounded-xl px-3 py-2">
                          <p className="text-[11px] text-muted-foreground">{q.label}</p>
                          <p className="text-xs font-medium whitespace-pre-wrap">{ans[q.id] ?? "—"}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div>
                <p className="text-xs font-bold mb-1.5">Anotações internas</p>
                <textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={3} disabled={!canEdit}
                  placeholder="Suas observações sobre este candidato (só o admin vê)..."
                  className="w-full px-3 py-2 rounded-xl border border-border text-xs resize-none disabled:opacity-60" />
                {canEdit && (
                  <button onClick={saveNotes} className="mt-1 px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-bold">Salvar anotação</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Editor de etapas do processo seletivo — reaproveitado tanto pelo processo
// "legado" (sem cargo, 1 só pra loja inteira) quanto pelo processo de cada
// cargo individual (item: processo seletivo por função). `stages`/`setStages`
// definem só ONDE o editor lê/escreve; o resto do editor é idêntico nos 2 casos.
function StageEditor({ stages, setStages, canEdit, onSave, saving, saveLabel = "Salvar processo", positionName }: {
  stages: RhStage[];
  setStages: Dispatch<SetStateAction<RhStage[]>>;
  canEdit: boolean;
  onSave: () => void;
  saving: boolean;
  saveLabel?: string;
  // Nome do cargo (quando o processo é por vaga) — dá contexto pra IA
  // organizar as etapas pensando nessa função específica. Sem cargo
  // (processo legado, 1 só pra loja), fica undefined e a IA organiza genérico.
  positionName?: string;
}) {
  const { toast } = useToast();
  const [showAiOrganize, setShowAiOrganize] = useState(false);
  const [aiRawText, setAiRawText] = useState("");
  const [aiOrganizing, setAiOrganizing] = useState(false);

  const setStage = (i: number, patch: Partial<RhStage>) =>
    setStages((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setQuestion = (si: number, qi: number, patch: Partial<RhQuestion>) =>
    setStages((prev) => prev.map((s, j) => j !== si ? s : { ...s, questions: s.questions.map((q, k) => (k === qi ? { ...q, ...patch } : q)) }));
  const move = (i: number, dir: -1 | 1) =>
    setStages((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  // Organiza a lista crua colada pelo admin em etapas via IA — só preenche o
  // editor (estado local, ainda não salvo); o admin revisa/ajusta e clica em
  // Salvar quando estiver satisfeito, exatamente como a importação por IA da
  // Vitrine Aparelhos.
  const runAiOrganize = async () => {
    if (!aiRawText.trim() || aiOrganizing) return;
    setAiOrganizing(true);
    try {
      const r = await api.rh.aiOrganize({ rawText: aiRawText, positionName });
      setStages(r.stages);
      setShowAiOrganize(false);
      setAiRawText("");
      toast({ title: "Etapas organizadas pela IA!", description: "Revise as perguntas e os perfis marcados antes de salvar." });
    } catch (err) {
      toast({ title: "Erro ao organizar com IA", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setAiOrganizing(false);
    }
  };

  return (
    <fieldset disabled={!canEdit} className="space-y-3 border-0 p-0 m-0">
      <div className="shk-card p-3 space-y-2 bg-secondary/30">
        <button type="button" onClick={() => setShowAiOrganize((v) => !v)} data-testid="button-toggle-ai-organize"
          className="flex items-center gap-1.5 text-xs font-bold text-primary">
          <Sparkles className="w-3.5 h-3.5" /> Organizar lista de perguntas com IA
          {showAiOrganize ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {showAiOrganize && (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Cole a lista de perguntas sem organização nenhuma (dados pessoais, técnicas, teste de perfil misturados). A IA agrupa em etapas{positionName ? ` pensando na vaga "${positionName}"` : ""} e, nas perguntas de teste de perfil, já sugere as alternativas marcadas com o perfil comportamental (Analítico/Dominante/Apoiador/Inovador). Isso <strong>substitui</strong> as etapas do editor abaixo — revise tudo antes de clicar em Salvar.
            </p>
            <textarea value={aiRawText} onChange={(e) => setAiRawText(e.target.value)} rows={6}
              placeholder={"Cole aqui, por exemplo:\nQual sua idade?\nUm cliente chega irritado, o que você faz?\nVocê prefere trabalhar em equipe ou sozinho?\nJá trabalhou com vendas? Onde?"}
              data-testid="textarea-ai-organize"
              className="w-full px-3 py-2 rounded-xl border border-border text-xs resize-none" />
            <button type="button" onClick={runAiOrganize} disabled={!aiRawText.trim() || aiOrganizing} data-testid="button-run-ai-organize"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              <Sparkles className="w-3.5 h-3.5" /> {aiOrganizing ? "Organizando..." : "Organizar etapas"}
            </button>
          </div>
        )}
      </div>
      {stages.map((s, si) => (
        <div key={si} className={`shk-card p-4 space-y-3 ${!s.enabled ? "opacity-60" : ""}`}>
          <div className="flex items-center gap-2">
            <div className="flex flex-col">
              <button onClick={() => move(si, -1)} disabled={si === 0} className="disabled:opacity-20"><ChevronUp className="w-4 h-4 text-muted-foreground" /></button>
              <button onClick={() => move(si, 1)} disabled={si === stages.length - 1} className="disabled:opacity-20"><ChevronDown className="w-4 h-4 text-muted-foreground" /></button>
            </div>
            <input value={s.title} onChange={(e) => setStage(si, { title: e.target.value })}
              className="flex-1 px-3 py-2 rounded-xl border border-border text-sm font-bold" />
            <select value={s.type} onChange={(e) => setStage(si, {
              type: e.target.value as RhStage["type"],
              questions: e.target.value === "video" ? [] : (s.questions.length ? s.questions : [{ id: "q1", label: "", type: "text" }]),
              ...(e.target.value === "video" ? { maxVideoSeconds: s.maxVideoSeconds ?? 60 } : {}),
            })}
              className="px-2 py-2 rounded-xl border border-border text-xs">
              <option value="form">Perguntas</option>
              <option value="video">Vídeo gravado</option>
            </select>
            <label className="flex items-center gap-1 text-[11px] font-medium shrink-0">
              <input type="checkbox" checked={s.enabled} onChange={(e) => setStage(si, { enabled: e.target.checked })} /> Ativa
            </label>
            <button onClick={() => setStages((prev) => prev.filter((_, j) => j !== si))} disabled={stages.length === 1}
              className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          <textarea value={s.description} onChange={(e) => setStage(si, { description: e.target.value })}
            rows={2} placeholder="Instruções para o candidato nesta etapa..."
            className="w-full px-3 py-2 rounded-xl border border-border text-xs resize-none" />
          {s.type === "video" && (
            <div className="flex items-center gap-2 pl-2 border-l-2 border-border flex-wrap">
              <label className="text-[11px] font-medium shrink-0">Duração máxima do vídeo:</label>
              <select
                value={s.maxVideoSeconds === null ? "unlimited" : VIDEO_SECONDS_PRESETS.includes(s.maxVideoSeconds ?? 60) ? String(s.maxVideoSeconds ?? 60) : "custom"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "unlimited") setStage(si, { maxVideoSeconds: null });
                  else if (v === "custom") setStage(si, { maxVideoSeconds: s.maxVideoSeconds ?? 60 });
                  else setStage(si, { maxVideoSeconds: parseInt(v, 10) });
                }}
                className="px-2 py-1.5 rounded-xl border border-border text-[11px]">
                <option value="30">30 segundos</option>
                <option value="60">1 minuto</option>
                <option value="120">2 minutos</option>
                <option value="180">3 minutos</option>
                <option value="300">5 minutos</option>
                <option value="600">10 minutos</option>
                <option value="custom">Personalizado</option>
                <option value="unlimited">Sem limite</option>
              </select>
              {s.maxVideoSeconds != null && !VIDEO_SECONDS_PRESETS.includes(s.maxVideoSeconds) && (
                <input type="number" min={5} max={1800} value={s.maxVideoSeconds}
                  onChange={(e) => setStage(si, { maxVideoSeconds: Math.max(5, Math.min(1800, parseInt(e.target.value, 10) || 60)) })}
                  className="w-20 px-2 py-1.5 rounded-xl border border-border text-[11px]" />
              )}
            </div>
          )}
          {s.type === "form" && (
            <div className="space-y-2 pl-2 border-l-2 border-border">
              {s.questions.map((q, qi) => (
                <div key={qi} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1">
                    <input value={q.label} onChange={(e) => setQuestion(si, qi, { label: e.target.value })}
                      placeholder={`Pergunta ${qi + 1}`} className="w-full px-3 py-1.5 rounded-xl border border-border text-xs" />
                    {q.type === "options" && (
                      <>
                        <input value={(q.options ?? []).join(", ")}
                          onChange={(e) => setQuestion(si, qi, { options: e.target.value.split(",").map((o) => o.trimStart()) })}
                          onBlur={(e) => setQuestion(si, qi, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
                          placeholder="Opções separadas por vírgula"
                          className="w-full px-3 py-1.5 rounded-xl border border-border text-[11px]" />
                        {(q.options ?? []).length >= 2 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {(q.options ?? []).map((opt, oi) => (
                              <div key={oi} className="flex items-center gap-1 bg-white border border-border rounded-lg pl-1.5 pr-0.5 py-0.5">
                                <span className="text-[9px] text-muted-foreground truncate max-w-[90px]">{opt || `Opção ${oi + 1}`}</span>
                                <select value={q.optionProfiles?.[oi] ?? ""} data-testid={`select-option-profile-${si}-${qi}-${oi}`}
                                  onChange={(e) => {
                                    const val = e.target.value as RhProfileType | "";
                                    const base = q.optionProfiles ?? (q.options ?? []).map(() => null);
                                    const next = [...base];
                                    next[oi] = val || null;
                                    setQuestion(si, qi, { optionProfiles: next });
                                  }}
                                  className="text-[9px] border-0 bg-transparent px-1 py-0.5 text-muted-foreground">
                                  <option value="">Perfil: nenhum</option>
                                  {PROFILE_TYPES.map((p) => (
                                    <option key={p} value={p}>{PROFILE_META[p].emoji} {PROFILE_META[p].label}</option>
                                  ))}
                                </select>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <select value={q.type} onChange={(e) => setQuestion(si, qi, { type: e.target.value as RhQuestion["type"], ...(e.target.value === "options" ? { options: q.options ?? [] } : {}) })}
                    className="px-2 py-1.5 rounded-xl border border-border text-[11px]">
                    <option value="text">Resposta curta</option>
                    <option value="longtext">Resposta longa</option>
                    <option value="options">Múltipla escolha</option>
                  </select>
                  <button onClick={() => setStage(si, { questions: s.questions.filter((_, k) => k !== qi) })} disabled={s.questions.length === 1}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-30"><Trash2 className="w-3 h-3" /></button>
                </div>
              ))}
              <button onClick={() => setStage(si, { questions: [...s.questions, { id: `q${s.questions.length + 1}`, label: "", type: "text" }] })}
                disabled={s.questions.length >= 30}
                className="flex items-center gap-1 text-[11px] font-semibold text-primary disabled:opacity-40"><Plus className="w-3 h-3" /> Pergunta</button>
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <button onClick={() => setStages((prev) => [...prev, { id: `s${prev.length + 1}`, title: "Nova etapa", description: "", type: "form", enabled: true, questions: [{ id: "q1", label: "", type: "text" }] }])}
          disabled={stages.length >= 10}
          className="flex items-center gap-1 px-3 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground disabled:opacity-40">
          <Plus className="w-3.5 h-3.5" /> Adicionar etapa
        </button>
        <button onClick={onSave} disabled={saving} data-testid="button-save-rh"
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
          <Save className="w-3.5 h-3.5" /> {saving ? "Salvando..." : saveLabel}
        </button>
      </div>
    </fieldset>
  );
}

// ── Contratação (RH > Recrutamento > Contratação) ───────────────────────────
// Pedido do lojista (09/09): a partir de um candidato aprovado (ou avulso,
// sem candidatura), iniciar a contratação — reunir documentos pessoais/CLT,
// preencher cargo e escala, e gerar o contrato de trabalho personalizável —
// tudo guardado no banco de arquivos do colaborador (employee_documents).
const HIRING_DOC_TYPES: { key: string; label: string }[] = [
  { key: "foto_3x4", label: "Foto 3x4" },
  { key: "rg", label: "RG (frente e verso)" },
  { key: "cpf", label: "CPF" },
  { key: "ctps", label: "Carteira de Trabalho (CTPS)" },
  { key: "comprovante_residencia", label: "Comprovante de residência" },
  { key: "titulo_eleitor", label: "Título de eleitor" },
  { key: "pis_nit", label: "PIS/NIT" },
  { key: "certidao_civil", label: "Certidão de nascimento/casamento" },
  { key: "carteira_vacinacao", label: "Carteira de vacinação (dependentes)" },
  { key: "exame_admissional", label: "Exame admissional (ASO)" },
  { key: "reservista", label: "Certificado de reservista" },
  // Comparado ao modelo de ficha cadastral de admissão da contabilidade
  // (pedido 10/09) — os demais itens da ficha já tinham tipo equivalente
  // acima (foto 3x4, RG, CPF, CTPS, comprovante de residência, título de
  // eleitor, certidão civil, carteira de vacinação).
  { key: "declaracao_frequencia_escolar", label: "Declaração de frequência escolar (filhos 7-14 anos)" },
  { key: "cnh", label: "Carteira de habilitação (CNH) — se o cargo exigir" },
  { key: "cpf_filhos", label: "CPF dos filhos (7 a 14 anos)" },
];

// Ponto de partida genérico e editável — o lojista/contador personaliza
// antes de usar de verdade (por isso os avisos em maiúsculo e os campos
// entre colchetes: dados da empresa não são inventados aqui).
const DEFAULT_CONTRACT_TEMPLATE = `CONTRATO INDIVIDUAL DE TRABALHO

De um lado [RAZÃO SOCIAL DA EMPRESA], inscrita no CNPJ nº [CNPJ], com sede em [ENDEREÇO], doravante denominada EMPREGADORA, e de outro lado {{nome}}, portador(a) do CPF nº {{cpf}} e RG nº {{rg}}, doravante denominado(a) EMPREGADO(A), têm entre si justo e contratado o seguinte:

1. O(A) EMPREGADO(A) exercerá a função de {{cargo}} ({{funcao}}), sob o regime de contratação {{tipo_contrato}}.
2. Data de admissão: {{admissao}}. Escala/jornada: {{escala}}.
3. Local de trabalho: {{loja}}.
4. Remuneração mensal: {{salario}}, paga na forma da legislação vigente.
5. Este contrato rege-se pelas disposições da CLT e demais normas aplicáveis.

REVISE E ADAPTE ESTE MODELO COM SEU CONTADOR/ADVOGADO ANTES DE USAR — é só um ponto de partida editável, não é aconselhamento jurídico.

Local e data: _______________________, ____/____/______

_________________________________          _________________________________
        EMPREGADORA                                  {{nome}} (EMPREGADO/A)`;

// Idem acima, mas pro Regimento interno (pedido 10/09) — mesmo mecanismo de
// placeholders, só o texto padrão de partida muda.
const DEFAULT_REGIMENTO_TEMPLATE = `REGIMENTO INTERNO

Este documento estabelece as normas de conduta e funcionamento de [RAZÃO SOCIAL DA EMPRESA], das quais {{nome}}, colaborador(a) admitido(a) em {{admissao}} no cargo de {{cargo}}, declara ter ciência e concordar ao assinar.

1. Horário de trabalho e jornada conforme escala {{escala}}, loja {{loja}}.
2. Normas de conduta, uso de uniforme, pontualidade e assiduidade.
3. Uso de equipamentos, sistemas e informações da empresa.
4. Política de faltas, atrasos e justificativas.

REVISE E ADAPTE ESTE MODELO COM SEU CONTADOR/ADVOGADO ANTES DE USAR — é só um ponto de partida editável, não é aconselhamento jurídico.

Local e data: _______________________, ____/____/______

_________________________________          _________________________________
        EMPREGADORA                                  {{nome}} (EMPREGADO/A)`;

function readFileAsBase64Generic(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Erro ao ler arquivo"));
    reader.readAsDataURL(file);
  });
}

function formatDocSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printPlainText(text: string, title: string, toastFn: (opts: { title: string; variant?: "destructive" }) => void) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:32px;max-width:720px;margin:0 auto;white-space:pre-wrap;font-size:13px;line-height:1.6;} @media print{body{padding:0;}}</style>
    </head><body>${esc(text)}</body></html>`;
  const win = window.open("", "_blank");
  if (!win) { toastFn({ title: "Não foi possível abrir a janela de impressão — verifique o bloqueador de pop-ups", variant: "destructive" }); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

// Reutilizado pro Contrato de trabalho E pro Regimento interno (pedido
// 10/09) — mesmo mecanismo de modelo+placeholder, só filtrado por `kind`.
// "Padrão" e a lista de modelos ficam sempre restritos ao `kind` desta
// instância (ver isDefault escopado por kind no backend).
function ContractTemplatesManager({ canEdit, templates, onChanged, kind, defaultBodyText, newButtonLabel }: {
  canEdit: boolean; templates: EmployeeContractTemplate[]; onChanged: () => void;
  kind: "contrato" | "regimento"; defaultBodyText: string; newButtonLabel: string;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Partial<EmployeeContractTemplate> | null>(null);
  const [saving, setSaving] = useState(false);
  const list = templates.filter((t) => t.kind === kind);

  const startNew = () => setEditing({ name: "", contractType: null, isDefault: list.length === 0, bodyText: defaultBodyText, kind });

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.name?.trim()) { toast({ title: "Dê um nome ao modelo", variant: "destructive" }); return; }
    if (!editing.bodyText?.trim()) { toast({ title: "O texto não pode ficar vazio", variant: "destructive" }); return; }
    setSaving(true);
    try {
      if (editing.id) await api.rhDp.contractTemplates.update(editing.id, editing);
      else await api.rhDp.contractTemplates.create({ ...editing, kind } as { name: string; bodyText: string; contractType?: string | null; isDefault?: boolean; kind: "contrato" | "regimento" });
      setEditing(null);
      onChanged();
      toast({ title: "Modelo salvo!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const remove = async (t: EmployeeContractTemplate) => {
    if (!window.confirm(`Excluir o modelo "${t.name}"?`)) return;
    try { await api.rhDp.contractTemplates.remove(t.id); onChanged(); } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Placeholders substituídos automaticamente ao gerar: {"{{nome}}"}, {"{{cpf}}"}, {"{{rg}}"}, {"{{cargo}}"}, {"{{funcao}}"}, {"{{salario}}"}, {"{{admissao}}"}, {"{{escala}}"}, {"{{loja}}"}, {"{{tipo_contrato}}"}.
      </p>
      {list.length === 0 && <p className="text-[11px] text-muted-foreground">Nenhum modelo cadastrado ainda.</p>}
      <div className="space-y-1.5">
        {list.map((t) => (
          <div key={t.id} className="flex items-center gap-2 p-2.5 rounded-xl border border-border">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold flex items-center gap-1.5 flex-wrap">
                {t.name}
                {t.isDefault && <span className="text-[10px] font-bold border px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 border-green-100">Padrão</span>}
                {t.contractType && <span className="text-[10px] font-bold border px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground border-border">{CONTRACT_LABELS[t.contractType]}</span>}
              </p>
            </div>
            {canEdit && (
              <div className="flex gap-1 shrink-0">
                <button onClick={() => setEditing(t)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                <button onClick={() => remove(t)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
      {canEdit && !editing && (
        <button onClick={startNew} data-testid={`button-new-${kind}-template`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-border text-xs font-bold text-primary">
          <Plus className="w-3.5 h-3.5" /> {newButtonLabel}
        </button>
      )}
      {editing && (
        <div className="border border-border rounded-xl p-3 space-y-2 bg-secondary/20">
          <input value={editing.name ?? ""} onChange={(ev) => setEditing({ ...editing, name: ev.target.value })}
            placeholder="Nome do modelo" data-testid="input-template-name"
            className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
          {kind === "contrato" && (
            <select value={editing.contractType ?? ""} onChange={(ev) => setEditing({ ...editing, contractType: (ev.target.value || null) as EmployeeContractTemplate["contractType"] })}
              className="w-full px-3 py-2 rounded-xl border border-border text-sm bg-white">
              <option value="">Vale para qualquer tipo de contrato</option>
              <option value="clt">CLT</option>
              <option value="pj">PJ</option>
              <option value="estagio">Estágio</option>
            </select>
          )}
          <textarea value={editing.bodyText ?? ""} onChange={(ev) => setEditing({ ...editing, bodyText: ev.target.value })}
            rows={10} data-testid="textarea-template-body"
            className="w-full px-3 py-2 rounded-xl border border-border text-xs font-mono resize-y" />
          <label className="flex items-center gap-1.5 text-xs font-medium">
            <input type="checkbox" checked={editing.isDefault === true} onChange={(ev) => setEditing({ ...editing, isDefault: ev.target.checked })} />
            Modelo padrão (pré-selecionado ao gerar)
          </label>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} data-testid="button-save-template"
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              <Save className="w-3.5 h-3.5" /> {saving ? "Salvando..." : "Salvar modelo"}
            </button>
            <button onClick={() => setEditing(null)} className="px-3 py-2 rounded-xl border border-border text-xs font-bold">Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function HiringWizard({ employee, stores, shifts, templates, canEdit, onClose, onSaved }: {
  employee: Employee; stores: Store[]; shifts: WorkShift[]; templates: EmployeeContractTemplate[]; canEdit: boolean;
  onClose: () => void; onSaved: (updated: Employee) => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"dados" | "documentos" | "contrato" | "regimento" | "proposito">("dados");
  const [draft, setDraft] = useState<Partial<Employee>>(employee);
  const [savingDados, setSavingDados] = useState(false);
  const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | "">("");
  const [contractDraftText, setContractDraftText] = useState("");
  const [generatingContract, setGeneratingContract] = useState(false);
  const [savingContract, setSavingContract] = useState(false);
  const [editingContractDocId, setEditingContractDocId] = useState<number | null>(null);
  // Regimento interno (pedido 10/09) — mesmo mecanismo do Contrato de
  // trabalho acima (modelo → gerar → revisar → salvar/assinar), só separado
  // por docType e pelos modelos kind="regimento".
  const [selectedRegimentoTemplateId, setSelectedRegimentoTemplateId] = useState<number | "">("");
  const [regimentoDraftText, setRegimentoDraftText] = useState("");
  const [generatingRegimento, setGeneratingRegimento] = useState(false);
  const [savingRegimento, setSavingRegimento] = useState(false);
  const [editingRegimentoDocId, setEditingRegimentoDocId] = useState<number | null>(null);
  // Propósito da empresa (Missão/Visão/Valores, pedido 10/09) — texto único
  // do tenant (RH > Contratação > "Propósito da empresa"), confirmado pelo
  // colaborador aqui (vira um employee_documents docType="proposito_confirmado").
  const [purpose, setPurpose] = useState<{ companyMission: string; companyVision: string; companyValues: string } | null>(null);
  const [confirmingProposito, setConfirmingProposito] = useState(false);
  const [uploadToken, setUploadToken] = useState<string | null>(employee.documentsUploadToken ?? null);
  const [linkBusy, setLinkBusy] = useState(false);

  useEffect(() => { setDraft(employee); setTab("dados"); setUploadToken(employee.documentsUploadToken ?? null); }, [employee.id]);

  useEffect(() => {
    api.rhDp.settings.get().then((s) => setPurpose({
      companyMission: s.companyMission ?? "", companyVision: s.companyVision ?? "", companyValues: s.companyValues ?? "",
    })).catch(() => {});
  }, []);

  const loadDocs = () => {
    setLoadingDocs(true);
    api.rhDp.employeeDocuments.list(employee.id).then(setDocuments).catch(() => {}).finally(() => setLoadingDocs(false));
  };
  useEffect(loadDocs, [employee.id]);

  const contractTemplatesList = templates.filter((t) => t.kind !== "regimento");
  const regimentoTemplatesList = templates.filter((t) => t.kind === "regimento");

  useEffect(() => {
    // Pré-seleciona o modelo padrão (ou o que combina com o tipo de contrato
    // do colaborador), só quando ainda não há nada escolhido.
    if (selectedTemplateId !== "" || contractTemplatesList.length === 0) return;
    const match = contractTemplatesList.find((t) => t.contractType === draft.contractType) ?? contractTemplatesList.find((t) => t.isDefault) ?? contractTemplatesList[0];
    if (match) setSelectedTemplateId(match.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  useEffect(() => {
    if (selectedRegimentoTemplateId !== "" || regimentoTemplatesList.length === 0) return;
    const match = regimentoTemplatesList.find((t) => t.isDefault) ?? regimentoTemplatesList[0];
    if (match) setSelectedRegimentoTemplateId(match.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  const saveDados = async () => {
    if (savingDados) return;
    if (!draft.name?.trim()) { toast({ title: "Informe o nome", variant: "destructive" }); return; }
    setSavingDados(true);
    try {
      const updated = await api.rhDp.employees.update(employee.id, draft);
      onSaved(updated);
      toast({ title: "Dados salvos!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSavingDados(false); }
  };

  const uploadDoc = async (docType: string, label: string | undefined, file: File) => {
    setUploadingType(docType === "outro" ? "outro" : docType);
    try {
      const base64 = await readFileAsBase64Generic(file);
      const created = await api.rhDp.employeeDocuments.uploadFile(employee.id, {
        docType, label, fileName: file.name, mimeType: file.type || "application/octet-stream", data: base64,
      });
      setDocuments((prev) => [created, ...prev]);
    } catch (err) {
      toast({ title: "Erro ao enviar arquivo", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setUploadingType(null); }
  };

  const removeDoc = async (d: EmployeeDocument) => {
    if (!window.confirm(`Excluir "${d.label || d.fileName || d.docType}"?`)) return;
    try {
      await api.rhDp.employeeDocuments.remove(employee.id, d.id);
      setDocuments((prev) => prev.filter((x) => x.id !== d.id));
      if (editingContractDocId === d.id) { setEditingContractDocId(null); setContractDraftText(""); }
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  // Vencimento (GED, pedido 10/09): a maioria dos documentos não tem
  // validade — este campo fica escondido até o usuário clicar "+ vencimento"
  // (ver renderização abaixo). "" limpa o vencimento (envia null).
  const updateDocExpiry = async (d: EmployeeDocument, expiresAt: string) => {
    try {
      const updated = await api.rhDp.employeeDocuments.update(employee.id, d.id, { expiresAt: expiresAt || null });
      setDocuments((prev) => prev.map((x) => (x.id === d.id ? updated : x)));
    } catch { toast({ title: "Erro ao salvar vencimento", variant: "destructive" }); }
  };

  const generateContract = async () => {
    if (selectedTemplateId === "") { toast({ title: "Escolha um modelo de contrato", variant: "destructive" }); return; }
    setGeneratingContract(true);
    try {
      const { text } = await api.rhDp.employees.contractPreview(employee.id, selectedTemplateId);
      setContractDraftText(text);
      setEditingContractDocId(null);
    } catch (err) {
      toast({ title: "Erro ao gerar contrato", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setGeneratingContract(false); }
  };

  const saveContract = async () => {
    if (!contractDraftText.trim()) { toast({ title: "O contrato está vazio", variant: "destructive" }); return; }
    setSavingContract(true);
    try {
      const templateName = templates.find((t) => t.id === selectedTemplateId)?.name ?? "Contrato de trabalho";
      if (editingContractDocId) {
        const updated = await api.rhDp.employeeDocuments.update(employee.id, editingContractDocId, { textContent: contractDraftText });
        setDocuments((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      } else {
        const created = await api.rhDp.employeeDocuments.saveText(employee.id, { docType: "contrato_trabalho", label: templateName, textContent: contractDraftText });
        setDocuments((prev) => [created, ...prev]);
        setEditingContractDocId(created.id);
      }
      toast({ title: "Contrato salvo no banco de arquivos!" });
    } catch (err) {
      toast({ title: "Erro ao salvar contrato", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSavingContract(false); }
  };

  // Regimento interno — mesma lógica de generateContract/saveContract acima,
  // só usando os modelos kind="regimento" e docType "regimento_interno".
  const generateRegimento = async () => {
    if (selectedRegimentoTemplateId === "") { toast({ title: "Escolha um modelo de regimento", variant: "destructive" }); return; }
    setGeneratingRegimento(true);
    try {
      const { text } = await api.rhDp.employees.contractPreview(employee.id, selectedRegimentoTemplateId);
      setRegimentoDraftText(text);
      setEditingRegimentoDocId(null);
    } catch (err) {
      toast({ title: "Erro ao gerar regimento", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setGeneratingRegimento(false); }
  };

  const saveRegimento = async () => {
    if (!regimentoDraftText.trim()) { toast({ title: "O regimento está vazio", variant: "destructive" }); return; }
    setSavingRegimento(true);
    try {
      const templateName = templates.find((t) => t.id === selectedRegimentoTemplateId)?.name ?? "Regimento interno";
      if (editingRegimentoDocId) {
        const updated = await api.rhDp.employeeDocuments.update(employee.id, editingRegimentoDocId, { textContent: regimentoDraftText });
        setDocuments((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      } else {
        const created = await api.rhDp.employeeDocuments.saveText(employee.id, { docType: "regimento_interno", label: templateName, textContent: regimentoDraftText });
        setDocuments((prev) => [created, ...prev]);
        setEditingRegimentoDocId(created.id);
      }
      toast({ title: "Regimento salvo no banco de arquivos!" });
    } catch (err) {
      toast({ title: "Erro ao salvar regimento", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSavingRegimento(false); }
  };

  // Confirmação de leitura do Propósito (Missão/Visão/Valores) — assinatura
  // simples (mesmo espírito da assinatura do espelho de ponto): vira um
  // documento no banco de arquivos do colaborador, com o texto vigente no
  // momento da confirmação (não muda retroativamente se o admin editar
  // depois — igual ao "congelado" já usado em outros lugares do RH).
  const confirmProposito = async () => {
    if (!purpose || confirmingProposito) return;
    setConfirmingProposito(true);
    try {
      const textContent = `Missão: ${purpose.companyMission || "—"}\n\nVisão: ${purpose.companyVision || "—"}\n\nValores: ${purpose.companyValues || "—"}`;
      const created = await api.rhDp.employeeDocuments.saveText(employee.id, {
        docType: "proposito_confirmado", label: "Confirmação de leitura — Missão, Visão e Valores", textContent,
      });
      setDocuments((prev) => [created, ...prev]);
      toast({ title: "Leitura confirmada!" });
    } catch (err) {
      toast({ title: "Erro ao confirmar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setConfirmingProposito(false); }
  };

  const finalize = async () => {
    if (finalizing) return;
    setFinalizing(true);
    try {
      const updated = await api.rhDp.employees.finalizeHiring(employee.id);
      onSaved(updated);
      toast({ title: "Contratação finalizada! 🎉" });
      onClose();
    } catch (err) {
      toast({ title: "Erro ao finalizar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setFinalizing(false); }
  };

  const reopen = async () => {
    try {
      const updated = await api.rhDp.employees.reopenHiring(employee.id);
      onSaved(updated);
      toast({ title: "Contratação reaberta" });
    } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  // Link público (sem login) pro candidato/colaborador subir os próprios
  // documentos de admissão — pedido 10/09 ("criar link para o candidato
  // fazer o upload dos documentos"). Geração é idempotente (mantém o token
  // se já existir); revogar é a única forma de invalidar/trocar o link.
  const uploadLinkUrl = uploadToken
    ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/contratacao-documentos/${uploadToken}`
    : null;

  const generateUploadLink = async () => {
    setLinkBusy(true);
    try {
      const { token } = await api.rhDp.documentsUploadLink.generate(employee.id);
      setUploadToken(token);
    } catch (err) {
      toast({ title: "Erro ao gerar link", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setLinkBusy(false); }
  };

  const copyUploadLink = () => {
    if (!uploadLinkUrl) return;
    navigator.clipboard.writeText(uploadLinkUrl)
      .then(() => toast({ title: "Link copiado! Envie para o candidato." }))
      .catch(() => toast({ title: uploadLinkUrl }));
  };

  const revokeUploadLink = async () => {
    if (!window.confirm("Revogar este link? Quem já tiver o link não vai mais conseguir enviar documentos por ele.")) return;
    setLinkBusy(true);
    try {
      await api.rhDp.documentsUploadLink.revoke(employee.id);
      setUploadToken(null);
    } catch { toast({ title: "Erro ao revogar link", variant: "destructive" }); }
    finally { setLinkBusy(false); }
  };

  const contractDocs = documents.filter((d) => d.docType === "contrato_trabalho");
  const regimentoDocs = documents.filter((d) => d.docType === "regimento_interno");
  const KNOWN_TEXT_DOC_TYPES = ["contrato_trabalho", "contrato_trabalho_assinado", "regimento_interno", "regimento_interno_assinado", "proposito_confirmado"];
  const otherDocs = documents.filter((d) =>
    !HIRING_DOC_TYPES.some((t) => t.key === d.docType) && !KNOWN_TEXT_DOC_TYPES.includes(d.docType));
  const signedDocs = documents.filter((d) => d.docType === "contrato_trabalho_assinado");
  const regimentoSignedDocs = documents.filter((d) => d.docType === "regimento_interno_assinado");
  const propositoConfirmation = documents.find((d) => d.docType === "proposito_confirmado") ?? null;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="shk-card w-full max-w-2xl p-6 my-8 bg-white space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold flex items-center gap-2 flex-wrap">
            {employee.name}
            {employee.hiringStatus === "em_contratacao" ? (
              <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border-amber-200">Em contratação</span>
            ) : (
              <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-green-50 text-green-700 border-green-100">Ativo</span>
            )}
          </h3>
          <button onClick={onClose}><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>

        <div className="flex gap-1.5 flex-wrap">
          {([
            { key: "dados", label: "Dados, cargo e escala", icon: IdCard },
            { key: "documentos", label: "Documentos", icon: FolderArchive },
            { key: "contrato", label: "Contrato de trabalho", icon: FileSignature },
            { key: "regimento", label: "Regimento interno", icon: Archive },
            { key: "proposito", label: "Propósito", icon: Sparkles },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setTab(key)} data-testid={`hiring-tab-${key}`}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${tab === key ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>

        <div className="max-h-[55vh] overflow-y-auto pr-1 space-y-3">
          {tab === "dados" && (
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 text-xs">Nome
                <input value={draft.name ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
                  data-testid="input-hiring-name"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Cargo
                <input value={draft.role ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, role: ev.target.value })}
                  data-testid="input-hiring-role"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Função
                <input value={draft.jobFunction ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, jobFunction: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Telefone
                <input value={draft.phone ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, phone: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">E-mail
                <input value={draft.email ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, email: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">CPF
                <input value={draft.cpf ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, cpf: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">RG
                <input value={draft.rg ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, rg: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Nascimento
                <input type="date" value={draft.birthDate ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, birthDate: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Admissão
                <input type="date" value={draft.admissionDate ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, admissionDate: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Tipo de contrato
                <select value={draft.contractType ?? ""} disabled={!canEdit}
                  onChange={(ev) => setDraft({ ...draft, contractType: (ev.target.value || null) as Employee["contractType"] })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white disabled:opacity-60">
                  <option value="">—</option>
                  <option value="clt">CLT</option>
                  <option value="pj">PJ</option>
                  <option value="estagio">Estágio</option>
                </select>
              </label>
              <label className="text-xs">Salário (R$)
                <input type="number" min={0} disabled={!canEdit} value={draft.salaryCents != null ? draft.salaryCents / 100 : ""}
                  onChange={(ev) => setDraft({ ...draft, salaryCents: ev.target.value ? Math.round(Number(ev.target.value) * 100) : null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Loja
                <select value={draft.storeId ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, storeId: ev.target.value ? Number(ev.target.value) : null })}
                  data-testid="select-hiring-store"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white disabled:opacity-60">
                  <option value="">—</option>
                  {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="text-xs">Escala
                <select value={draft.shiftId ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, shiftId: ev.target.value ? Number(ev.target.value) : null })}
                  data-testid="select-hiring-shift"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white disabled:opacity-60">
                  <option value="">—</option>
                  {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}{s.type === "flexible" ? " (livre)" : ""}</option>)}
                </select>
              </label>
              <label className="text-xs">Dias de contrato de experiência
                <input type="number" min={0} disabled={!canEdit} value={draft.experienceDays ?? ""}
                  onChange={(ev) => setDraft({ ...draft, experienceDays: ev.target.value ? Math.round(Number(ev.target.value)) : null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="col-span-2 text-xs">Endereço
                <input value={draft.address ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, address: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Número
                <input value={draft.addressNumber ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, addressNumber: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Bairro
                <input value={draft.neighborhood ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, neighborhood: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Cidade
                <input value={draft.city ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, city: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">UF
                <input value={draft.state ?? ""} disabled={!canEdit} maxLength={2} onChange={(ev) => setDraft({ ...draft, state: ev.target.value.toUpperCase() })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">CEP
                <input value={draft.zipCode ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, zipCode: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm disabled:opacity-60" />
              </label>
              <label className="text-xs">Estado civil
                <select value={draft.maritalStatus ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, maritalStatus: ev.target.value || null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white disabled:opacity-60">
                  <option value="">—</option>
                  <option value="solteiro">Solteiro(a)</option>
                  <option value="casado">Casado(a)</option>
                  <option value="divorciado">Divorciado(a)</option>
                  <option value="viuvo">Viúvo(a)</option>
                  <option value="uniao_estavel">União estável</option>
                </select>
              </label>
              <label className="text-xs">Grau de escolaridade
                <select value={draft.educationLevel ?? ""} disabled={!canEdit} onChange={(ev) => setDraft({ ...draft, educationLevel: ev.target.value || null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white disabled:opacity-60">
                  <option value="">—</option>
                  <option value="fundamental_incompleto">Fundamental incompleto</option>
                  <option value="fundamental_completo">Fundamental completo</option>
                  <option value="medio_incompleto">Médio incompleto</option>
                  <option value="medio_completo">Médio completo</option>
                  <option value="superior_incompleto">Superior incompleto</option>
                  <option value="superior_completo">Superior completo</option>
                  <option value="pos_graduacao">Pós-graduação</option>
                </select>
              </label>
              {canEdit && (
                <button onClick={saveDados} disabled={savingDados} data-testid="button-save-hiring-dados"
                  className="col-span-2 flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                  <Save className="w-3.5 h-3.5" /> {savingDados ? "Salvando..." : "Salvar dados"}
                </button>
              )}
            </div>
          )}

          {tab === "documentos" && (
            <div className="space-y-3">
              {canEdit && (
                <div className="border border-dashed border-primary/30 bg-primary/5 rounded-xl p-3 space-y-2">
                  <p className="text-xs font-bold flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5" /> Link para o candidato enviar os documentos</p>
                  <p className="text-[11px] text-muted-foreground">Gere um link e envie por WhatsApp/e-mail — o próprio candidato sobe RG, CPF, foto 3x4 etc. sem precisar de login.</p>
                  {uploadLinkUrl ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[11px] text-muted-foreground truncate flex-1 min-w-[120px]">{uploadLinkUrl}</p>
                      <button onClick={copyUploadLink} data-testid="button-copy-upload-link"
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold"><Copy className="w-3.5 h-3.5" /> Copiar</button>
                      <button onClick={revokeUploadLink} disabled={linkBusy} data-testid="button-revoke-upload-link"
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-red-200 text-red-500 text-xs font-semibold disabled:opacity-40"><XCircle className="w-3.5 h-3.5" /> Revogar</button>
                    </div>
                  ) : (
                    <button onClick={generateUploadLink} disabled={linkBusy} data-testid="button-generate-upload-link"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                      <Link2 className="w-3.5 h-3.5" /> {linkBusy ? "Gerando..." : "Gerar link"}
                    </button>
                  )}
                </div>
              )}

              {loadingDocs ? (
                <div className="h-16 rounded-xl bg-secondary animate-pulse" />
              ) : (
                <>
                  {HIRING_DOC_TYPES.map(({ key, label }) => {
                    const files = documents.filter((d) => d.docType === key);
                    return (
                      <div key={key} className="border border-border rounded-xl p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-bold">{label}</p>
                          {canEdit && (
                            <label className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold cursor-pointer shrink-0 ${uploadingType === key ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary hover:bg-primary/20"}`}>
                              <Upload className="w-3 h-3" /> {uploadingType === key ? "Enviando..." : "Enviar"}
                              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploadingType === key}
                                onChange={(ev) => { const f = ev.target.files?.[0]; if (f) uploadDoc(key, undefined, f); ev.target.value = ""; }} />
                            </label>
                          )}
                        </div>
                        {files.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {files.map((f) => (
                              <div key={f.id} className="flex items-center gap-2 text-[11px] bg-secondary/30 rounded-lg px-2 py-1">
                                <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                <span className="flex-1 truncate">{f.fileName} · {formatDocSize(f.sizeBytes)}</span>
                                {canEdit ? (
                                  <input type="date" value={f.expiresAt ?? ""} onChange={(ev) => updateDocExpiry(f, ev.target.value)}
                                    title="Vencimento (opcional)" data-testid={`input-doc-expiry-${f.id}`}
                                    className={`text-[10px] px-1 py-0.5 rounded border shrink-0 w-[92px] ${f.expiresAt ? "border-amber-200 bg-amber-50 text-amber-700" : "border-border text-muted-foreground"}`} />
                                ) : f.expiresAt ? (
                                  <span className="text-[10px] shrink-0">vence {new Date(`${f.expiresAt}T12:00:00`).toLocaleDateString("pt-BR")}</span>
                                ) : null}
                                <a href={api.rhDp.employeeDocuments.fileUrl(employee.id, f.id)} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-secondary"><Eye className="w-3.5 h-3.5" /></a>
                                <a href={api.rhDp.employeeDocuments.fileUrl(employee.id, f.id)} download={f.fileName ?? undefined} className="p-1 rounded hover:bg-secondary"><Download className="w-3.5 h-3.5" /></a>
                                {canEdit && <button onClick={() => removeDoc(f)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="border border-dashed border-border rounded-xl p-3 space-y-2">
                    <p className="text-xs font-bold">Outro documento</p>
                    {canEdit && (
                      <div className="flex gap-2">
                        <input value={customLabel} onChange={(ev) => setCustomLabel(ev.target.value)} placeholder="Nome do documento"
                          className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs" />
                        <label className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-bold cursor-pointer shrink-0 ${uploadingType === "outro" ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary hover:bg-primary/20"}`}>
                          <Upload className="w-3 h-3" /> {uploadingType === "outro" ? "Enviando..." : "Enviar"}
                          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploadingType === "outro" || !customLabel.trim()}
                            onChange={(ev) => { const f = ev.target.files?.[0]; if (f) { uploadDoc("outro", customLabel.trim() || undefined, f); setCustomLabel(""); } ev.target.value = ""; }} />
                        </label>
                      </div>
                    )}
                    {otherDocs.length > 0 && (
                      <div className="space-y-1">
                        {otherDocs.map((f) => (
                          <div key={f.id} className="flex items-center gap-2 text-[11px] bg-secondary/30 rounded-lg px-2 py-1">
                            <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <span className="flex-1 truncate">{f.label || f.fileName} · {formatDocSize(f.sizeBytes)}</span>
                            {canEdit ? (
                              <input type="date" value={f.expiresAt ?? ""} onChange={(ev) => updateDocExpiry(f, ev.target.value)}
                                title="Vencimento (opcional)" data-testid={`input-doc-expiry-${f.id}`}
                                className={`text-[10px] px-1 py-0.5 rounded border shrink-0 w-[92px] ${f.expiresAt ? "border-amber-200 bg-amber-50 text-amber-700" : "border-border text-muted-foreground"}`} />
                            ) : f.expiresAt ? (
                              <span className="text-[10px] shrink-0">vence {new Date(`${f.expiresAt}T12:00:00`).toLocaleDateString("pt-BR")}</span>
                            ) : null}
                            <a href={api.rhDp.employeeDocuments.fileUrl(employee.id, f.id)} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-secondary"><Eye className="w-3.5 h-3.5" /></a>
                            <a href={api.rhDp.employeeDocuments.fileUrl(employee.id, f.id)} download={f.fileName ?? undefined} className="p-1 rounded hover:bg-secondary"><Download className="w-3.5 h-3.5" /></a>
                            {canEdit && <button onClick={() => removeDoc(f)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "contrato" && (
            <div className="space-y-3">
              {contractTemplatesList.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nenhum modelo de contrato cadastrado ainda — crie um em "Modelos de contrato" na tela de Contratação.</p>
              ) : (
                <div className="flex items-end gap-2">
                  <label className="flex-1 text-xs">Modelo
                    <select value={selectedTemplateId} onChange={(ev) => setSelectedTemplateId(ev.target.value ? Number(ev.target.value) : "")}
                      data-testid="select-contract-template"
                      className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                      {contractTemplatesList.map((t) => <option key={t.id} value={t.id}>{t.name}{t.contractType ? ` (${CONTRACT_LABELS[t.contractType]})` : ""}</option>)}
                    </select>
                  </label>
                  {canEdit && (
                    <button onClick={generateContract} disabled={generatingContract} data-testid="button-generate-contract"
                      className="px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40 shrink-0">
                      {generatingContract ? "Gerando..." : "Gerar contrato"}
                    </button>
                  )}
                </div>
              )}

              {contractDraftText && (
                <div className="space-y-2">
                  <textarea value={contractDraftText} disabled={!canEdit} onChange={(ev) => setContractDraftText(ev.target.value)}
                    rows={14} data-testid="textarea-contract-draft"
                    className="w-full px-3 py-2 rounded-xl border border-border text-xs font-mono resize-y disabled:opacity-70" />
                  <div className="flex gap-2 flex-wrap">
                    {canEdit && (
                      <button onClick={saveContract} disabled={savingContract} data-testid="button-save-contract"
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                        <Save className="w-3.5 h-3.5" /> {savingContract ? "Salvando..." : "Salvar no banco de arquivos"}
                      </button>
                    )}
                    <button onClick={() => printPlainText(contractDraftText, `Contrato — ${employee.name}`, toast)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-bold">
                      <Printer className="w-3.5 h-3.5" /> Imprimir
                    </button>
                  </div>
                </div>
              )}

              {contractDocs.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-bold">Contratos salvos</p>
                  {contractDocs.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-[11px] bg-secondary/30 rounded-lg px-2 py-1.5">
                      <FileSignature className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{d.label || "Contrato"} · {new Date(d.createdAt).toLocaleDateString("pt-BR")}</span>
                      <button onClick={() => { setContractDraftText(d.textContent ?? ""); setEditingContractDocId(d.id); }}
                        className="p-1 rounded hover:bg-secondary"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => printPlainText(d.textContent ?? "", d.label ?? "Contrato", toast)} className="p-1 rounded hover:bg-secondary"><Printer className="w-3.5 h-3.5" /></button>
                      {canEdit && <button onClick={() => removeDoc(d)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </div>
                  ))}
                </div>
              )}

              <div className="border border-dashed border-border rounded-xl p-3 space-y-2">
                <p className="text-xs font-bold">Contrato assinado (digitalizado)</p>
                {canEdit && (
                  <label className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-bold cursor-pointer w-fit ${uploadingType === "contrato_trabalho_assinado" ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary hover:bg-primary/20"}`}>
                    <Upload className="w-3 h-3" /> {uploadingType === "contrato_trabalho_assinado" ? "Enviando..." : "Enviar cópia assinada"}
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploadingType === "contrato_trabalho_assinado"}
                      onChange={(ev) => { const f = ev.target.files?.[0]; if (f) uploadDoc("contrato_trabalho_assinado", "Contrato assinado", f); ev.target.value = ""; }} />
                  </label>
                )}
                {signedDocs.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 text-[11px] bg-secondary/30 rounded-lg px-2 py-1">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{f.fileName} · {formatDocSize(f.sizeBytes)}</span>
                    <a href={api.rhDp.employeeDocuments.fileUrl(employee.id, f.id)} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-secondary"><Eye className="w-3.5 h-3.5" /></a>
                    {canEdit && <button onClick={() => removeDoc(f)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "regimento" && (
            <div className="space-y-3">
              {regimentoTemplatesList.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nenhum modelo de regimento cadastrado ainda — crie um em "Modelos de regimento interno" na tela de Contratação.</p>
              ) : (
                <div className="flex items-end gap-2">
                  <label className="flex-1 text-xs">Modelo
                    <select value={selectedRegimentoTemplateId} onChange={(ev) => setSelectedRegimentoTemplateId(ev.target.value ? Number(ev.target.value) : "")}
                      data-testid="select-regimento-template"
                      className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                      {regimentoTemplatesList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  {canEdit && (
                    <button onClick={generateRegimento} disabled={generatingRegimento} data-testid="button-generate-regimento"
                      className="px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40 shrink-0">
                      {generatingRegimento ? "Gerando..." : "Gerar regimento"}
                    </button>
                  )}
                </div>
              )}

              {regimentoDraftText && (
                <div className="space-y-2">
                  <textarea value={regimentoDraftText} disabled={!canEdit} onChange={(ev) => setRegimentoDraftText(ev.target.value)}
                    rows={14} data-testid="textarea-regimento-draft"
                    className="w-full px-3 py-2 rounded-xl border border-border text-xs font-mono resize-y disabled:opacity-70" />
                  <div className="flex gap-2 flex-wrap">
                    {canEdit && (
                      <button onClick={saveRegimento} disabled={savingRegimento} data-testid="button-save-regimento"
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                        <Save className="w-3.5 h-3.5" /> {savingRegimento ? "Salvando..." : "Salvar no banco de arquivos"}
                      </button>
                    )}
                    <button onClick={() => printPlainText(regimentoDraftText, `Regimento interno — ${employee.name}`, toast)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-bold">
                      <Printer className="w-3.5 h-3.5" /> Imprimir
                    </button>
                  </div>
                </div>
              )}

              {regimentoDocs.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-bold">Regimentos salvos</p>
                  {regimentoDocs.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-[11px] bg-secondary/30 rounded-lg px-2 py-1.5">
                      <Archive className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{d.label || "Regimento"} · {new Date(d.createdAt).toLocaleDateString("pt-BR")}</span>
                      <button onClick={() => { setRegimentoDraftText(d.textContent ?? ""); setEditingRegimentoDocId(d.id); }}
                        className="p-1 rounded hover:bg-secondary"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => printPlainText(d.textContent ?? "", d.label ?? "Regimento", toast)} className="p-1 rounded hover:bg-secondary"><Printer className="w-3.5 h-3.5" /></button>
                      {canEdit && <button onClick={() => removeDoc(d)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </div>
                  ))}
                </div>
              )}

              <div className="border border-dashed border-border rounded-xl p-3 space-y-2">
                <p className="text-xs font-bold">Regimento assinado (digitalizado)</p>
                {canEdit && (
                  <label className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-bold cursor-pointer w-fit ${uploadingType === "regimento_interno_assinado" ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary hover:bg-primary/20"}`}>
                    <Upload className="w-3 h-3" /> {uploadingType === "regimento_interno_assinado" ? "Enviando..." : "Enviar cópia assinada"}
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploadingType === "regimento_interno_assinado"}
                      onChange={(ev) => { const f = ev.target.files?.[0]; if (f) uploadDoc("regimento_interno_assinado", "Regimento assinado", f); ev.target.value = ""; }} />
                  </label>
                )}
                {regimentoSignedDocs.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 text-[11px] bg-secondary/30 rounded-lg px-2 py-1">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{f.fileName} · {formatDocSize(f.sizeBytes)}</span>
                    <a href={api.rhDp.employeeDocuments.fileUrl(employee.id, f.id)} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-secondary"><Eye className="w-3.5 h-3.5" /></a>
                    {canEdit && <button onClick={() => removeDoc(f)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "proposito" && (
            <div className="space-y-3">
              {!purpose || (!purpose.companyMission && !purpose.companyVision && !purpose.companyValues) ? (
                <p className="text-[11px] text-muted-foreground">Ainda não foi cadastrado o Propósito da empresa — cadastre em "Propósito da empresa" na tela de Contratação.</p>
              ) : (
                <div className="space-y-2">
                  {purpose.companyMission && (
                    <div className="border border-border rounded-xl p-3">
                      <p className="text-xs font-bold mb-1">Missão</p>
                      <p className="text-xs whitespace-pre-wrap">{purpose.companyMission}</p>
                    </div>
                  )}
                  {purpose.companyVision && (
                    <div className="border border-border rounded-xl p-3">
                      <p className="text-xs font-bold mb-1">Visão</p>
                      <p className="text-xs whitespace-pre-wrap">{purpose.companyVision}</p>
                    </div>
                  )}
                  {purpose.companyValues && (
                    <div className="border border-border rounded-xl p-3">
                      <p className="text-xs font-bold mb-1">Valores</p>
                      <p className="text-xs whitespace-pre-wrap">{purpose.companyValues}</p>
                    </div>
                  )}
                </div>
              )}

              {propositoConfirmation ? (
                <p className="text-[11px] text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5" /> Leitura confirmada em {new Date(propositoConfirmation.createdAt).toLocaleDateString("pt-BR")}.
                </p>
              ) : canEdit ? (
                <button onClick={confirmProposito} disabled={confirmingProposito} data-testid="button-confirm-proposito"
                  className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                  <CheckCircle className="w-3.5 h-3.5" /> {confirmingProposito ? "Confirmando..." : "Confirmar leitura e concordância"}
                </button>
              ) : null}
            </div>
          )}
        </div>

        {canEdit && (
          <div className="pt-2 border-t border-border">
            {employee.hiringStatus === "em_contratacao" ? (
              <button onClick={finalize} disabled={finalizing} data-testid="button-finalize-hiring"
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold disabled:opacity-40">
                <CheckCircle className="w-4 h-4" /> {finalizing ? "Finalizando..." : "Finalizar contratação"}
              </button>
            ) : (
              <button onClick={reopen} data-testid="button-reopen-hiring"
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-border text-xs font-bold text-muted-foreground">
                <RotateCcw className="w-3.5 h-3.5" /> Reabrir contratação
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Contratacoes({ canEdit, openEmployeeId, onOpenedConsumed }: {
  canEdit: boolean; openEmployeeId: number | null; onOpenedConsumed: () => void;
}) {
  const { toast } = useToast();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [templates, setTemplates] = useState<EmployeeContractTemplate[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showRegimentoTemplates, setShowRegimentoTemplates] = useState(false);

  // Propósito da empresa (Missão/Visão/Valores, pedido 10/09) — texto único
  // por tenant, apresentado pro colaborador confirmar na aba "Propósito" do
  // assistente de contratação (ver HiringWizard).
  const [showPurpose, setShowPurpose] = useState(false);
  const [purpose, setPurpose] = useState({ companyMission: "", companyVision: "", companyValues: "" });
  const [savingPurpose, setSavingPurpose] = useState(false);

  const load = () => api.rhDp.employees.list().then(setEmployees).catch(() => {});
  const loadTemplates = () => api.rhDp.contractTemplates.list().then(setTemplates).catch(() => {});
  const loadPurpose = () => api.rhDp.settings.get().then((s) => setPurpose({
    companyMission: s.companyMission ?? "", companyVision: s.companyVision ?? "", companyValues: s.companyValues ?? "",
  })).catch(() => {});
  useEffect(() => {
    load();
    loadTemplates();
    loadPurpose();
    api.stores.list(true).then(setStores).catch(() => {});
    api.rhDp.shifts.list().then(setShifts).catch(() => {});
  }, []);

  const savePurpose = async () => {
    if (savingPurpose) return;
    setSavingPurpose(true);
    try {
      await api.rhDp.settings.update(purpose);
      toast({ title: "Propósito da empresa salvo!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSavingPurpose(false); }
  };

  useEffect(() => {
    if (openEmployeeId != null) {
      setOpenId(openEmployeeId);
      onOpenedConsumed();
    }
  }, [openEmployeeId, onOpenedConsumed]);

  const startNewHire = async () => {
    const name = window.prompt("Nome do novo colaborador (contratação sem candidatura):");
    if (!name?.trim()) return;
    try {
      const emp = await api.rhDp.hiring.start({ name: name.trim() });
      setEmployees((prev) => [...prev, emp]);
      setOpenId(emp.id);
    } catch (err) {
      toast({ title: "Erro ao iniciar contratação", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const emContratacao = employees.filter((e) => e.hiringStatus === "em_contratacao");
  const ativos = employees.filter((e) => e.hiringStatus !== "em_contratacao");
  const openEmployee = employees.find((e) => e.id === openId) ?? null;

  return (
    <div className="space-y-4">
      {!canEdit && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Você só tem acesso de visualização ao RH — peça ao administrador para liberar edição.
        </p>
      )}

      <div className="shk-card p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs font-bold flex items-center gap-1.5"><UserPlus className="w-3.5 h-3.5 text-primary" /> Contratações em andamento</p>
          {canEdit && (
            <button onClick={startNewHire} data-testid="button-new-hiring"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-primary text-white text-[11px] font-bold">
              <Plus className="w-3 h-3" /> Nova contratação
            </button>
          )}
        </div>
        {emContratacao.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nenhuma contratação em andamento. Aprove um candidato e clique em "Iniciar contratação", ou comece uma avulsa acima.</p>
        ) : (
          <div className="space-y-1.5">
            {emContratacao.map((e) => (
              <button key={e.id} onClick={() => setOpenId(e.id)} data-testid={`hiring-in-progress-${e.id}`}
                className="w-full text-left flex items-center gap-2 p-2.5 rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 transition">
                <FolderArchive className="w-4 h-4 text-amber-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold">{e.name}</p>
                  <p className="text-[11px] text-muted-foreground">{e.role || "Cargo não definido"}{e.storeName ? ` · ${e.storeName}` : ""}</p>
                </div>
                <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border-amber-200 shrink-0">Em andamento</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="shk-card p-4 space-y-2">
        <button onClick={() => setShowTemplates((v) => !v)} className="w-full flex items-center justify-between" data-testid="button-toggle-templates">
          <p className="text-xs font-bold flex items-center gap-1.5"><FileSignature className="w-3.5 h-3.5 text-primary" /> Modelos de contrato de trabalho</p>
          {showTemplates ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
        {showTemplates && (
          <ContractTemplatesManager canEdit={canEdit} templates={templates} onChanged={loadTemplates}
            kind="contrato" defaultBodyText={DEFAULT_CONTRACT_TEMPLATE} newButtonLabel="Novo modelo" />
        )}
      </div>

      <div className="shk-card p-4 space-y-2">
        <button onClick={() => setShowRegimentoTemplates((v) => !v)} className="w-full flex items-center justify-between" data-testid="button-toggle-regimento-templates">
          <p className="text-xs font-bold flex items-center gap-1.5"><Archive className="w-3.5 h-3.5 text-primary" /> Modelos de regimento interno</p>
          {showRegimentoTemplates ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
        {showRegimentoTemplates && (
          <ContractTemplatesManager canEdit={canEdit} templates={templates} onChanged={loadTemplates}
            kind="regimento" defaultBodyText={DEFAULT_REGIMENTO_TEMPLATE} newButtonLabel="Novo modelo" />
        )}
      </div>

      <div className="shk-card p-4 space-y-2">
        <button onClick={() => setShowPurpose((v) => !v)} className="w-full flex items-center justify-between" data-testid="button-toggle-purpose">
          <p className="text-xs font-bold flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-primary" /> Propósito da empresa (Missão, Visão e Valores)</p>
          {showPurpose ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
        {showPurpose && (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">Texto único da empresa — o colaborador vê e confirma a leitura na aba "Propósito" ao ser contratado.</p>
            {canEdit ? (
              <>
                <label className="text-xs block">Missão
                  <textarea value={purpose.companyMission} onChange={(ev) => setPurpose({ ...purpose, companyMission: ev.target.value })}
                    rows={3} className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-xs resize-y" />
                </label>
                <label className="text-xs block">Visão
                  <textarea value={purpose.companyVision} onChange={(ev) => setPurpose({ ...purpose, companyVision: ev.target.value })}
                    rows={3} className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-xs resize-y" />
                </label>
                <label className="text-xs block">Valores
                  <textarea value={purpose.companyValues} onChange={(ev) => setPurpose({ ...purpose, companyValues: ev.target.value })}
                    rows={3} className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-xs resize-y" />
                </label>
                <button onClick={savePurpose} disabled={savingPurpose} data-testid="button-save-purpose"
                  className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                  <Save className="w-3.5 h-3.5" /> {savingPurpose ? "Salvando..." : "Salvar propósito"}
                </button>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">Nenhuma permissão de edição.</p>
            )}
          </div>
        )}
      </div>

      <div className="shk-card p-4 space-y-2">
        <p className="text-xs font-bold flex items-center gap-1.5"><IdCard className="w-3.5 h-3.5 text-primary" /> Colaboradores (banco de arquivos)</p>
        {ativos.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nenhum colaborador ainda.</p>
        ) : (
          <div className="space-y-1.5">
            {ativos.map((e) => (
              <button key={e.id} onClick={() => setOpenId(e.id)} data-testid={`employee-filebank-${e.id}`}
                className={`w-full text-left flex items-center gap-2 p-2.5 rounded-xl border border-border hover:bg-secondary/40 transition ${!e.isActive ? "opacity-60" : ""}`}>
                <FolderArchive className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold">{e.name}</p>
                  <p className="text-[11px] text-muted-foreground">{e.role || "Sem cargo"}{e.storeName ? ` · ${e.storeName}` : ""}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {openEmployee && (
        <HiringWizard employee={openEmployee} stores={stores} shifts={shifts} templates={templates} canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onSaved={(updated) => setEmployees((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))} />
      )}
    </div>
  );
}

// ── Colaboradores ────────────────────────────────────────────────────────
function Colaboradores({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<Partial<Employee> | null>(null);
  const [saving, setSaving] = useState(false);
  const [expiringDocs, setExpiringDocs] = useState<{ id: number; employeeId: number; employeeName: string; docType: string; label: string | null; expiresAt: string }[]>([]);

  const load = () => api.rhDp.employees.list().then(setEmployees).catch(() => {});
  useEffect(() => {
    load();
    api.rhDp.shifts.list().then(setShifts).catch(() => {});
    api.stores.list(true).then(setStores).catch(() => {});
    api.admin.users.list().then(setUsers).catch(() => {});
    api.rhDp.employeeDocuments.expiring().then(setExpiringDocs).catch(() => {});
  }, []);

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.name?.trim()) { toast({ title: "Informe o nome", variant: "destructive" }); return; }
    setSaving(true);
    try {
      if (editing.id) await api.rhDp.employees.update(editing.id, editing);
      else await api.rhDp.employees.create(editing);
      setEditing(null);
      load();
      toast({ title: "Colaborador salvo!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const remove = async (e: Employee) => {
    if (!window.confirm(`Excluir o cadastro de ${e.name}? O histórico de ponto dele é mantido.`)) return;
    try { await api.rhDp.employees.remove(e.id); load(); } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  const usersAvailable = users.filter((u) => !employees.some((e) => e.userId === u.id && e.id !== editing?.id));

  return (
    <div className="space-y-3">
      {expiringDocs.length > 0 && (
        <div className="shk-card p-3 space-y-1.5 border-amber-200 bg-amber-50/50" data-testid="card-documents-expiring">
          <p className="text-xs font-bold text-amber-800 flex items-center gap-1.5"><FolderArchive className="w-3.5 h-3.5" /> Documentos vencendo (GED)</p>
          {expiringDocs.map((d) => {
            const days = Math.round((new Date(`${d.expiresAt}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
            return (
              <p key={d.id} className="text-[11px] text-amber-800" data-testid={`document-expiring-${d.id}`}>
                <span className="font-semibold">{d.employeeName}</span> — {d.label || d.docType}: {days < 0 ? "vencido" : `vence em ${days}d`} ({new Date(`${d.expiresAt}T12:00:00`).toLocaleDateString("pt-BR")})
              </p>
            );
          })}
        </div>
      )}
      {canEdit && (
        <button onClick={() => setEditing({ isActive: true })} data-testid="button-new-employee"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold">
          <Plus className="w-3.5 h-3.5" /> Novo colaborador
        </button>
      )}
      {employees.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <UserSquare2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhum colaborador cadastrado</p>
        </div>
      ) : (
        <div className="space-y-2">
          {employees.map((e) => (
            <div key={e.id} className={`shk-card p-4 flex items-center gap-3 ${!e.isActive ? "opacity-60" : ""}`} data-testid={`employee-${e.id}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-sm">{e.name}</p>
                  {!e.isActive && <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">Inativo</span>}
                  {e.contractType && <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border-blue-100">{CONTRACT_LABELS[e.contractType]}</span>}
                  {e.userId && <span className="text-[10px] text-muted-foreground">(login: {e.userName ?? "—"})</span>}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {e.role || "Sem cargo"}{e.storeName ? ` · ${e.storeName}` : ""}{e.shiftName ? ` · ${e.shiftName}` : ""}
                </p>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <button onClick={() => setEditing(e)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => remove(e)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg p-6 my-8 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">{editing.id ? "Editar colaborador" : "Novo colaborador"}</h3>
              <button onClick={() => setEditing(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 text-xs">
                Nome
                <input value={editing.name ?? ""} onChange={(ev) => setEditing({ ...editing, name: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" data-testid="input-employee-name" />
              </label>
              <label className="text-xs">
                Cargo
                <input value={editing.role ?? ""} onChange={(ev) => setEditing({ ...editing, role: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Função
                <input value={editing.jobFunction ?? ""} onChange={(ev) => setEditing({ ...editing, jobFunction: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Telefone
                <input value={editing.phone ?? ""} onChange={(ev) => setEditing({ ...editing, phone: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                E-mail
                <input value={editing.email ?? ""} onChange={(ev) => setEditing({ ...editing, email: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                CPF
                <input value={editing.cpf ?? ""} onChange={(ev) => setEditing({ ...editing, cpf: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                RG
                <input value={editing.rg ?? ""} onChange={(ev) => setEditing({ ...editing, rg: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Nascimento
                <input type="date" value={editing.birthDate ?? ""} onChange={(ev) => setEditing({ ...editing, birthDate: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Admissão
                <input type="date" value={editing.admissionDate ?? ""} onChange={(ev) => setEditing({ ...editing, admissionDate: ev.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Contrato
                <select value={editing.contractType ?? ""} onChange={(ev) => setEditing({ ...editing, contractType: (ev.target.value || null) as Employee["contractType"] })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                  <option value="">—</option>
                  <option value="clt">CLT</option>
                  <option value="pj">PJ</option>
                  <option value="estagio">Estágio</option>
                </select>
              </label>
              <label className="text-xs">
                Salário (R$)
                <input type="number" min={0} value={editing.salaryCents != null ? editing.salaryCents / 100 : ""}
                  onChange={(ev) => setEditing({ ...editing, salaryCents: ev.target.value ? Math.round(Number(ev.target.value) * 100) : null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Loja
                <select value={editing.storeId ?? ""} onChange={(ev) => setEditing({ ...editing, storeId: ev.target.value ? Number(ev.target.value) : null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                  <option value="">—</option>
                  {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="text-xs">
                Escala
                <select value={editing.shiftId ?? ""} onChange={(ev) => setEditing({ ...editing, shiftId: ev.target.value ? Number(ev.target.value) : null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                  <option value="">—</option>
                  {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}{s.type === "flexible" ? " (livre)" : ""}</option>)}
                </select>
              </label>
              <label className="text-xs col-span-2">
                Login vinculado (habilita bater ponto pelo próprio usuário)
                <select value={editing.userId ?? ""} onChange={(ev) => setEditing({ ...editing, userId: ev.target.value ? Number(ev.target.value) : null })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white" data-testid="select-employee-user">
                  <option value="">Sem login vinculado</option>
                  {usersAvailable.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs font-medium col-span-2">
                <input type="checkbox" checked={editing.isActive !== false} onChange={(ev) => setEditing({ ...editing, isActive: ev.target.checked })} />
                Ativo
              </label>
            </div>
            <button onClick={save} disabled={saving} data-testid="button-save-employee"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              <Save className="w-3.5 h-3.5" /> {saving ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Escalas ──────────────────────────────────────────────────────────────
function Escalas({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [editing, setEditing] = useState<Partial<WorkShift> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.rhDp.shifts.list().then(setShifts).catch(() => {});
  useEffect(() => { load(); }, []);

  const toggleWeekday = (d: number) => {
    if (!editing) return;
    const cur = editing.weekdays ?? [1, 2, 3, 4, 5];
    setEditing({ ...editing, weekdays: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort() });
  };

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.name?.trim()) { toast({ title: "Preencha o nome da escala", variant: "destructive" }); return; }
    if (editing.type !== "flexible" && (!editing.startTime || !editing.endTime)) {
      toast({ title: "Preencha início e fim", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      if (editing.id) await api.rhDp.shifts.update(editing.id, editing);
      else await api.rhDp.shifts.create(editing);
      setEditing(null);
      load();
      toast({ title: "Escala salva!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const remove = async (s: WorkShift) => {
    if (!window.confirm(`Excluir a escala "${s.name}"? Colaboradores vinculados ficam sem escala.`)) return;
    try { await api.rhDp.shifts.remove(s.id); load(); } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  return (
    <div className="space-y-3">
      {canEdit && (
        <button onClick={() => setEditing({ type: "fixed", weekdays: [1, 2, 3, 4, 5] })} data-testid="button-new-shift"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold">
          <Plus className="w-3.5 h-3.5" /> Nova escala
        </button>
      )}
      {shifts.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhuma escala cadastrada</p>
        </div>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <div key={s.id} className="shk-card p-4 flex items-center gap-3" data-testid={`shift-${s.id}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-bold text-sm">{s.name}</p>
                  {s.type === "flexible" && <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border-blue-100">Livre</span>}
                </div>
                {s.type === "flexible" ? (
                  <p className="text-[11px] text-muted-foreground">Sem horário fixo — sem cobrança de expediente esperado, sem ponto obrigatório.</p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {s.startTime}–{s.endTime}{s.breakStart && s.breakEnd ? ` (intervalo ${s.breakStart}–${s.breakEnd})` : ""} · {formatMinutes(s.expectedMinutesPerDay ?? 0)}/dia · {s.weekdays.map((d) => WEEKDAY_LABELS[d]).join(", ")}
                  </p>
                )}
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <button onClick={() => setEditing(s)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => remove(s)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-md p-6 my-8 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">{editing.id ? "Editar escala" : "Nova escala"}</h3>
              <button onClick={() => setEditing(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <label className="text-xs block">
              Nome
              <input value={editing.name ?? ""} onChange={(ev) => setEditing({ ...editing, name: ev.target.value })}
                placeholder="Comercial 08-18" className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
            </label>
            <div>
              <p className="text-xs mb-1">Tipo</p>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => setEditing({ ...editing, type: "fixed" })} data-testid="button-shift-type-fixed"
                  className={`flex-1 px-3 py-2 rounded-xl text-xs font-semibold border ${editing.type !== "flexible" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                  Fixa (horário definido)
                </button>
                <button type="button" onClick={() => setEditing({ ...editing, type: "flexible" })} data-testid="button-shift-type-flexible"
                  className={`flex-1 px-3 py-2 rounded-xl text-xs font-semibold border ${editing.type === "flexible" ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                  Livre (sem horário)
                </button>
              </div>
            </div>
            {editing.type === "flexible" ? (
              <p className="text-[11px] text-muted-foreground bg-secondary/40 rounded-xl px-3 py-2">
                Escala livre: o banco de horas só soma o que o colaborador trabalhar, sem expediente esperado e sem exigir bater ponto pra liberar o login.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs">
                    Início
                    <input type="time" value={editing.startTime ?? ""} onChange={(ev) => setEditing({ ...editing, startTime: ev.target.value })}
                      className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
                  </label>
                  <label className="text-xs">
                    Fim
                    <input type="time" value={editing.endTime ?? ""} onChange={(ev) => setEditing({ ...editing, endTime: ev.target.value })}
                      className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
                  </label>
                  <label className="text-xs">
                    Intervalo início (opcional)
                    <input type="time" value={editing.breakStart ?? ""} onChange={(ev) => setEditing({ ...editing, breakStart: ev.target.value || null })}
                      className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
                  </label>
                  <label className="text-xs">
                    Intervalo fim (opcional)
                    <input type="time" value={editing.breakEnd ?? ""} onChange={(ev) => setEditing({ ...editing, breakEnd: ev.target.value || null })}
                      className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
                  </label>
                </div>
                <div>
                  <p className="text-xs mb-1">Dias da semana</p>
                  <div className="flex gap-1 flex-wrap">
                    {WEEKDAY_LABELS.map((label, d) => (
                      <button key={d} onClick={() => toggleWeekday(d)} type="button"
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${(editing.weekdays ?? []).includes(d) ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <button onClick={save} disabled={saving} data-testid="button-save-shift"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              <Save className="w-3.5 h-3.5" /> {saving ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const PONTO_KIND_LABELS: Record<TimeClockEntry["kind"], string> = {
  in: "Entrada", break_start: "Início intervalo", break_end: "Fim intervalo", out: "Saída",
};
const PONTO_SOURCE_LABELS: Record<TimeClockEntry["source"], string> = {
  self: "Colaborador", admin: "Manual", whatsapp: "WhatsApp",
};

// ── Ponto (gestão) ───────────────────────────────────────────────────────
function PontoAdmin({ canEdit, isAdmin }: { canEdit: boolean; isAdmin: boolean }) {
  const { toast } = useToast();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState(0);
  const [from, setFrom] = useState(firstOfMonthStr());
  const [to, setTo] = useState(todayStr());
  const [entries, setEntries] = useState<TimeClockEntry[]>([]);
  const [manual, setManual] = useState<{ kind: TimeClockEntry["kind"]; at: string } | null>(null);

  // Configuração da linha oficial de check-in de ponto por WhatsApp (uma por
  // tenant) — só admin edita; qualquer um com acesso ao módulo vê qual está.
  const [waSessions, setWaSessions] = useState<{ sessionKey: string; displayName: string | null; phoneNumber: string | null }[]>([]);
  const [checkInSessionKey, setCheckInSessionKey] = useState<string>("");
  const [facialRecognitionEnabled, setFacialRecognitionEnabled] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  useEffect(() => {
    api.chat.waSessions().then(setWaSessions).catch(() => {});
    api.rhDp.settings.get().then((s) => { setCheckInSessionKey(s.pontoCheckInSessionKey ?? ""); setFacialRecognitionEnabled(s.facialRecognitionEnabled); }).catch(() => {});
  }, []);
  const saveCheckInSession = async (value: string) => {
    setSavingSettings(true);
    try {
      await api.rhDp.settings.update({ pontoCheckInSessionKey: value || null });
      setCheckInSessionKey(value);
      toast({ title: value ? "Linha de check-in configurada" : "Check-in por WhatsApp desligado" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  };
  const saveFacialRecognition = async (value: boolean) => {
    setSavingSettings(true);
    try {
      await api.rhDp.settings.update({ facialRecognitionEnabled: value });
      setFacialRecognitionEnabled(value);
      toast({ title: value ? "Reconhecimento facial ligado" : "Reconhecimento facial desligado" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  };
  // Editar o dia inteiro (as até 4 seções numa tela só), em vez de lançar
  // seção por seção — cada campo em branco limpa a batida daquele tipo.
  const [dayEditor, setDayEditor] = useState<{
    employeeId: number; date: string;
    in: string; break_start: string; break_end: string; out: string;
    saving: boolean;
  } | null>(null);

  useEffect(() => { api.rhDp.employees.list().then(setEmployees).catch(() => {}); }, []);

  const load = () => {
    api.rhDp.reports.timesheet(`${from}T00:00:00`, `${to}T23:59:59`, employeeId || undefined).then(setEntries).catch(() => {});
  };
  useEffect(() => { load(); }, [from, to, employeeId]);

  const removeEntry = async (id: number) => {
    if (!window.confirm("Excluir esta batida?")) return;
    try { await api.rhDp.timeClockEntries.remove(id); load(); } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  // Admin conferiu uma batida sinalizada (duas fotos em pouco tempo via
  // WhatsApp) e decidiu manter como está — some da lista de pendências.
  const reviewEntry = async (id: number) => {
    try { await api.rhDp.timeClockEntries.review(id); load(); toast({ title: "Marcado como revisado" }); }
    catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  const launchManual = async () => {
    if (!employeeId || !manual) { toast({ title: "Selecione o colaborador e o tipo de batida", variant: "destructive" }); return; }
    try {
      await api.rhDp.employees.punch(employeeId, { kind: manual.kind, at: manual.at ? new Date(manual.at).toISOString() : undefined });
      setManual(null);
      load();
      toast({ title: "Ponto lançado" });
    } catch (err) {
      toast({ title: "Erro ao lançar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const openDayEditor = () => {
    setDayEditor({
      employeeId: employeeId || employees[0]?.id || 0,
      date: todayStr(),
      in: "", break_start: "", break_end: "", out: "",
      saving: false,
    });
  };

  // Recarrega as batidas já existentes do colaborador/dia escolhidos toda vez
  // que um dos dois muda (inclusive ao abrir o editor) — pré-preenche o
  // formulário em vez de abrir em branco.
  useEffect(() => {
    if (!dayEditor || !dayEditor.employeeId) return;
    api.rhDp.reports.timesheet(`${dayEditor.date}T00:00:00`, `${dayEditor.date}T23:59:59`, dayEditor.employeeId)
      .then((rows) => {
        const byKind = Object.fromEntries(rows.map((r) => [
          r.kind, new Date(r.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }),
        ]));
        setDayEditor((d) => d && ({
          ...d,
          in: byKind.in ?? "", break_start: byKind.break_start ?? "", break_end: byKind.break_end ?? "", out: byKind.out ?? "",
        }));
      }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayEditor?.employeeId, dayEditor?.date]);

  const saveDayEditor = async () => {
    if (!dayEditor || !dayEditor.employeeId) { toast({ title: "Selecione o colaborador", variant: "destructive" }); return; }
    setDayEditor({ ...dayEditor, saving: true });
    try {
      await api.rhDp.employees.setDay(dayEditor.employeeId, {
        date: dayEditor.date,
        in: dayEditor.in || null,
        break_start: dayEditor.break_start || null,
        break_end: dayEditor.break_end || null,
        out: dayEditor.out || null,
      });
      setDayEditor(null);
      load();
      toast({ title: "Ponto do dia salvo" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
      setDayEditor((d) => d && ({ ...d, saving: false }));
    }
  };

  return (
    <div className="space-y-3">
      <div className="shk-card p-4 space-y-1.5">
        <p className="text-xs font-semibold flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5 text-primary" /> Check-in de ponto por WhatsApp</p>
        <p className="text-[11px] text-muted-foreground">
          Colaborador manda uma foto pra essa linha e o sistema registra a próxima batida esperada do dia automaticamente
          (precisa ter o telefone cadastrado no colaborador). Uma linha só, vale pra todos os colaboradores do tenant.
        </p>
        {isAdmin ? (
          <select value={checkInSessionKey} onChange={(e) => saveCheckInSession(e.target.value)} disabled={savingSettings}
            data-testid="select-ponto-checkin-session"
            className="mt-1 px-3 py-1.5 rounded-xl border border-border text-xs bg-white disabled:opacity-50">
            <option value="">Desligado</option>
            {waSessions.map((s) => (
              <option key={s.sessionKey} value={s.sessionKey}>
                {s.displayName || s.phoneNumber || s.sessionKey}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-xs font-semibold mt-1">
            {checkInSessionKey
              ? (waSessions.find((s) => s.sessionKey === checkInSessionKey)?.displayName ?? checkInSessionKey)
              : "Desligado"}
            <span className="text-[11px] font-normal text-muted-foreground"> · só admin altera</span>
          </p>
        )}
      </div>

      <div className="shk-card p-4 space-y-1.5">
        <p className="text-xs font-semibold flex items-center gap-1.5"><IdCard className="w-3.5 h-3.5 text-primary" /> Reconhecimento facial na batida</p>
        <p className="text-[11px] text-muted-foreground">
          Compara a selfie da entrada com a foto 3x4 cadastrada do colaborador (documentos → foto_3x4). Não bloqueia
          ninguém — só sinaliza a batida pra revisão aqui embaixo quando o rosto parece diferente. Dado biométrico,
          então fica desligado por padrão.
        </p>
        {isAdmin ? (
          <label className="flex items-center gap-2 text-xs font-semibold mt-1 cursor-pointer">
            <input type="checkbox" checked={facialRecognitionEnabled} disabled={savingSettings}
              onChange={(e) => saveFacialRecognition(e.target.checked)} data-testid="checkbox-facial-recognition" />
            {facialRecognitionEnabled ? "Ligado" : "Desligado"}
          </label>
        ) : (
          <p className="text-xs font-semibold mt-1">{facialRecognitionEnabled ? "Ligado" : "Desligado"} <span className="text-[11px] font-normal text-muted-foreground">· só admin altera</span></p>
        )}
      </div>

      <div className="shk-card p-4 flex flex-wrap gap-2 items-end">
        <label className="text-xs">
          Colaborador
          <select value={employeeId} onChange={(e) => setEmployeeId(Number(e.target.value))}
            className="block mt-0.5 px-3 py-1.5 rounded-xl border border-border text-xs bg-white">
            <option value={0}>Todos</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="text-xs">
          De
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-0.5 px-3 py-1.5 rounded-xl border border-border text-xs" />
        </label>
        <label className="text-xs">
          Até
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block mt-0.5 px-3 py-1.5 rounded-xl border border-border text-xs" />
        </label>
        {canEdit && (
          <div className="flex items-center gap-2 ml-auto">
            <button onClick={openDayEditor} data-testid="button-edit-day"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-primary text-primary text-xs font-bold">
              <CalendarClock className="w-3.5 h-3.5" /> Editar dia
            </button>
            <button onClick={() => setManual({ kind: "in", at: "" })} data-testid="button-manual-punch"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold">
              <Plus className="w-3.5 h-3.5" /> Lançar manualmente
            </button>
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhuma batida no período</p>
        </div>
      ) : (
        <div className="shk-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2 px-3 font-semibold">Colaborador</th>
                <th className="text-left py-2 px-3 font-semibold">Tipo</th>
                <th className="text-left py-2 px-3 font-semibold">Quando</th>
                <th className="text-left py-2 px-3 font-semibold">Origem</th>
                {canEdit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={`border-b border-border/50 last:border-0 ${e.flagged ? "bg-amber-50" : ""}`}
                  title={e.flagged ? e.flagReason ?? undefined : undefined}>
                  <td className="py-2 px-3 font-semibold">{e.employeeName ?? "—"}</td>
                  <td className="py-2 px-3">{PONTO_KIND_LABELS[e.kind]}</td>
                  <td className="py-2 px-3">{new Date(e.at).toLocaleString("pt-BR")}</td>
                  <td className="py-2 px-3">
                    <span className="inline-flex items-center gap-1">
                      {PONTO_SOURCE_LABELS[e.source]}
                      {e.proofUrl && (
                        <a href={e.proofUrl} target="_blank" rel="noreferrer" title="Ver foto do comprovante"
                          className="text-primary hover:opacity-70">
                          <ImageIcon className="w-3.5 h-3.5" />
                        </a>
                      )}
                      {e.lat != null && e.lng != null && (
                        <a href={`https://www.google.com/maps?q=${e.lat},${e.lng}`} target="_blank" rel="noreferrer"
                          title={`Ver localização no mapa${e.accuracyMeters != null ? ` (precisão ~${Math.round(e.accuracyMeters)}m)` : ""}`}
                          className="text-primary hover:opacity-70">
                          <MapPin className="w-3.5 h-3.5" />
                        </a>
                      )}
                      {e.flagged && (
                        <span className="inline-flex items-center gap-0.5 text-amber-700 font-semibold" title={e.flagReason ?? undefined}>
                          <AlertTriangle className="w-3.5 h-3.5" /> Revisar
                        </span>
                      )}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="py-2 px-3 text-right">
                      <span className="inline-flex items-center gap-1">
                        {e.flagged && (
                          <button onClick={() => reviewEntry(e.id)} title="Marcar como revisado" data-testid={`button-review-entry-${e.id}`}
                            className="p-1 rounded-lg hover:bg-green-50 text-green-600"><CheckCircle className="w-3.5 h-3.5" /></button>
                        )}
                        <button onClick={() => removeEntry(e.id)} className="p-1 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manual && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Lançar ponto manualmente</h3>
              <button onClick={() => setManual(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <label className="text-xs block">
              Tipo
              <select value={manual.kind} onChange={(e) => setManual({ ...manual, kind: e.target.value as TimeClockEntry["kind"] })}
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                <option value="in">Entrada</option>
                <option value="break_start">Início intervalo</option>
                <option value="break_end">Fim intervalo</option>
                <option value="out">Saída</option>
              </select>
            </label>
            <label className="text-xs block">
              Quando (em branco = agora)
              <input type="datetime-local" value={manual.at} onChange={(e) => setManual({ ...manual, at: e.target.value })}
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
            </label>
            <button onClick={launchManual} data-testid="button-confirm-manual-punch"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold">
              <Save className="w-3.5 h-3.5" /> Lançar
            </button>
          </div>
        </div>
      )}

      {dayEditor && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Editar ponto do dia</h3>
              <button onClick={() => setDayEditor(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-1">
              Deixe um campo em branco para remover a batida daquele tipo, se já houver uma lançada.
            </p>
            <label className="text-xs block">
              Colaborador
              <select value={dayEditor.employeeId} onChange={(e) => setDayEditor({ ...dayEditor, employeeId: Number(e.target.value) })}
                data-testid="select-day-editor-employee"
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
            <label className="text-xs block">
              Data
              <input type="date" value={dayEditor.date} onChange={(e) => setDayEditor({ ...dayEditor, date: e.target.value })}
                data-testid="input-day-editor-date"
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                Entrada
                <input type="time" value={dayEditor.in} onChange={(e) => setDayEditor({ ...dayEditor, in: e.target.value })}
                  data-testid="input-day-editor-in"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Início intervalo
                <input type="time" value={dayEditor.break_start} onChange={(e) => setDayEditor({ ...dayEditor, break_start: e.target.value })}
                  data-testid="input-day-editor-break-start"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Fim intervalo
                <input type="time" value={dayEditor.break_end} onChange={(e) => setDayEditor({ ...dayEditor, break_end: e.target.value })}
                  data-testid="input-day-editor-break-end"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Saída
                <input type="time" value={dayEditor.out} onChange={(e) => setDayEditor({ ...dayEditor, out: e.target.value })}
                  data-testid="input-day-editor-out"
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
            </div>
            <button onClick={saveDayEditor} disabled={dayEditor.saving} data-testid="button-save-day"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              <Save className="w-3.5 h-3.5" /> {dayEditor.saving ? "Salvando..." : "Salvar dia"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Banco de horas ───────────────────────────────────────────────────────
function BancoHoras({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [from, setFrom] = useState(firstOfMonthStr());
  const [to, setTo] = useState(todayStr());
  const [rows, setRows] = useState<TimeBankSummaryRow[]>([]);
  const [detail, setDetail] = useState<{ row: TimeBankSummaryRow; result: TimeBankResult } | null>(null);
  const [adjustment, setAdjustment] = useState<{ minutes: string; reason: string } | null>(null);

  const load = () => api.rhDp.reports.timeBankSummary(`${from}T00:00:00`, `${to}T23:59:59`).then(setRows).catch(() => {});
  useEffect(() => { load(); }, [from, to]);

  const openDetail = async (row: TimeBankSummaryRow) => {
    try {
      const result = await api.rhDp.employees.timeBank(row.employeeId, `${from}T00:00:00`, `${to}T23:59:59`);
      setDetail({ row, result });
    } catch { toast({ title: "Erro ao carregar detalhe", variant: "destructive" }); }
  };

  const saveAdjustment = async () => {
    if (!detail || !adjustment) return;
    const minutes = Number(adjustment.minutes);
    if (!minutes || !adjustment.reason.trim()) { toast({ title: "Informe minutos (≠0) e o motivo", variant: "destructive" }); return; }
    try {
      await api.rhDp.employees.addAdjustment(detail.row.employeeId, { minutes, reason: adjustment.reason.trim() });
      setAdjustment(null);
      load();
      openDetail(detail.row);
      toast({ title: "Ajuste lançado" });
    } catch (err) {
      toast({ title: "Erro ao lançar ajuste", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      <div className="shk-card p-4 flex flex-wrap gap-2 items-end">
        <label className="text-xs">
          De
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block mt-0.5 px-3 py-1.5 rounded-xl border border-border text-xs" />
        </label>
        <label className="text-xs">
          Até
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block mt-0.5 px-3 py-1.5 rounded-xl border border-border text-xs" />
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <Wallet className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhum colaborador ativo</p>
        </div>
      ) : (
        <div className="shk-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2 px-3 font-semibold">Colaborador</th>
                <th className="text-right py-2 px-3 font-semibold">Trabalhado</th>
                <th className="text-right py-2 px-3 font-semibold">Esperado</th>
                <th className="text-right py-2 px-3 font-semibold">Ajustes</th>
                <th className="text-right py-2 px-3 font-semibold">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} onClick={() => openDetail(r)} className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-secondary/30" data-testid={`time-bank-row-${r.employeeId}`}>
                  <td className="py-2 px-3 font-semibold">{r.employeeName}</td>
                  <td className="py-2 px-3 text-right">{formatMinutes(r.workedMinutes)}</td>
                  <td className="py-2 px-3 text-right">{formatMinutes(r.expectedMinutes)}</td>
                  <td className="py-2 px-3 text-right">{formatMinutes(r.adjustmentMinutes)}</td>
                  <td className={`py-2 px-3 text-right font-bold ${r.balanceMinutes < 0 ? "text-red-600" : "text-green-700"}`}>{formatMinutes(r.balanceMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg p-6 my-8 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">{detail.row.employeeName}</h3>
              <button onClick={() => setDetail(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="bg-secondary/40 rounded-xl py-2"><p className="font-bold">{formatMinutes(detail.result.workedMinutes)}</p><p className="text-muted-foreground">Trabalhado</p></div>
              <div className="bg-secondary/40 rounded-xl py-2"><p className="font-bold">{formatMinutes(detail.result.expectedMinutes)}</p><p className="text-muted-foreground">Esperado</p></div>
              <div className="bg-secondary/40 rounded-xl py-2"><p className="font-bold">{formatMinutes(detail.result.adjustmentMinutes)}</p><p className="text-muted-foreground">Ajustes</p></div>
              <div className={`rounded-xl py-2 ${detail.result.balanceMinutes < 0 ? "bg-red-50" : "bg-green-50"}`}>
                <p className={`font-bold ${detail.result.balanceMinutes < 0 ? "text-red-600" : "text-green-700"}`}>{formatMinutes(detail.result.balanceMinutes)}</p>
                <p className="text-muted-foreground">Saldo</p>
              </div>
            </div>
            {canEdit && (
              adjustment ? (
                <div className="space-y-2 border border-border rounded-xl p-3">
                  <input type="number" placeholder="Minutos (+ credita, - debita)" value={adjustment.minutes}
                    onChange={(e) => setAdjustment({ ...adjustment, minutes: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-xl border border-border text-xs" />
                  <input placeholder="Motivo" value={adjustment.reason} onChange={(e) => setAdjustment({ ...adjustment, reason: e.target.value })}
                    className="w-full px-3 py-1.5 rounded-xl border border-border text-xs" />
                  <div className="flex gap-2">
                    <button onClick={() => setAdjustment(null)} className="flex-1 px-3 py-1.5 rounded-xl border border-border text-xs font-semibold">Cancelar</button>
                    <button onClick={saveAdjustment} className="flex-1 px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold">Lançar</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setAdjustment({ minutes: "", reason: "" })} className="text-[11px] font-semibold text-primary">+ Ajuste manual</button>
              )
            )}
            <div className="max-h-[40vh] overflow-y-auto space-y-1">
              {detail.result.days.filter((d) => d.entries.length > 0 || d.expectedMinutes > 0 || d.leaveKind).map((d) => (
                <div key={d.date} className="flex items-center justify-between text-[11px] bg-secondary/30 rounded-lg px-3 py-1.5">
                  <span>{new Date(`${d.date}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}</span>
                  <span className={!d.complete ? "text-amber-600 font-semibold" : d.leaveKind ? "text-blue-600 font-semibold" : ""}>
                    {!d.complete ? "incompleto (falta batida)" : d.leaveKind ? LEAVE_LABELS[d.leaveKind] : `${formatMinutes(d.workedMinutes)} / ${formatMinutes(d.expectedMinutes)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Afastamentos ─────────────────────────────────────────────────────────
function Afastamentos({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [leaves, setLeaves] = useState<LeaveRecord[]>([]);
  const [creating, setCreating] = useState<{ employeeId: number; kind: LeaveRecord["kind"]; startDate: string; endDate: string; notes: string } | null>(null);

  const load = () => api.rhDp.leaves.list().then(setLeaves).catch(() => {});
  useEffect(() => {
    load();
    api.rhDp.employees.list().then(setEmployees).catch(() => {});
  }, []);

  const save = async () => {
    if (!creating) return;
    if (!creating.employeeId || !creating.startDate || !creating.endDate) { toast({ title: "Preencha colaborador e período", variant: "destructive" }); return; }
    try {
      await api.rhDp.leaves.create(creating);
      setCreating(null);
      load();
      toast({ title: "Afastamento lançado" });
    } catch (err) {
      toast({ title: "Erro ao lançar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const remove = async (l: LeaveRecord) => {
    if (!window.confirm("Excluir este afastamento?")) return;
    try { await api.rhDp.leaves.remove(l.id); load(); } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  return (
    <div className="space-y-3">
      {canEdit && (
        <button onClick={() => setCreating({ employeeId: 0, kind: "ferias", startDate: todayStr(), endDate: todayStr(), notes: "" })} data-testid="button-new-leave"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold">
          <Plus className="w-3.5 h-3.5" /> Lançar afastamento
        </button>
      )}
      {leaves.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold">Nenhum afastamento lançado</p>
        </div>
      ) : (
        <div className="space-y-2">
          {leaves.map((l) => (
            <div key={l.id} className="shk-card p-4 flex items-center gap-3" data-testid={`leave-${l.id}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-bold text-sm">{l.employeeName ?? "—"}</p>
                  <span className="text-[10px] font-bold border px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border-amber-100">{LEAVE_LABELS[l.kind]}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(`${l.startDate}T12:00:00`).toLocaleDateString("pt-BR")} – {new Date(`${l.endDate}T12:00:00`).toLocaleDateString("pt-BR")}
                  {l.notes ? ` · ${l.notes}` : ""}
                </p>
              </div>
              {canEdit && <button onClick={() => remove(l)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
            </div>
          ))}
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Lançar afastamento</h3>
              <button onClick={() => setCreating(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <label className="text-xs block">
              Colaborador
              <select value={creating.employeeId} onChange={(e) => setCreating({ ...creating, employeeId: Number(e.target.value) })}
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                <option value={0}>Selecione</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
            <label className="text-xs block">
              Tipo
              <select value={creating.kind} onChange={(e) => setCreating({ ...creating, kind: e.target.value as LeaveRecord["kind"] })}
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm bg-white">
                {Object.entries(LEAVE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                Início
                <input type="date" value={creating.startDate} onChange={(e) => setCreating({ ...creating, startDate: e.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Fim
                <input type="date" value={creating.endDate} onChange={(e) => setCreating({ ...creating, endDate: e.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
            </div>
            <label className="text-xs block">
              Observações
              <textarea value={creating.notes} onChange={(e) => setCreating({ ...creating, notes: e.target.value })} rows={2}
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm resize-none" />
            </label>
            <button onClick={save} data-testid="button-confirm-leave"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold">
              <Save className="w-3.5 h-3.5" /> Lançar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Férias (pedido 10/09, análise Tangerino) ─────────────────────────────
// Dashboard de vencimento (calculado a partir da admissão + afastamentos já
// lançados, sem tabela/cron própria) + fila de pedidos do colaborador
// aguardando aprovação. Aprovar gera automaticamente um Afastamento
// kind="ferias" (mesma tabela lida por relatórios/fechamento).
const VACATION_STATUS_LABELS: Record<VacationRequest["status"], string> = { pendente: "Em análise", aprovado: "Aprovado", rejeitado: "Rejeitado" };
const VACATION_STATUS_CLASSES: Record<VacationRequest["status"], string> = {
  pendente: "bg-amber-50 text-amber-700 border-amber-100",
  aprovado: "bg-green-50 text-green-700 border-green-100",
  rejeitado: "bg-red-50 text-red-600 border-red-100",
};

function Ferias({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [deadlines, setDeadlines] = useState<{ employeeId: number; employeeName: string; deadline: { dueDate: string; daysUntilDue: number; overdue: boolean } }[]>([]);
  const [requests, setRequests] = useState<VacationRequest[]>([]);
  const [reviewing, setReviewing] = useState<{ id: number; action: "aprovar" | "rejeitar"; note: string } | null>(null);

  const load = () => {
    api.rhDp.vacation.deadlines().then(setDeadlines).catch(() => {});
    api.rhDp.vacation.requests.list().then(setRequests).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const pending = requests.filter((r) => r.status === "pendente");
  const decided = requests.filter((r) => r.status !== "pendente");

  const confirmReview = async () => {
    if (!reviewing) return;
    try {
      await api.rhDp.vacation.requests.review(reviewing.id, reviewing.action, reviewing.note);
      toast({ title: reviewing.action === "aprovar" ? "Pedido aprovado" : "Pedido rejeitado" });
      setReviewing(null);
      load();
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-bold text-sm mb-2 flex items-center gap-1.5"><Palmtree className="w-4 h-4 text-primary" /> Vencimento de férias</h3>
        {deadlines.length === 0 ? (
          <div className="shk-card p-6 text-center text-muted-foreground text-xs">Nenhum colaborador com férias pendentes de vencimento.</div>
        ) : (
          <div className="space-y-1.5">
            {deadlines.map((d) => (
              <div key={d.employeeId} className="shk-card p-3 flex items-center justify-between gap-2 text-xs" data-testid={`vacation-deadline-${d.employeeId}`}>
                <span className="font-semibold">{d.employeeName}</span>
                <span className={`font-bold px-2 py-0.5 rounded-full border ${d.deadline.overdue ? "bg-red-50 text-red-600 border-red-100" : d.deadline.daysUntilDue <= 30 ? "bg-amber-50 text-amber-700 border-amber-100" : "bg-green-50 text-green-700 border-green-100"}`}>
                  {d.deadline.overdue ? "Vencido" : `${d.deadline.daysUntilDue}d`} · vence {new Date(`${d.deadline.dueDate}T12:00:00`).toLocaleDateString("pt-BR")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-bold text-sm mb-2">Pedidos aguardando aprovação</h3>
        {pending.length === 0 ? (
          <div className="shk-card p-6 text-center text-muted-foreground text-xs">Nenhum pedido pendente.</div>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r.id} className="shk-card p-4 flex items-center gap-3 flex-wrap" data-testid={`vacation-request-${r.id}`}>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm">{r.employeeName ?? "—"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(`${r.startDate}T12:00:00`).toLocaleDateString("pt-BR")} – {new Date(`${r.endDate}T12:00:00`).toLocaleDateString("pt-BR")} ({r.daysCount} dias)
                  </p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <button onClick={() => setReviewing({ id: r.id, action: "rejeitar", note: "" })} data-testid={`button-reject-vacation-${r.id}`}
                      className="px-3 py-1.5 rounded-xl border border-red-200 text-red-600 text-xs font-bold">Rejeitar</button>
                    <button onClick={() => setReviewing({ id: r.id, action: "aprovar", note: "" })} data-testid={`button-approve-vacation-${r.id}`}
                      className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold">Aprovar</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {decided.length > 0 && (
        <div>
          <h3 className="font-bold text-sm mb-2">Histórico</h3>
          <div className="space-y-1.5">
            {decided.map((r) => (
              <div key={r.id} className="shk-card p-3 flex items-center justify-between gap-2 text-xs" data-testid={`vacation-history-${r.id}`}>
                <span>
                  <span className="font-semibold">{r.employeeName ?? "—"}</span> · {new Date(`${r.startDate}T12:00:00`).toLocaleDateString("pt-BR")} – {new Date(`${r.endDate}T12:00:00`).toLocaleDateString("pt-BR")}
                </span>
                <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${VACATION_STATUS_CLASSES[r.status]}`}>{VACATION_STATUS_LABELS[r.status]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {reviewing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">{reviewing.action === "aprovar" ? "Aprovar pedido de férias" : "Rejeitar pedido de férias"}</h3>
              <button onClick={() => setReviewing(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <label className="text-xs block">
              Observação (opcional)
              <textarea value={reviewing.note} onChange={(e) => setReviewing({ ...reviewing, note: e.target.value })} rows={2}
                className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm resize-none" />
            </label>
            <button onClick={confirmReview} data-testid="button-confirm-vacation-review"
              className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-white text-xs font-bold ${reviewing.action === "aprovar" ? "bg-primary" : "bg-red-600"}`}>
              <Save className="w-3.5 h-3.5" /> Confirmar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Fechamentos ──────────────────────────────────────────────────────────
function previousMonthStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y!, mo! - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

function Fechamentos({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [month, setMonth] = useState(previousMonthStr());
  const [closures, setClosures] = useState<TimeBankClosure[]>([]);
  const [allMonths, setAllMonths] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const load = () => api.rhDp.closures.list(month).then(setClosures).catch(() => {});
  useEffect(() => { load(); }, [month]);
  useEffect(() => {
    api.rhDp.closures.list().then((all) => setAllMonths(Array.from(new Set(all.map((c) => c.periodMonth))).sort().reverse())).catch(() => {});
  }, [closures.length]);

  const runClosure = async () => {
    if (running) return;
    setRunning(true);
    try {
      const r = await api.rhDp.closures.run(month);
      toast({ title: r.created > 0 ? `${r.created} colaborador(es) fechado(s) para ${monthLabel(r.month)}` : "Nada novo para fechar (mês já fechado ou sem colaboradores)" });
      load();
    } catch (err) {
      toast({ title: "Erro ao fechar o mês", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setRunning(false); }
  };

  const removeClosure = async (c: TimeBankClosure) => {
    if (!window.confirm(`Excluir o fechamento de ${c.employeeName} (${monthLabel(c.periodMonth)})? Você pode rodar "Fechar mês" de novo depois.`)) return;
    try { await api.rhDp.closures.remove(c.id); load(); } catch { toast({ title: "Erro", variant: "destructive" }); }
  };

  const totalBalance = closures.reduce((sum, c) => sum + c.balanceMinutes, 0);

  return (
    <div className="space-y-3">
      <div className="shk-card p-4 flex flex-wrap gap-2 items-end">
        <label className="text-xs">
          Mês
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} max={previousMonthStr()}
            data-testid="input-closure-month"
            className="block mt-0.5 px-3 py-1.5 rounded-xl border border-border text-xs" />
        </label>
        {allMonths.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {allMonths.slice(0, 6).map((m) => (
              <button key={m} onClick={() => setMonth(m)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border capitalize ${month === m ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                {monthLabel(m)}
              </button>
            ))}
          </div>
        )}
        {canEdit && (
          <button onClick={runClosure} disabled={running} data-testid="button-run-closure"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold ml-auto disabled:opacity-40">
            <PlayCircle className="w-3.5 h-3.5" /> {running ? "Fechando..." : "Fechar mês"}
          </button>
        )}
      </div>

      {closures.length === 0 ? (
        <div className="shk-card p-8 text-center text-muted-foreground">
          <Archive className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm font-semibold capitalize">Nenhum fechamento em {monthLabel(month)}</p>
          <p className="text-xs mt-1">O sistema fecha automaticamente todo início de mês, ou use "Fechar mês" acima.</p>
        </div>
      ) : (
        <div className="shk-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2 px-3 font-semibold">Colaborador</th>
                <th className="text-right py-2 px-3 font-semibold">Trabalhado</th>
                <th className="text-right py-2 px-3 font-semibold">Esperado</th>
                <th className="text-right py-2 px-3 font-semibold">Ajustes</th>
                <th className="text-right py-2 px-3 font-semibold">Saldo</th>
                <th className="text-center py-2 px-3 font-semibold">Espelho assinado</th>
                {canEdit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {closures.map((c) => (
                <tr key={c.id} className="border-b border-border/50 last:border-0" data-testid={`closure-${c.id}`}>
                  <td className="py-2 px-3 font-semibold">{c.employeeName}</td>
                  <td className="py-2 px-3 text-right">{formatMinutes(c.workedMinutes)}</td>
                  <td className="py-2 px-3 text-right">{formatMinutes(c.expectedMinutes)}</td>
                  <td className="py-2 px-3 text-right">{formatMinutes(c.adjustmentMinutes)}</td>
                  <td className={`py-2 px-3 text-right font-bold ${c.balanceMinutes < 0 ? "text-red-600" : "text-green-700"}`}>{formatMinutes(c.balanceMinutes)}</td>
                  <td className="py-2 px-3 text-center">
                    {c.signedAt ? (
                      <span className="text-[10px] font-bold text-green-700">{new Date(c.signedAt).toLocaleDateString("pt-BR")}</span>
                    ) : (
                      <span className="text-[10px] font-semibold text-amber-600">Pendente</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="py-2 px-3 text-right">
                      <button onClick={() => removeClosure(c)} className="p-1 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-bold">
                <td className="py-2 px-3">Total</td>
                <td></td><td></td><td></td>
                <td className={`py-2 px-3 text-right ${totalBalance < 0 ? "text-red-600" : "text-green-700"}`}>{formatMinutes(totalBalance)}</td>
                <td></td>
                {canEdit && <td></td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Fechamento congelado: uma vez gerado, não muda mais mesmo que ajustes ou batidas antigas do período sejam editados depois. Pra corrigir um erro, exclua o fechamento e rode "Fechar mês" de novo.
      </p>
    </div>
  );
}
