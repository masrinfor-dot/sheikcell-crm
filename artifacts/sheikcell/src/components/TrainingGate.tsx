import { useState, useEffect, useCallback } from "react";
import { api, type Training } from "@/lib/api";
import TrainingViewer from "./TrainingViewer";
import { GraduationCap } from "lucide-react";

// Trava o uso do sistema enquanto houver treinamento OBRIGATÓRIO pendente.
export default function TrainingGate() {
  const [pending, setPending] = useState<Training[]>([]);

  const refresh = useCallback(() => {
    api.trainings.pending()
      .then((all) => setPending(all.filter((t) => t.mandatory)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const current = pending[0];
  if (!current) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-[99] flex items-center justify-center p-4 overflow-y-auto">
      <div className="shk-card w-full max-w-lg p-6 my-8 bg-white">
        <div className="flex items-center gap-2 mb-1">
          <GraduationCap className="w-5 h-5 text-primary" />
          <h3 className="font-bold">{current.title}</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Treinamento obrigatório — conclua para liberar o uso do sistema.
          {pending.length > 1 && ` (${pending.length} pendentes)`}
        </p>
        <TrainingViewer training={current} initialAnswers={current.draftAnswers}
          onCompleted={() => setPending((prev) => prev.slice(1))} />
      </div>
    </div>
  );
}
