import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Clock, CheckCircle2, Loader2 } from "lucide-react";

// Trava o uso do sistema até o colaborador (escala FIXA, com expediente
// previsto hoje) bater a entrada do dia. Mesmo padrão de ChecklistGate/
// TrainingGate, mas com z-index maior: bater ponto é uma ação de 1 clique,
// não deveria ficar escondida atrás de um questionário/treinamento longo.
export default function PontoGate() {
  const { toast } = useToast();
  const [needsClockIn, setNeedsClockIn] = useState(false);
  const [punching, setPunching] = useState(false);

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
    if (punching) return;
    setPunching(true);
    try {
      await api.rhDp.me.punch();
      toast({ title: "Ponto registrado! Bom trabalho." });
      setNeedsClockIn(false);
    } catch (err) {
      toast({ title: "Erro ao bater ponto", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
      refresh(); // pode já ter sido batido em outra aba
    } finally {
      setPunching(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[101] flex items-center justify-center p-4">
      <div className="shk-card w-full max-w-sm p-6 bg-white text-center space-y-4">
        <Clock className="w-10 h-10 mx-auto text-primary" />
        <div>
          <h3 className="font-bold">Bata o ponto para começar</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Registre sua entrada de hoje para liberar o uso do sistema.
          </p>
        </div>
        <button onClick={punch} disabled={punching} data-testid="button-ponto-gate-punch"
          className="w-full py-3 rounded-xl bg-primary text-white font-bold text-sm disabled:opacity-40 flex items-center justify-center gap-2">
          {punching ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Bater entrada
        </button>
      </div>
    </div>
  );
}
