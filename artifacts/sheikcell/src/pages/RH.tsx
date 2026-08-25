import { useState, useEffect } from "react";
import {
  api, API_BASE, canEditModule,
  type RhStage, type RhQuestion, type RhCandidate,
  type Employee, type WorkShift, type TimeClockEntry, type TimeBankResult, type TimeBankSummaryRow, type LeaveRecord, type TimeBankClosure,
  type Store, type User,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Settings2, Copy, RefreshCw, Plus, Trash2, X, CheckCircle, XCircle,
  Video, ChevronDown, ChevronUp, Save, Link2, UserSquare2, CalendarClock, Clock, Wallet, Pencil, Archive, PlayCircle,
  AlertTriangle, Image as ImageIcon, Smartphone,
} from "lucide-react";

const STATUS_META: Record<RhCandidate["status"], { label: string; cls: string }> = {
  novo: { label: "Novo", cls: "bg-blue-50 text-blue-600 border-blue-100" },
  aprovado: { label: "Aprovado", cls: "bg-green-50 text-green-700 border-green-100" },
  reprovado: { label: "Reprovado", cls: "bg-red-50 text-red-600 border-red-100" },
};

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
  const [dpView, setDpView] = useState<"colaboradores" | "escalas" | "ponto" | "banco-horas" | "afastamentos" | "fechamentos">("colaboradores");

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
          {dpView === "fechamentos" && <Fechamentos canEdit={canEdit} />}
        </div>
      )}
    </div>
  );
}

