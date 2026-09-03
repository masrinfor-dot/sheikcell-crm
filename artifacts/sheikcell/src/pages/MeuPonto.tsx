import { useState, useEffect, useCallback } from "react";
import { api, type Employee, type TimeBankResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { usePunchCapture } from "@/hooks/use-punch-capture";
import { Clock, Wallet, CheckCircle2, Loader2, Camera, MapPin } from "lucide-react";

const KIND_LABELS: Record<string, string> = { in: "Entrada", break_start: "Início do intervalo", break_end: "Fim do intervalo", out: "Saída" };

function formatMinutes(mins: number): string {
  const sign = mins < 0 ? "-" : "";
  const abs = Math.abs(Math.round(mins));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}h${m.toString().padStart(2, "0")}`;
}

// Data civil no fuso America/Sao_Paulo (não UTC) — perto da meia-noite,
// toISOString() já pode estar num dia diferente do dia local no Brasil,
// desalinhando a janela "hoje"/"este mês" pedida ao backend.
function todayStr(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }
function firstOfMonthStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}-01`;
}

// Auto-serviço de ponto: qualquer colaborador vinculado a um cadastro de RH
// pode bater o próprio ponto e ver o próprio banco de horas, sem depender do
// módulo "rh" (mesmo tratamento do Atendimento — sempre visível, sem gate).
export default function MeuPonto() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [notLinked, setNotLinked] = useState(false);
  const [today, setToday] = useState<TimeBankResult | null>(null);
  const [month, setMonth] = useState<TimeBankResult | null>(null);
  const [punching, setPunching] = useState(false);

  const load = useCallback(async () => {
    try {
      const e = await api.rhDp.me.get();
      setEmployee(e);
      setNotLinked(false);
      const [t, m] = await Promise.all([
        api.rhDp.me.timeBank(`${todayStr()}T00:00:00`, `${todayStr()}T23:59:59`),
        api.rhDp.me.timeBank(`${firstOfMonthStr()}T00:00:00`, `${todayStr()}T23:59:59`),
      ]);
      setToday(t);
      setMonth(m);
    } catch {
      setNotLinked(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const todayEntries = today?.days[0]?.entries ?? [];
  const doneForToday = todayEntries.length > 0 && todayEntries[todayEntries.length - 1]!.kind === "out";
  // Sem nenhuma batida hoje ainda, a próxima é sempre "entrada" — exige foto
  // + geo do mesmo jeito que o PontoGate.tsx (o backend rejeita sem isso).
  // Só se aplica a quem bate a entrada por aqui em vez de pelo gate: admin
  // (isento do gate) ou colaborador de escala flexível (gate nunca aparece).
  const nextIsIn = todayEntries.length === 0;
  const needsCapture = nextIsIn && !doneForToday && !loading && !notLinked && !!employee;
  const { cam, geo, videoRef, ready, startCamera, startGeo, capture, stop } = usePunchCapture(needsCapture);

  const punch = async () => {
    if (punching) return;
    if (needsCapture && !ready) return;
    setPunching(true);
    try {
      const payload = needsCapture ? capture() : null;
      if (needsCapture && !payload) { setPunching(false); return; }
      const created = await api.rhDp.me.punch(payload ?? undefined);
      if (needsCapture) stop();
      toast({ title: `Ponto registrado: ${KIND_LABELS[created.kind] ?? created.kind}`, description: new Date(created.at).toLocaleTimeString("pt-BR") });
      await load();
    } catch (err) {
      toast({ title: "Erro ao bater ponto", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setPunching(false); }
  };

  if (loading) {
    return <div className="max-w-md mx-auto px-4 py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  if (notLinked || !employee) {
    return (
      <div className="max-w-md mx-auto px-4 py-10 text-center text-muted-foreground">
        <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm font-semibold">Você ainda não está vinculado a um cadastro de colaborador</p>
        <p className="text-xs mt-1">Fale com o administrador para vincular seu usuário no RH e liberar o ponto.</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-6 space-y-4">
      <h2 className="text-lg font-bold flex items-center gap-2"><Clock className="w-5 h-5 text-primary" /> Meu Ponto</h2>

      <div className="shk-card p-5 text-center space-y-3">
        <p className="text-xs text-muted-foreground">{new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}</p>

        {needsCapture && (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">A entrada precisa de foto e localização</p>
            <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video ref={videoRef} playsInline className={`w-full h-full object-cover ${cam.status === "ok" ? "" : "hidden"}`} />
              {cam.status === "loading" && <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />}
              {cam.status === "error" && (
                <div className="p-3 flex flex-col items-center gap-2 text-destructive">
                  <Camera className="w-6 h-6" />
                  <p className="text-xs">{cam.error}</p>
                  <button onClick={startCamera} className="text-xs font-semibold text-primary underline" data-testid="button-meuponto-retry-camera">
                    Tentar de novo
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center justify-center gap-2 text-xs">
              <MapPin className={`w-4 h-4 ${geo.status === "ok" ? "text-emerald-600" : geo.status === "error" ? "text-destructive" : "text-muted-foreground"}`} />
              {geo.status === "loading" && <span className="text-muted-foreground">Obtendo localização...</span>}
              {geo.status === "ok" && <span className="text-emerald-600 font-medium">Localização confirmada</span>}
              {geo.status === "error" && (
                <span className="text-destructive">
                  {geo.error} <button onClick={startGeo} className="font-semibold underline" data-testid="button-meuponto-retry-geo">Tentar de novo</button>
                </span>
              )}
            </div>
          </div>
        )}

        <button onClick={punch} disabled={punching || doneForToday || (needsCapture && !ready)} data-testid="button-punch-clock"
          className="w-full py-4 rounded-2xl bg-primary text-white font-bold text-base disabled:opacity-40 flex items-center justify-center gap-2">
          {punching ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
          {doneForToday ? "Ponto do dia completo" : "Bater ponto"}
        </button>
        {todayEntries.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5 pt-1">
            {todayEntries.map((e, i) => (
              <span key={i} className="text-[11px] font-semibold bg-secondary/50 rounded-full px-2.5 py-1">
                {KIND_LABELS[e.kind] ?? e.kind} {new Date(e.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            ))}
          </div>
        )}
      </div>

      {month && (
        <div className="shk-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-primary" />
            <h3 className="font-bold text-sm">Banco de horas — este mês</h3>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            <div className="bg-secondary/40 rounded-xl py-2"><p className="font-bold">{formatMinutes(month.workedMinutes)}</p><p className="text-muted-foreground">Trabalhado</p></div>
            <div className="bg-secondary/40 rounded-xl py-2"><p className="font-bold">{formatMinutes(month.expectedMinutes)}</p><p className="text-muted-foreground">Esperado</p></div>
            <div className="bg-secondary/40 rounded-xl py-2"><p className="font-bold">{formatMinutes(month.adjustmentMinutes)}</p><p className="text-muted-foreground">Ajustes</p></div>
            <div className={`rounded-xl py-2 ${month.balanceMinutes < 0 ? "bg-red-50" : "bg-green-50"}`}>
              <p className={`font-bold ${month.balanceMinutes < 0 ? "text-red-600" : "text-green-700"}`}>{formatMinutes(month.balanceMinutes)}</p>
              <p className="text-muted-foreground">Saldo</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
