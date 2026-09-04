import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { usePunchCapture } from "@/hooks/use-punch-capture";
import { Clock, CheckCircle2, Loader2, Camera, MapPin, AlertTriangle } from "lucide-react";

// Trava o uso do sistema até o colaborador (escala FIXA, com expediente
// previsto hoje) bater a entrada do dia. Mesmo padrão de ChecklistGate/
// TrainingGate, mas com z-index maior: bater ponto é uma ação de 1 clique,
// não deveria ficar escondida atrás de um questionário/treinamento longo.
//
// PontoGate só é exibido pra faltar a batida de ENTRADA do dia (é a única
// que bloqueia o sistema — ver employeeNeedsClockInToday em lib/timeBank.ts
// e enforceMandatoryClockIn em rhDp.ts), então sempre exige foto (selfie) +
// geolocalização antes de liberar — o backend rejeita (400) uma batida de
// entrada sem os dois. Intervalo/saída (batidos pela MeuPonto.tsx, fora
// deste gate) continuam sem essa exigência.
export default function PontoGate() {
  const { toast } = useToast();
  const [needsClockIn, setNeedsClockIn] = useState(false);
  const [punching, setPunching] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const { cam, geo, videoRef, ready, startCamera, startGeo, capture, captureWithoutPhoto, stop } = usePunchCapture(needsClockIn);

  // Relógio ao vivo, só pra dar confiança de que o horário que vai ser
  // gravado é o de agora (mesma ideia do relógio que aparece na tela de
  // "Registrar Ponto" da Sólides/Tangerino) — puramente visual, o horário
  // gravado de verdade é o do servidor, não o do navegador.
  useEffect(() => {
    if (!needsClockIn) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [needsClockIn]);

  const refresh = useCallback(() => {
    api.rhDp.me.clockStatus().then((s) => setNeedsClockIn(s.needsClockIn)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!needsClockIn) return null;

  const punch = async () => {
    if (punching || !ready) return;
    const payload = capture();
    if (!payload) return;
    setPunching(true);
    try {
      await api.rhDp.me.punch(payload);
      stop();
      toast({ title: "Ponto registrado! Bom trabalho." });
      setNeedsClockIn(false);
    } catch (err) {
      toast({ title: "Erro ao bater ponto", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
      refresh(); // pode já ter sido batido em outra aba
    } finally {
      setPunching(false);
    }
  };

  // Via de escape: quando a câmera dá erro (sem webcam, permissão negada,
  // travada em outro app, timeout etc.), não faz sentido deixar o
  // colaborador travado pra sempre — bate a entrada só com localização, e o
  // backend marca `flagged` pra revisão do admin (painel RH → Ponto).
  // Localização continua sempre obrigatória.
  const punchWithoutPhoto = async () => {
    if (punching || geo.status !== "ok") return;
    const payload = captureWithoutPhoto(cam.error ?? "Câmera indisponível");
    if (!payload) return;
    setPunching(true);
    try {
      await api.rhDp.me.punch(payload);
      stop();
      toast({ title: "Ponto registrado sem foto", description: "Sua entrada foi sinalizada para revisão do RH, já que a câmera não funcionou." });
      setNeedsClockIn(false);
    } catch (err) {
      toast({ title: "Erro ao bater ponto", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
      refresh();
    } finally {
      setPunching(false);
    }
  };

  const camError = cam.status === "error";
  const geoError = geo.status === "error";

  return (
    <div className="fixed inset-0 bg-black/60 z-[101] flex items-center justify-center p-4">
      <div className="shk-card w-full max-w-sm p-6 bg-white text-center space-y-4">
        <Clock className="w-10 h-10 mx-auto text-primary" />
        <div>
          <h3 className="font-bold">Bata o ponto para começar</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Tire uma foto e confirme sua localização para registrar a entrada de hoje.
          </p>
          <p className="text-2xl font-bold tabular-nums mt-2" data-testid="text-ponto-gate-clock">
            {now.toLocaleTimeString("pt-BR")}
          </p>
          <p className="text-[11px] text-muted-foreground">{now.toLocaleDateString("pt-BR")}</p>
        </div>

        <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-muted flex items-center justify-center">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} playsInline className={`w-full h-full object-cover ${cam.status === "ok" ? "" : "hidden"}`} />
          {cam.status === "loading" && <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />}
          {camError && (
            <div className="p-3 flex flex-col items-center gap-2 text-destructive">
              <Camera className="w-6 h-6" />
              <p className="text-xs">{cam.error}</p>
            </div>
          )}
        </div>

        {!camError && (
          <p className="text-[11px] text-muted-foreground -mt-2">
            Use o Google Chrome e libere a câmera quando o navegador pedir, para o ponto funcionar certinho.
          </p>
        )}

        {camError && (
          <button onClick={startCamera} className="text-xs font-semibold text-primary underline" data-testid="button-ponto-gate-retry-camera">
            Tentar acessar a câmera de novo
          </button>
        )}

        <div className="flex items-center justify-center gap-2 text-xs">
          <MapPin className={`w-4 h-4 ${geo.status === "ok" ? "text-emerald-600" : geoError ? "text-destructive" : "text-muted-foreground"}`} />
          {geo.status === "loading" && <span className="text-muted-foreground">Obtendo localização...</span>}
          {geo.status === "ok" && <span className="text-emerald-600 font-medium">Localização confirmada</span>}
          {geoError && <span className="text-destructive">{geo.error}</span>}
        </div>
        {geoError && (
          <button onClick={startGeo} className="text-xs font-semibold text-primary underline -mt-2" data-testid="button-ponto-gate-retry-geo">
            Tentar de novo
          </button>
        )}

        {geoError && !camError && (
          <div className="flex items-start gap-2 text-left bg-amber-50 border border-amber-200 rounded-lg p-2 text-[11px] text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Localização é obrigatória para bater o ponto de entrada. Sem ela o sistema fica bloqueado.</span>
          </div>
        )}

        <button onClick={punch} disabled={punching || !ready} data-testid="button-ponto-gate-punch"
          className="w-full py-3 rounded-xl bg-primary text-white font-bold text-sm disabled:opacity-40 flex items-center justify-center gap-2">
          {punching ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Bater entrada
        </button>

        {camError && (
          <>
            <div className="flex items-start gap-2 text-left bg-amber-50 border border-amber-200 rounded-lg p-2 text-[11px] text-amber-800">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Se a câmera continuar sem funcionar, você pode bater o ponto só com a localização — isso vai ficar sinalizado para o RH revisar.</span>
            </div>
            <button onClick={punchWithoutPhoto} disabled={punching || geo.status !== "ok"} data-testid="button-ponto-gate-punch-no-photo"
              className="w-full py-3 rounded-xl bg-white border-2 border-primary text-primary font-bold text-sm disabled:opacity-40 flex items-center justify-center gap-2">
              {punching ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Continuar sem foto (câmera indisponível)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