// ── Recrutamento (processo seletivo, já existia) ────────────────────────────
function Recrutamento({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [view, setView] = useState<"candidatos" | "processo">("candidatos");
  const [token, setToken] = useState("");
  const [stages, setStages] = useState<RhStage[]>([]);
  const [candidates, setCandidates] = useState<RhCandidate[]>([]);
  const [opened, setOpened] = useState<RhCandidate | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"todos" | RhCandidate["status"]>("todos");
  const [notesDraft, setNotesDraft] = useState("");

  useEffect(() => {
    api.rh.settings().then((s) => { setToken(s.publicToken); setStages(s.stages); }).catch(() => {});
    api.rh.candidates().then(setCandidates).catch(() => {});
  }, []);

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

  const setStatus = async (c: RhCandidate, status: RhCandidate["status"]) => {
    try {
      await api.rh.updateCandidate(c.id, { status });
      setCandidates((prev) => prev.map((x) => (x.id === c.id ? { ...x, status } : x)));
      setOpened((o) => (o?.id === c.id ? { ...o, status } : o));
    } catch { toast({ title: "Erro", variant: "destructive" }); }
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

  const shown = candidates.filter((c) => filter === "todos" || c.status === filter);

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
          <div className="flex gap-1.5">
            {(["todos", "novo", "aprovado", "reprovado"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border capitalize ${filter === f ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border"}`}>
                {f === "todos" ? "Todos" : STATUS_META[f].label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <div className="shk-card p-8 text-center text-muted-foreground">
              <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-semibold">Nenhum candidato {filter !== "todos" ? `com status "${STATUS_META[filter as RhCandidate["status"]].label}"` : "ainda"}</p>
              <p className="text-xs mt-1">Copie o link acima e divulgue para receber candidaturas.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {shown.map((c) => (
                <button key={c.id} onClick={() => { setOpened(c); setNotesDraft(c.notes ?? ""); }} data-testid={`candidate-${c.id}`}
                  className="shk-card p-4 w-full text-left flex items-center gap-3 hover:bg-secondary/30 transition">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-sm">{c.name}</p>
                      <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${STATUS_META[c.status].cls}`}>{STATUS_META[c.status].label}</span>
                      {c.hasVideo && <Video className="w-3.5 h-3.5 text-primary" />}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{c.phone}{c.email ? ` · ${c.email}` : ""} · {new Date(c.createdAt).toLocaleDateString("pt-BR")}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        /* Editor do processo — some visível pra "view" (mantendo tudo
           navegável e legível), mas nenhum campo/botão aceita interação. */
        <fieldset disabled={!canEdit} className="space-y-3 border-0 p-0 m-0">
          {!canEdit && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
              Você só tem acesso de visualização ao RH — peça ao administrador para liberar edição.
            </p>
          )}
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
                          <input value={(q.options ?? []).join(", ")}
                            onChange={(e) => setQuestion(si, qi, { options: e.target.value.split(",").map((o) => o.trimStart()) })}
                            onBlur={(e) => setQuestion(si, qi, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
                            placeholder="Opções separadas por vírgula"
                            className="w-full px-3 py-1.5 rounded-xl border border-border text-[11px]" />
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
            <button onClick={saveStages} disabled={saving} data-testid="button-save-rh"
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              <Save className="w-3.5 h-3.5" /> {saving ? "Salvando..." : "Salvar processo"}
            </button>
          </div>
        </fieldset>
      )}

      {/* Modal do candidato */}
      {opened && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="shk-card w-full max-w-lg p-6 my-8 bg-white">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold">{opened.name}</h3>
              <button onClick={() => setOpened(null)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{opened.phone}{opened.email ? ` · ${opened.email}` : ""} · {new Date(opened.createdAt).toLocaleString("pt-BR")}</p>

            <div className="flex gap-1.5 mb-4">
              <button onClick={() => setStatus(opened, "aprovado")} data-testid="button-approve-candidate" disabled={!canEdit}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border disabled:opacity-40 ${opened.status === "aprovado" ? "bg-green-600 text-white border-green-600" : "bg-white text-green-700 border-green-200"}`}>
                <CheckCircle className="w-3.5 h-3.5" /> Aprovar
              </button>
              <button onClick={() => setStatus(opened, "reprovado")} disabled={!canEdit}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border disabled:opacity-40 ${opened.status === "reprovado" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-200"}`}>
                <XCircle className="w-3.5 h-3.5" /> Reprovar
              </button>
              <button onClick={() => removeCandidate(opened)} disabled={!canEdit}
                className="ml-auto p-1.5 rounded-lg hover:bg-red-50 text-red-400 disabled:opacity-40"><Trash2 className="w-4 h-4" /></button>
            </div>

            <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
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

// ── Colaboradores ────────────────────────────────────────────────────────
function Colaboradores({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<Partial<Employee> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.rhDp.employees.list().then(setEmployees).catch(() => {});
  useEffect(() => {
    load();
    api.rhDp.shifts.list().then(setShifts).catch(() => {});
    api.stores.list(true).then(setStores).catch(() => {});
    api.admin.users.list().then(setUsers).catch(() => {});
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
  const [savingSettings, setSavingSettings] = useState(false);
  useEffect(() => {
    api.chat.waSessions().then(setWaSessions).catch(() => {});
    api.rhDp.settings.get().then((s) => setCheckInSessionKey(s.pontoCheckInSessionKey ?? "")).catch(() => {});
  }, []);
  const saveCheckInSession = async (value: string) => {
    setSavingSettings(true);
    try {
      await api.rhDp.settings.update(value || null);
      setCheckInSessionKey(value);
      toast({ title: value ? "Linha de check-in configurada" : "Check-in por WhatsApp desligado" });
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
              {detail.result.days.filter((d) => d.entries.length > 0 || d.expectedMinutes > 0).map((d) => (
                <div key={d.date} className="flex items-center justify-between text-[11px] bg-secondary/30 rounded-lg px-3 py-1.5">
                  <span>{new Date(`${d.date}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}</span>
                  <span className={!d.complete ? "text-amber-600 font-semibold" : ""}>{!d.complete ? "incompleto" : `${formatMinutes(d.workedMinutes)} / ${formatMinutes(d.expectedMinutes)}`}</span>
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
