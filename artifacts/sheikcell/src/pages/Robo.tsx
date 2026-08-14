import { useState, useEffect, useRef } from "react";
import { api, canEditModule, type BotSettings, type BotQuestion } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Bot, Plus, X, Trash2, Send, RotateCcw, MessageSquareText } from "lucide-react";

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm mt-1";

// Aba "Robô" (admin): configuração do pré-atendimento com IA + modo teste.
export default function Robo() {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = canEditModule(user, "robo");
  const [s, setS] = useState<BotSettings | null>(null);
  const [saving, setSaving] = useState(false);

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

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  if (!s) return <p className="text-sm text-muted-foreground">Carregando...</p>;

  const set = (patch: Partial<BotSettings>) => setS({ ...s, ...patch });

  const setQuestion = (i: number, patch: Partial<BotQuestion>) => {
    const qs = s.questions.map((q, j) => (j === i ? { ...q, ...patch } : q));
    set({ questions: qs });
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const cleaned = s.questions
        .map((q) => ({ ...q, question: q.question.trim(), options: q.options?.map((o) => o.trim()).filter(Boolean) }))
        .filter((q) => q.question);
      const upd = await api.bot.save({ ...s, questions: cleaned });
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
            <div>
              <label className="font-semibold">Saudação (primeira mensagem)</label>
              <textarea value={s.greeting} onChange={(e) => set({ greeting: e.target.value })} rows={2} className={INPUT} />
            </div>
          </div>

          <div className="shk-card p-4 space-y-3 text-xs">
            <p className="font-bold text-sm">Perguntas de filtragem</p>
            {s.questions.map((q, i) => (
              <div key={i} className="border border-border rounded-xl p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-[10px] font-bold text-muted-foreground mt-2.5">{i + 1}.</span>
                  <input value={q.question} onChange={(e) => setQuestion(i, { question: e.target.value })}
                    placeholder="Pergunta" className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                  <button onClick={() => set({ questions: s.questions.filter((_, j) => j !== i) })} className="p-2">
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </button>
                </div>
                <input value={(q.options ?? []).join(", ")}
                  onChange={(e) => setQuestion(i, { options: e.target.value ? e.target.value.split(",").map((x) => x.trimStart()) : undefined })}
                  placeholder="Opções separadas por vírgula (opcional) — vira menu 1, 2, 3..."
                  className="w-full px-3 py-2 rounded-xl border border-border text-[11px]" />
              </div>
            ))}
            {s.questions.length < 10 && (
              <button onClick={() => set({ questions: [...s.questions, { question: "" }] })}
                className="flex items-center gap-1 text-primary font-semibold text-[11px]">
                <Plus className="w-3.5 h-3.5" /> Adicionar pergunta
              </button>
            )}
          </div>

          <div className="shk-card p-4 space-y-3 text-xs">
            <div>
              <label className="font-bold text-sm">Base de conhecimento</label>
              <p className="text-[10px] text-muted-foreground">Cole aqui horários, endereço, formas de pagamento, garantia... A IA responde SÓ com base nisso.</p>
              <textarea value={s.knowledgeBase} onChange={(e) => set({ knowledgeBase: e.target.value })} rows={6}
                placeholder={"Ex.:\nHorário: seg a sáb, 9h às 18h\nEndereço: Rua X, 123 — Centro\nAceitamos cartão, Pix e dinheiro\nGarantia de 90 dias nos consertos"} className={INPUT} />
            </div>
            <div>
              <label className="font-semibold">Mensagem ao terminar as perguntas</label>
              <textarea value={s.doneMessage} onChange={(e) => set({ doneMessage: e.target.value })} rows={2} className={INPUT} />
            </div>
            <div>
              <label className="font-semibold">Mensagem quando o cliente pede um atendente</label>
              <textarea value={s.handoffMessage} onChange={(e) => set({ handoffMessage: e.target.value })} rows={2} className={INPUT} />
            </div>
            <div>
              <label className="font-semibold">Palavras de urgência (pulam o robô)</label>
              <input value={s.urgencyWords} onChange={(e) => set({ urgencyWords: e.target.value })} className={INPUT} />
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
