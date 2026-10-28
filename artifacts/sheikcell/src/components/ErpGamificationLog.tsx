import { useCallback, useEffect, useState } from "react";
import {
  erpGamificationApi, ERP_EVENT_TYPE_LABEL, ERP_RESULT_LABEL, type ErpGamificationStatus,
} from "@/lib/erpGamificationApi";
import { Trophy, RefreshCw, Tv } from "lucide-react";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

const QUEUE_LABEL: Record<string, string> = { pending: "Na fila", processing: "Enviando", sent: "Enviado", failed: "Com erro" };

// Trocas com o ERP › Pontuação do atendimento (27/10/2026): o que foi mandado
// para a gamificação do ERP e o que o ERP respondeu (pontuou, atendente sem
// usuário, regra desligada...), mais a situação da fila na TV das lojas.
export default function ErpGamificationLog() {
  const [status, setStatus] = useState<ErpGamificationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    erpGamificationApi.status().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : "Erro ao carregar"));
  }, []);
  useEffect(load, [load]);

  const retry = async () => {
    setBusy(true);
    try { setStatus((await erpGamificationApi.retry()).status); } catch (e) { setError(e instanceof Error ? e.message : "Erro"); } finally { setBusy(false); }
  };

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!status) return null;
  const erp = Object.entries(status.erpLast30Days).sort((a, b) => b[1].count - a[1].count);

  return (
    <section className="space-y-3" data-testid="erp-gamification-log">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-bold text-sm text-foreground flex items-center gap-2"><Trophy className="w-4 h-4" /> Pontuação do atendimento (gamificação)</h3>
          <p className="text-xs text-muted-foreground">
            {status.enabled ? `Ligada desde ${fmt(status.since)} · última rodada ${fmt(status.lastSyncAt)}.` : "Desligada (cartão do ERP, aba Conexões)."}
            {" "}Vai só id e número; guardado 90 dias.
          </p>
        </div>
        <div className="flex gap-2">
          {status.queue.failed > 0 && (
            <button type="button" onClick={() => void retry()} disabled={busy}
              className="px-3 py-1.5 rounded-xl border border-border text-xs font-semibold hover:bg-muted disabled:opacity-50">
              Tentar de novo os com erro
            </button>
          )}
          <button type="button" onClick={load}
            className="px-3 py-1.5 rounded-xl border border-border text-xs font-semibold flex items-center gap-1 hover:bg-muted">
            <RefreshCw className="w-3 h-3" /> Atualizar
          </button>
        </div>
      </div>

      {status.lastError && (
        <p className="text-xs rounded-xl bg-amber-50 border border-amber-200 text-amber-900 p-3" data-testid="erp-gamification-log-error">{status.lastError}</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {(["sent", "pending", "failed", "processing"] as const).map((k) => (
          <div key={k} className="shk-card p-3">
            <p className="text-[11px] text-muted-foreground">{QUEUE_LABEL[k]}</p>
            <p className={`text-lg font-bold ${k === "failed" && status.queue[k] > 0 ? "text-red-600" : "text-foreground"}`}>{status.queue[k]}</p>
          </div>
        ))}
      </div>

      {erp.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs" data-testid="erp-gamification-results">
          <span className="text-muted-foreground self-center">Resposta do ERP (30 dias):</span>
          {erp.map(([k, v]) => (
            <span key={k} title={ERP_RESULT_LABEL[k]?.hint} className={`rounded-full px-2 py-0.5 font-semibold ${ERP_RESULT_LABEL[k]?.cls ?? "bg-muted"}`}>
              {ERP_RESULT_LABEL[k]?.label ?? k}: {v.count}{k === "APLICADO" ? ` (${v.points > 0 ? "+" : ""}${v.points} pts)` : ""}
            </span>
          ))}
        </div>
      )}

      {status.recent.length === 0 ? (
        <p className="shk-card p-4 text-sm text-muted-foreground">Nenhum evento ainda.</p>
      ) : (
        <div className="shk-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground bg-muted/40">
              <tr>
                <th className="px-3 py-2">Quando</th>
                <th className="px-3 py-2">Evento</th>
                <th className="px-3 py-2">Atendente</th>
                <th className="px-3 py-2">Conversa</th>
                <th className="px-3 py-2">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {status.recent.map((e) => {
                const r = e.erpStatus ? ERP_RESULT_LABEL[e.erpStatus] : null;
                return (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">{fmt(e.occurredAt)}</td>
                    <td className="px-3 py-2 text-xs">{ERP_EVENT_TYPE_LABEL[e.type] ?? e.type}</td>
                    <td className="px-3 py-2 text-xs">{e.agentName ?? "—"}</td>
                    <td className="px-3 py-2 text-xs font-mono">{e.conversationId != null ? `#${e.conversationId}` : "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {r ? (
                        <span title={r.hint} className={`inline-block rounded-full px-2 py-0.5 font-semibold ${r.cls}`}>
                          {r.label}{e.erpStatus === "APLICADO" && e.erpPoints ? ` ${e.erpPoints > 0 ? "+" : ""}${e.erpPoints}` : ""}
                        </span>
                      ) : (
                        <span className={e.status === "failed" ? "text-red-600" : "text-muted-foreground"}>{QUEUE_LABEL[e.status] ?? e.status}</span>
                      )}
                      {e.lastError && <span className="block mt-1 text-muted-foreground">{e.lastError}</span>}
                      {e.erpMessage && <span className="block mt-1 text-muted-foreground">{e.erpMessage}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="shk-card p-3 text-xs space-y-1" data-testid="erp-tv-status">
        <p className="font-semibold flex items-center gap-1"><Tv className="w-3.5 h-3.5" /> Clientes esperando resposta (TV da loja)</p>
        <p className="text-muted-foreground">
          {!status.tv.enabled ? "Desligado." : status.tv.links === 0 ? "Ligado, mas nenhuma loja ligada ao ERP ainda (cartão do ERP › Lojas no ERP)." : `Ligado · ${status.tv.links} ligação(ões) de loja · último envio ${fmt(status.tv.lastPushAt)}.`}
        </p>
        {status.tv.enabled && status.tv.lastError && <p className="text-red-600">{status.tv.lastError}</p>}
      </div>
    </section>
  );
}
