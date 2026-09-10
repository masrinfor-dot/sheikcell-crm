import { useState, useEffect, useCallback } from "react";
import { api, type Employee, type TimeBankResult, type VacationDeadline, type VacationRequest, type TimesheetMonth } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { usePunchCapture } from "@/hooks/use-punch-capture";
import { Clock, Wallet, CheckCircle2, Loader2, Camera, MapPin, Palmtree, X, Send, FileSignature } from "lucide-react";

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
  const [vacationDeadline, setVacationDeadline] = useState<VacationDeadline | null>(null);
  const [vacationRequests, setVacationRequests] = useState<VacationRequest[]>([]);
  const [requestingVacation, setRequestingVacation] = useState(false);
  const [vacationForm, setVacationForm] = useState({ startDate: "", endDate: "" });
  const [sendingVacation, setSendingVacation] = useState(false);
  const [timesheetMonths, setTimesheetMonths] = useState<TimesheetMonth[]>([]);
  const [signingMonth, setSigningMonth] = useState<string | null>(null);

  const loadVacation = useCallback(() => {
    api.rhDp.me.vacation().then((r) => { setVacationDeadline(r.deadline); setVacationRequests(r.requests); }).catch(() => {});
  }, []);
  const loadTimesheet = useCallback(() => {
    api.rhDp.me.timesheetMonths().then(setTimesheetMonths).catch(() => {});
  }, []);

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
      loadVacation();
      loadTimesheet();
    } catch {
      setNotLinked(true);
    } finally {
      setLoading(false);
    }
  }, [loadVacation, loadTimesheet]);

  useEffect(() => { load(); }, [load]);

  const monthLabel = (m: string): string => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y!, mo! - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  };

  const signMonth = async (m: string) => {
    setSigningMonth(m);
    try {
      await api.rhDp.me.signTimesheet(m);
      toast({ title: "Espelho de ponto assinado!", description: `Confirmação registrada para ${monthLabel(m)}.` });
      loadTimesheet();
    } catch (err) {
      toast({ title: "Erro ao assinar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSigningMonth(null);
    }
  };

  const sendVacationRequest = async () => {
    if (!vacationForm.startDate || !vacationForm.endDate) { toast({ title: "Preencha o período", variant: "destructive" }); return; }
    setSendingVacation(true);
    try {
      await api.rhDp.me.requestVacation(vacationForm);
      toast({ title: "Pedido de férias enviado!", description: "O RH vai analisar e te avisar." });
      setRequestingVacation(false);
      setVacationForm({ startDate: "", endDate: "" });
      loadVacation();
    } catch (err) {
      toast({ title: "Erro ao enviar pedido", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSendingVacation(false);
    }
  };

  const VACATION_STATUS_LABELS: Record<VacationRequest["status"], string> = { pendente: "Em análise", aprovado: "Aprovado", rejeitado: "Rejeitado" };
  const VACATION_STATUS_CLASSES: Record<VacationRequest["status"], string> = {
    pendente: "bg-amber-50 text-amber-700 border-amber-100",
    aprovado: "bg-green-50 text-green-700 border-green-100",
    rejeitado: "bg-red-50 text-red-600 border-red-100",
  };

  const todayEntries = today?.days[0]?.entries ?? [];
  const doneForToday = todayEntries.length > 0 && todayEntries[todayEntries.length - 1]!.kind === "out";
  // Sem nenhuma batida hoje ainda, a próxima é sempre "entrada" — exige foto
  // + geo do mesmo jeito que o PontoGate.tsx (o backend rejeita sem isso).
  // Só se aplica a quem bate a entrada por aqui em vez de pelo gate: admin
  // (isento do gate) ou colaborador de escala flexível (gate nunca aparece).
  const nextIsIn = todayEntries.length === 0;
  const needsCapture = nextIsIn && !doneForToday && !loading && !notLinked && !!employee;
  const { cam, geo, videoRef, ready, startCamera, startGeo, capture, captureWithoutPhoto, stop } = usePunchCapture(needsCapture);

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

  // Mesma via de escape do PontoGate.tsx: se a câmera não funcionar aqui
  // (admin ou colaborador de escala flexível batendo a própria entrada fora
  // do gate), bate só com localização e sinaliza pra revisão do RH em vez de
  // deixar sem alternativa nenhuma.
  const punchWithoutPhoto = async () => {
    if (punching || geo.status !== "ok") return;
    const payload = captureWithoutPhoto(cam.error ?? "Câmera indisponível");
    if (!payload) return;
    setPunching(true);
    try {
      await api.rhDp.me.punch(payload);
      stop();
      toast({ title: "Ponto registrado sem foto", description: "Sinalizado para revisão do RH, já que a câmera não funcionou." });
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

        {needsCapture && cam.status === "error" && (
          <button onClick={punchWithoutPhoto} disabled={punching || geo.status !== "ok"} data-testid="button-meuponto-punch-no-photo"
            className="w-full py-3 rounded-2xl bg-white border-2 border-primary text-primary font-bold text-sm disabled:opacity-40 flex items-center justify-center gap-2">
            {punching ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Continuar sem foto (câmera indisponível)
          </button>
        )}

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

      <div className="shk-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Palmtree className="w-4 h-4 text-primary" />
            <h3 className="font-bold text-sm">Férias</h3>
          </div>
          <button onClick={() => setRequestingVacation(true)} data-testid="button-request-vacation"
            className="text-xs font-bold px-3 py-1.5 rounded-xl bg-primary text-white">
            Solicitar férias
          </button>
        </div>

        {vacationDeadline && (
          <div className={`rounded-xl p-3 text-xs ${vacationDeadline.overdue ? "bg-red-50 text-red-700" : vacationDeadline.daysUntilDue <= 30 ? "bg-amber-50 text-amber-700" : "bg-secondary/40 text-foreground"}`}>
            {vacationDeadline.overdue
              ? `Suas férias venceram em ${new Date(`${vacationDeadline.dueDate}T12:00:00`).toLocaleDateString("pt-BR")}. Solicite o quanto antes.`
              : `Você tem férias disponíveis — vencem em ${new Date(`${vacationDeadline.dueDate}T12:00:00`).toLocaleDateString("pt-BR")} (${vacationDeadline.daysUntilDue} dia(s)).`}
          </div>
        )}

        {vacationRequests.length > 0 && (
          <div className="space-y-1.5">
            {vacationRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-xs bg-secondary/30 rounded-xl px-3 py-2" data-testid={`vacation-request-${r.id}`}>
                <span>
                  {new Date(`${r.startDate}T12:00:00`).toLocaleDateString("pt-BR")} – {new Date(`${r.endDate}T12:00:00`).toLocaleDateString("pt-BR")} ({r.daysCount}d)
                </span>
                <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${VACATION_STATUS_CLASSES[r.status]}`}>{VACATION_STATUS_LABELS[r.status]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {timesheetMonths.length > 0 && (
        <div className="shk-card p-5 space-y-2">
          <div className="flex items-center gap-2">
            <FileSignature className="w-4 h-4 text-primary" />
            <h3 className="font-bold text-sm">Espelho de ponto</h3>
          </div>
          <div className="space-y-1.5">
            {timesheetMonths.map((t) => (
              <div key={t.closureId} className="flex items-center justify-between gap-2 text-xs bg-secondary/30 rounded-xl px-3 py-2" data-testid={`timesheet-month-${t.periodMonth}`}>
                <span className="capitalize">{monthLabel(t.periodMonth)}</span>
                {t.signedAt ? (
                  <span className="text-[10px] font-bold text-green-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Assinado</span>
                ) : (
                  <button onClick={() => signMonth(t.periodMonth)} disabled={signingMonth === t.periodMonth} data-testid={`button-sign-timesheet-${t.periodMonth}`}
                    className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-primary text-white disabled:opacity-40">
                    {signingMonth === t.periodMonth ? "Assinando..." : "Confirmar e assinar"}
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">Ao assinar, você confirma que revisou e concorda com o total de horas trabalhadas, esperadas e o saldo do mês.</p>
        </div>
      )}

      {requestingVacation && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6 bg-white space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Solicitar férias</h3>
              <button onClick={() => setRequestingVacation(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                Início
                <input type="date" value={vacationForm.startDate} onChange={(e) => setVacationForm({ ...vacationForm, startDate: e.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
              <label className="text-xs">
                Fim
                <input type="date" value={vacationForm.endDate} onChange={(e) => setVacationForm({ ...vacationForm, endDate: e.target.value })}
                  className="w-full mt-0.5 px-3 py-2 rounded-xl border border-border text-sm" />
              </label>
            </div>
            <button onClick={sendVacationRequest} disabled={sendingVacation} data-testid="button-confirm-vacation-request"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
              {sendingVacation ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Enviar pedido
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
