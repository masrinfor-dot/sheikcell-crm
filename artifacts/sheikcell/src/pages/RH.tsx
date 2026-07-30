import { useState, useEffect } from "react";
import { api, API_BASE, type RhStage, type RhQuestion, type RhCandidate } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Settings2, Copy, RefreshCw, Plus, Trash2, X, CheckCircle, XCircle,
  Video, ChevronDown, ChevronUp, Save, Link2,
} from "lucide-react";

const STATUS_META: Record<RhCandidate["status"], { label: string; cls: string }> = {
  novo: { label: "Novo", cls: "bg-blue-50 text-blue-600 border-blue-100" },
  aprovado: { label: "Aprovado", cls: "bg-green-50 text-green-700 border-green-100" },
  reprovado: { label: "Reprovado", cls: "bg-red-50 text-red-600 border-red-100" },
};

// Aba "RH" (admin): personaliza as etapas do processo seletivo e
// analisa os candidatos que responderam pelo link público.
export default function RH() {
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
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2"><Users className="w-5 h-5 text-primary" /> RH — Processo Seletivo</h2>
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
        <button onClick={regenerate} title="Gerar novo link (o antigo para de funcionar)"
          className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><RefreshCw className="w-3.5 h-3.5" /></button>
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
        /* Editor do processo */
        <div className="space-y-3">
          {stages.map((s, si) => (
            <div key={si} className={`shk-card p-4 space-y-3 ${!s.enabled ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2">
                <div className="flex flex-col">
                  <button onClick={() => move(si, -1)} disabled={si === 0} className="disabled:opacity-20"><ChevronUp className="w-4 h-4 text-muted-foreground" /></button>
                  <button onClick={() => move(si, 1)} disabled={si === stages.length - 1} className="disabled:opacity-20"><ChevronDown className="w-4 h-4 text-muted-foreground" /></button>
                </div>
                <input value={s.title} onChange={(e) => setStage(si, { title: e.target.value })}
                  className="flex-1 px-3 py-2 rounded-xl border border-border text-sm font-bold" />
                <select value={s.type} onChange={(e) => setStage(si, { type: e.target.value as RhStage["type"], questions: e.target.value === "video" ? [] : (s.questions.length ? s.questions : [{ id: "q1", label: "", type: "text" }]) })}
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
        </div>
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
              <button onClick={() => setStatus(opened, "aprovado")} data-testid="button-approve-candidate"
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border ${opened.status === "aprovado" ? "bg-green-600 text-white border-green-600" : "bg-white text-green-700 border-green-200"}`}>
                <CheckCircle className="w-3.5 h-3.5" /> Aprovar
              </button>
              <button onClick={() => setStatus(opened, "reprovado")}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border ${opened.status === "reprovado" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-200"}`}>
                <XCircle className="w-3.5 h-3.5" /> Reprovar
              </button>
              <button onClick={() => removeCandidate(opened)}
                className="ml-auto p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-4 h-4" /></button>
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
                <textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={3}
                  placeholder="Suas observações sobre este candidato (só o admin vê)..."
                  className="w-full px-3 py-2 rounded-xl border border-border text-xs resize-none" />
                <button onClick={saveNotes} className="mt-1 px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-bold">Salvar anotação</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
