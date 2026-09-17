import { useState, useEffect, useRef, useCallback } from "react";
import { api, canEditModule, type BotSettings, type KbSuggestion } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Bot, X, Send, RotateCcw, MessageSquareText, Sparkles, Check, GraduationCap, Repeat } from "lucide-react";

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm mt-1";

// Aba "Robô" (admin): configuração do pré-atendimento com IA + modo teste.
export default function Robo() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = canEditModule(user, "robo");
  const [s, setS] = useState<BotSettings | null>(null);
  const [saving, setSaving] = useState(false);

  // caixa de IA da base de conhecimento (pedido 16/09) — com prévia antes de
  // salvar (pedido 17/09): mergePreview !== null enquanto o admin revisa.
  const [kbInput, setKbInput] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergePreview, setMergePreview] = useState<string | null>(null);
  const [approvingPreview, setApprovingPreview] = useState(false);

  // sugestões de conhecimento (aprendizado com atendimentos) — mesma lógica
  // de prévia: previewingSuggestionId enquanto gera, suggestionPreview com o
  // resultado (editável) antes de aprovar de verdade.
  const [suggestions, setSuggestions] = useState<KbSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [previewingSuggestionId, setPreviewingSuggestionId] = useState<number | null>(null);
  const [suggestionPreview, setSuggestionPreview] = useState<{ id: number; text: string } | null>(null);

  // modo teste
  const [chat, setChat] = useState<{ from: "you" | "bot"; text: string }[]>([]);
  const [testMsg, setTestMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.bot.settings().then(setS).catch(() => {
      toast({ title: "Erro ao carregar o robô", variant: "destructive" });
    });
  }, [toast]);

  const refreshSuggestions = useCallback(() => {
    setLoadingSuggestions(true);
    api.bot.suggestions("pending")
      .then(setSuggestions)
      .catch(() => toast({ title: "Erro ao carregar sugestões de conhecimento", variant: "destructive" }))
      .finally(() => setLoadingSuggestions(false));
  }, [toast]);

  useEffect(() => { refreshSuggestions(); }, [refreshSuggestions]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  if (!s) return <p className="text-sm text-muted-foreground">Carregando...</p>;

  const set = (patch: Partial<BotSettings>) => setS({ ...s, ...patch });

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const upd = await api.bot.save(s);
      setS(upd);
      toast({ title: upd.enabled ? "Robô salvo e LIGADO 🤖" : "Robô salvo (desligado)" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    const text = testMsg.trim();
    if (!text || testing) return;
    setTestMsg("");
    setChat((c) => [...c, { from: "you", text }]);
    setTesting(true);
    try {
      const r = await api.bot.test(text);
      setChat((c) => [...c, ...r.replies.map((t) => ({ from: "bot" as const, text: t }))]);
    } catch (err) {
      toast({ title: "Erro no teste", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const resetTest = async () => {
    try { await api.bot.test("", true); } catch { /* ok */ }
    setChat([]);
  };

  // Caixa de IA: manda o texto solto, a IA reorganiza e devolve uma PRÉVIA —
  // nunca salva sozinho (pedido 17/09: "mostras como vai fica o novo
  // conhecimento para aprovar ou não ou corrigir"). O admin revisa (e pode
  // editar) o texto da prévia antes de aprovar.
  const handleKbGeneratePreview = async () => {
    const text = kbInput.trim();
    if (!text || merging) return;
    setMerging(true);
    try {
      const { knowledgeBase } = await api.bot.knowledgeMerge(text);
      setMergePreview(knowledgeBase);
    } catch (err) {
      toast({ title: "Erro ao gerar prévia", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setMerging(false);
    }
  };

  const handleApproveKbPreview = async () => {
    if (mergePreview == null || approvingPreview) return;
    setApprovingPreview(true);
    try {
      const upd = await api.bot.save({ ...s, knowledgeBase: mergePreview });
      setS(upd);
      setMergePreview(null);
      setKbInput("");
      toast({ title: "Base de conhecimento atualizada 🤖" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setApprovingPreview(false);
    }
  };

  const handleCancelKbPreview = () => setMergePreview(null);

  // Sugestão: "Ver prévia" gera o texto mesclado sem salvar; só ao aprovar
  // (com o texto já revisado) é que a base muda de verdade.
  const handlePreviewSuggestion = async (id: number) => {
    if (previewingSuggestionId) return;
    setPreviewingSuggestionId(id);
    try {
      const { knowledgeBase } = await api.bot.previewSuggestion(id);
      setSuggestionPreview({ id, text: knowledgeBase });
    } catch (err) {
      toast({ title: "Erro ao gerar prévia", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setPreviewingSuggestionId(null);
    }
  };

  const handleApproveSuggestion = async (id: number, reviewedText?: string) => {
    if (reviewingId) return;
    setReviewingId(id);
    try {
      const { knowledgeBase } = await api.bot.approveSuggestion(id, reviewedText);
      setS((prev) => (prev ? { ...prev, knowledgeBase } : prev));
      setSuggestions((prev) => prev.filter((sug) => sug.id !== id));
      setSuggestionPreview((prev) => (prev?.id === id ? null : prev));
      toast({ title: "Sugestão aprovada e adicionada à base 🤖" });
    } catch (err) {
      toast({ title: "Erro ao aprovar sugestão", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setReviewingId(null);
    }
  };

  const handleRejectSuggestion = async (id: number) => {
    if (reviewingId) return;
    setReviewingId(id);
    try {
      await api.bot.rejectSuggestion(id);
      setSuggestions((prev) => prev.filter((sug) => sug.id !== id));
      setSuggestionPreview((prev) => (prev?.id === id ? null : prev));
    } catch (err) {
      toast({ title: "Erro ao rejeitar sugestão", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setReviewingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" /> Robô de Pré-Atendimento
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">IA usada hoje: <b>{s.usageToday}</b> / {s.maxPerDay}</span>
          {canEdit && (
            <button onClick={handleSave} disabled={saving} data-testid="button-save-bot"
              className="px-4 py-2 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-40 transition">
              {saving ? "Salvando..." : "Salvar"}
            </button>
          )}
        </div>
      </div>
      {!canEdit && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Você só tem acesso de visualização ao Robô — peça ao administrador para liberar edição.
        </p>
      )}

      <fieldset disabled={!canEdit} className="grid lg:grid-cols-2 gap-4 items-start border-0 p-0 m-0">
        {/* ─── Configuração ─── */}
        <div className="space-y-4">
          <div className="shk-card p-4 space-y-3 text-xs">
            <label className="flex items-center gap-2 font-bold text-sm">
              <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="toggle-bot-enabled" />
              Robô ligado
            </label>
            <label className="flex items-center gap-2 font-semibold text-[11px]">
              <input type="checkbox" checked={s.learningEnabled} onChange={(e) => set({ learningEnabled: e.target.checked })} data-testid="toggle-bot-learning" />
              <GraduationCap className="w-3.5 h-3.5 text-primary" /> Aprender com atendimentos
            </label>
            <p className="text-[10px] text-muted-foreground -mt-2">
              Quando ligado, a IA analisa cada atendimento finalizado por um vendedor e, se achar algo que falta na base, gera uma sugestão pra você aprovar (veja abaixo). Desligue manualmente quando achar a base madura o suficiente.
            </p>
            <label className="flex items-center gap-2 font-semibold text-[11px]">
              <input type="checkbox" checked={s.tradeInEnabled} onChange={(e) => set({ tradeInEnabled: e.target.checked })} data-testid="toggle-bot-trade-in" />
              <Repeat className="w-3.5 h-3.5 text-primary" /> Avaliação de usados por conversa
            </label>
            <p className="text-[10px] text-muted-foreground -mt-2">
              Quando ligado, o robô pode conduzir a avaliação de um aparelho usado direto na conversa (marca, modelo, questionário de estado) e dar uma estimativa — igual à avaliação pública do site, só que pelo WhatsApp. Nunca pede CPF/IMEI/foto pelo chat nem fecha negócio sozinho: vira um lead em Avaliação de Usados pra um vendedor confirmar.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-semibold">Nome do robô</label>
                <input value={s.botName} onChange={(e) => set({ botName: e.target.value })} className={INPUT} />
              </div>
              <div>
                <label className="font-semibold">Quando o robô age</label>
                <select value={s.mode} onChange={(e) => set({ mode: e.target.value as BotSettings["mode"] })} className={INPUT}>
                  <option value="always">Sempre (até um vendedor assumir)</option>
                  <option value="off_hours">Só fora do expediente</option>
                </select>
              </div>
            </div>
            {s.mode === "off_hours" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold">Expediente começa</label>
                  <input value={s.hoursStart} onChange={(e) => set({ hoursStart: e.target.value })} placeholder="08:00" className={INPUT} />
                </div>
                <div>
                  <label className="font-semibold">Expediente termina</label>
                  <input value={s.hoursEnd} onChange={(e) => set({ hoursEnd: e.target.value })} placeholder="18:00" className={INPUT} />
                </div>
              </div>
            )}
          </div>

          <div className="shk-card p-4 space-y-3 text-xs">
            <div className="border border-primary/30 bg-primary/5 rounded-xl p-3 space-y-2">
              <label className="font-bold text-sm flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-primary" /> Adicionar com IA
              </label>
              <p className="text-[10px] text-muted-foreground">
                Cole aqui uma informação nova ou uma correção (solta, sem se preocupar com formatação) — a IA organiza e junta com a base abaixo. Antes de salvar, você confere (e pode corrigir) exatamente como vai ficar.
              </p>
              {mergePreview == null ? (
                <>
                  <textarea value={kbInput} onChange={(e) => setKbInput(e.target.value)} rows={3}
                    placeholder="Ex.: a partir de agora também parcelamos conserto em até 3x sem juros no cartão"
                    data-testid="input-kb-ai-box" className={INPUT} />
                  <button onClick={handleKbGeneratePreview} disabled={merging || !kbInput.trim()} data-testid="button-kb-ai-send"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-semibold disabled:opacity-40 transition">
                    <Sparkles className="w-3.5 h-3.5" /> {merging ? "A IA está organizando..." : "Gerar prévia com IA"}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-[10px] font-semibold text-foreground">Prévia de como a base vai ficar — pode corrigir antes de aprovar:</p>
                  <textarea value={mergePreview} onChange={(e) => setMergePreview(e.target.value)} rows={8}
                    data-testid="textarea-kb-preview" className={INPUT} />
                  <div className="flex gap-2">
                    <button onClick={handleApproveKbPreview} disabled={approvingPreview} data-testid="button-kb-preview-approve"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-semibold disabled:opacity-40 transition">
                      <Check className="w-3.5 h-3.5" /> {approvingPreview ? "Salvando..." : "Aprovar e salvar na base"}
                    </button>
                    <button onClick={handleCancelKbPreview} disabled={approvingPreview} data-testid="button-kb-preview-cancel"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-[11px] font-semibold disabled:opacity-40 transition">
                      <X className="w-3.5 h-3.5" /> Cancelar
                    </button>
                  </div>
                </>
              )}
            </div>
            <div>
              <label className="font-bold text-sm">Base de conhecimento</label>
              <p className="text-[10px] text-muted-foreground">Cole aqui horários, endereço, formas de pagamento, garantia... A IA responde SÓ com base nisso.</p>
              <textarea value={s.knowledgeBase} onChange={(e) => set({ knowledgeBase: e.target.value })} rows={6}
                placeholder={"Ex.:\nHorário: seg a sáb, 9h às 18h\nEndereço: Rua X, 123 — Centro\nAceitamos cartão, Pix e dinheiro\nGarantia de 90 dias nos consertos"} className={INPUT} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-semibold">Máx. respostas de IA por conversa</label>
                <input type="number" min={0} max={50} value={s.maxPerConversation}
                  onChange={(e) => set({ maxPerConversation: parseInt(e.target.value || "0", 10) })} className={INPUT} />
              </div>
              <div>
                <label className="font-semibold">Máx. usos de IA por dia</label>
                <input type="number" min={0} max={5000} value={s.maxPerDay}
                  onChange={(e) => set({ maxPerDay: parseInt(e.target.value || "0", 10) })} className={INPUT} />
              </div>
            </div>
            <div>
              <label className="font-semibold">Tempo de resposta digitando (segundos)</label>
              <input type="number" min={0} max={30} value={s.typingDelaySeconds}
                onChange={(e) => set({ typingDelaySeconds: parseInt(e.target.value || "0", 10) })} className={INPUT} />
              <p className="text-[11px] text-muted-foreground mt-1">
                Espera esse tanto de segundos "digitando..." antes de mandar cada resposta gerada por IA, pra não
                parecer uma resposta robótica instantânea. 0 = manda assim que a IA responder.
              </p>
            </div>
          </div>

          {/* ─── Sugestões de Conhecimento (aprendizado com atendimentos) ─── */}
          <div className="shk-card p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <p className="font-bold text-sm flex items-center gap-1.5">
                <GraduationCap className="w-4 h-4 text-primary" /> Sugestões de Conhecimento
              </p>
              {suggestions.length > 0 && (
                <span className="text-[10px] font-semibold bg-primary/10 text-primary rounded-full px-2 py-0.5">{suggestions.length} pendente{suggestions.length > 1 ? "s" : ""}</span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Depois de cada atendimento finalizado por um vendedor, a IA analisa a conversa e sugere aqui o que faltou na base. Aprove só o que fizer sentido.
            </p>
            {loadingSuggestions && <p className="text-[11px] text-muted-foreground">Carregando...</p>}
            {!loadingSuggestions && suggestions.length === 0 && (
              <p className="text-[11px] text-muted-foreground italic">Nenhuma sugestão pendente no momento.</p>
            )}
            {suggestions.map((sug) => (
              <div key={sug.id} data-testid={`suggestion-${sug.id}`} className="border border-border rounded-xl p-3 space-y-1.5">
                <p className="text-[12px]">{sug.suggestion}</p>
                {sug.reasoning && <p className="text-[10px] text-muted-foreground italic">Motivo: {sug.reasoning}</p>}
                {canEdit && suggestionPreview?.id !== sug.id && (
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => handlePreviewSuggestion(sug.id)} disabled={previewingSuggestionId === sug.id}
                      data-testid={`button-preview-suggestion-${sug.id}`}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-semibold disabled:opacity-40">
                      <Sparkles className="w-3 h-3" /> {previewingSuggestionId === sug.id ? "Gerando prévia..." : "Ver prévia e aprovar"}
                    </button>
                    <button onClick={() => handleRejectSuggestion(sug.id)} disabled={reviewingId === sug.id}
                      data-testid={`button-reject-suggestion-${sug.id}`}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold disabled:opacity-40">
                      <X className="w-3 h-3" /> Rejeitar
                    </button>
                  </div>
                )}
                {canEdit && suggestionPreview?.id === sug.id && (
                  <div className="space-y-2 pt-1">
                    <p className="text-[10px] font-semibold text-foreground">Prévia de como a base vai ficar — pode corrigir antes de aprovar:</p>
                    <textarea value={suggestionPreview.text} onChange={(e) => setSuggestionPreview({ id: sug.id, text: e.target.value })}
                      rows={8} data-testid={`textarea-suggestion-preview-${sug.id}`} className={INPUT} />
                    <div className="flex gap-2">
                      <button onClick={() => handleApproveSuggestion(sug.id, suggestionPreview.text)} disabled={reviewingId === sug.id}
                        data-testid={`button-approve-suggestion-${sug.id}`}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-semibold disabled:opacity-40">
                        <Check className="w-3 h-3" /> {reviewingId === sug.id ? "Salvando..." : "Aprovar e salvar"}
                      </button>
                      <button onClick={() => setSuggestionPreview(null)} disabled={reviewingId === sug.id}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold disabled:opacity-40">
                        <X className="w-3 h-3" /> Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ─── Modo teste ─── */}
        <div className="shk-card p-4 flex flex-col lg:sticky lg:top-4" style={{ minHeight: 420 }}>
          <div className="flex items-center justify-between mb-2">
            <p className="font-bold text-sm flex items-center gap-1.5">
              <MessageSquareText className="w-4 h-4 text-primary" /> Testar o robô
            </p>
            <button onClick={resetTest} className="flex items-center gap-1 text-[11px] text-muted-foreground font-semibold hover:text-foreground">
              <RotateCcw className="w-3 h-3" /> Recomeçar
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground mb-2">Converse como se fosse um cliente. Nada é enviado pelo WhatsApp — é só simulação. Salve antes de testar mudanças.</p>
          <div className="flex-1 overflow-y-auto space-y-2 bg-secondary/30 rounded-xl p-3" style={{ maxHeight: 420 }}>
            {chat.length === 0 && <p className="text-[11px] text-muted-foreground text-center mt-8">Mande um "oi" para começar 👇</p>}
            {chat.map((m, i) => (
              <div key={i} className={`max-w-[85%] px-3 py-2 rounded-2xl text-xs whitespace-pre-wrap ${m.from === "you" ? "ml-auto bg-primary text-white" : "bg-white border border-border"}`}>
                {m.text}
              </div>
            ))}
            {testing && <div className="bg-white border border-border max-w-[85%] px-3 py-2 rounded-2xl text-xs text-muted-foreground">digitando...</div>}
            <div ref={chatEnd} />
          </div>
          <div className="flex gap-2 mt-2">
            <input value={testMsg} onChange={(e) => setTestMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendTest(); }}
              placeholder="Escreva como cliente..." data-testid="input-bot-test"
              className="flex-1 px-3 py-2 rounded-xl border border-border text-sm" />
            <button onClick={sendTest} disabled={testing || !testMsg.trim()} data-testid="button-bot-test-send"
              className="px-3 py-2 rounded-xl bg-primary text-white disabled:opacity-40"><Send className="w-4 h-4" /></button>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
