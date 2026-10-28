import { useEffect, useState } from "react";
import { erpGamificationApi, type ErpGamificationStatus, type ErpStoreLinks } from "@/lib/erpGamificationApi";
import { useToast } from "@/hooks/use-toast";
import { Trophy, Tv, AlertTriangle, Store } from "lucide-react";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

// Pontuação do atendimento → gamificação do ERP e "Clientes esperando
// resposta" na TV das lojas do ERP (27/10/2026). Fica no cartão do ERP.
export default function ErpGamificationBlock() {
  const { toast } = useToast();
  const [status, setStatus] = useState<ErpGamificationStatus | null>(null);
  const [links, setLinks] = useState<ErpStoreLinks | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { erpGamificationApi.status().then(setStatus).catch(() => {}); }, []);
  useEffect(() => {
    if (showLinks && !links) erpGamificationApi.storeLinks().then(setLinks).catch((e) => toast({ title: "Erro", description: e instanceof Error ? e.message : "Erro", variant: "destructive" }));
  }, [showLinks, links, toast]);

  const run = async <T,>(fn: () => Promise<T>, ok: string | ((r: T) => string)) => {
    setBusy(true);
    try {
      const r = await fn();
      toast({ title: typeof ok === "function" ? ok(r) : ok });
      return r;
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
      return null;
    } finally { setBusy(false); }
  };

  const toggle = (data: { enabled?: boolean; tvEnabled?: boolean }, ok: string) =>
    void run(() => erpGamificationApi.save(data), ok).then((s) => { if (s) setStatus(s); });

  const setLink = (kind: "store" | "line", crmRef: string, erpStoreId: string) =>
    void run(() => erpGamificationApi.saveStoreLinks([{ kind, crmRef, erpStoreId: erpStoreId || null }]), erpStoreId ? "Loja ligada" : "Ligação removida")
      .then((l) => { if (l) { setLinks(l); erpGamificationApi.status().then(setStatus).catch(() => {}); } });

  const runNow = () => void run(() => erpGamificationApi.runNow(), (r) => {
    const g = r.gamification;
    const n = g.enqueued.firstResponse + g.enqueued.sla + g.enqueued.converted;
    return `${n} evento(s) novo(s), ${g.sent} enviado(s) ao ERP · TV: ${r.tv.skipped ? r.tv.skipped : `${r.tv.waiting} esperando em ${r.tv.stores} loja(s)`}`;
  }).then((r) => { if (r) setStatus(r.status); });

  if (!status) return null;
  const linkOf = (kind: "store" | "line", ref: string) => links?.links.find((l) => l.kind === kind && l.crmRef === ref)?.erpStoreId ?? "";
  const erpSelect = (kind: "store" | "line", ref: string) => (
    <select value={linkOf(kind, ref)} disabled={busy || !links?.erpStores} data-testid={`select-erp-store-${kind}-${ref}`}
      onChange={(e) => setLink(kind, ref, e.target.value)}
      className="px-2 py-1 rounded-lg border border-border bg-white text-xs max-w-[14rem]">
      <option value="">— não ligar —</option>
      {(links?.erpStores ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ""}</option>)}
      {/* Ligação salva com uma loja que a lista não trouxe (lista indisponível agora). */}
      {linkOf(kind, ref) && !(links?.erpStores ?? []).some((s) => s.id === linkOf(kind, ref)) && (
        <option value={linkOf(kind, ref)}>{links?.links.find((l) => l.kind === kind && l.crmRef === ref)?.erpStoreName ?? "Loja do ERP"}</option>
      )}
    </select>
  );

  return (
    <div className="rounded-xl border border-border p-3 space-y-3 text-xs" data-testid="erp-gamification-block">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={status.enabled} disabled={busy} data-testid="checkbox-erp-gamification" className="mt-1"
          onChange={(e) => toggle({ enabled: e.target.checked }, e.target.checked ? "Pontuação de atendimento ligada" : "Pontuação de atendimento desligada")} />
        <span>
          <span className="font-semibold flex items-center gap-1"><Trophy className="w-3.5 h-3.5" /> Enviar pontuação de atendimento ao ERP</span>
          <span className="block text-xs text-muted-foreground">
            A cada minuto o CRM avisa o ERP da primeira resposta de cada atendimento (em segundos), da conversa que ficou sem resposta
            além do limite do alarme da Central e da conversa que virou venda no ERP. O ERP dá ou tira os pontos (Metas e Performance › Gamificação).
            Vai só id e número — nunca o texto da conversa. Conta a partir de quando foi ligado.
            A chave do ERP precisa do acesso "Eventos de atendimento (gamificação)" (e "Vendas do atendimento" para a conversa que virou venda).
          </span>
        </span>
      </label>
      {status.enabled && (
        <p className="text-[11px] text-muted-foreground">
          Desde {fmt(status.since)} · última rodada {fmt(status.lastSyncAt)} · {status.queue.sent} enviado(s)
          {status.queue.pending > 0 ? ` · ${status.queue.pending} na fila` : ""}{status.queue.failed > 0 ? ` · ${status.queue.failed} com erro` : ""}
          {" "}— detalhes na aba "Trocas com o ERP".
        </p>
      )}
      {status.enabled && status.lastError && (
        <p className="text-[11px] text-red-700 flex items-start gap-1" data-testid="erp-gamification-error"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {status.lastError}</p>
      )}

      <label className="flex items-start gap-2 text-sm pt-2 border-t border-border">
        <input type="checkbox" checked={status.tv.enabled} disabled={busy} data-testid="checkbox-erp-tv-waiting" className="mt-1"
          onChange={(e) => toggle({ tvEnabled: e.target.checked }, e.target.checked ? "Fila na TV ligada" : "Fila na TV desligada")} />
        <span>
          <span className="font-semibold flex items-center gap-1"><Tv className="w-3.5 h-3.5" /> Mostrar "Clientes esperando resposta" na TV da loja (ERP)</span>
          <span className="block text-xs text-muted-foreground">
            A cada minuto o CRM manda, para cada loja do ERP, quem está esperando resposta: só o primeiro nome + inicial ("Ana S."), o canal, o setor e há quanto tempo.
            Nunca o celular nem as mensagens. A chave do ERP precisa do acesso "Fila de espera do atendimento (TV da loja)".
          </span>
        </span>
      </label>
      {status.tv.enabled && (
        <p className="text-[11px] text-muted-foreground">
          {status.tv.links === 0 ? "Nenhuma loja ligada ainda — ligue abaixo." : `${status.tv.links} ligação(ões) de loja · último envio ${fmt(status.tv.lastPushAt)}`}
        </p>
      )}
      {status.tv.enabled && status.tv.lastError && (
        <p className="text-[11px] text-red-700 flex items-start gap-1" data-testid="erp-tv-error"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {status.tv.lastError}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setShowLinks((v) => !v)} data-testid="button-erp-store-links"
          className="px-3 py-1 rounded-lg border border-border text-xs font-semibold hover:bg-muted flex items-center gap-1">
          <Store className="w-3 h-3" /> {showLinks ? "Fechar lojas no ERP" : "Lojas no ERP"}
        </button>
        {(status.enabled || status.tv.enabled) && (
          <button type="button" onClick={runNow} disabled={busy} data-testid="button-erp-gamification-run"
            className="px-3 py-1 rounded-lg border border-border text-xs font-semibold hover:bg-muted disabled:opacity-50">
            Enviar agora
          </button>
        )}
      </div>

      {showLinks && (
        <div className="space-y-2" data-testid="erp-store-links">
          <p className="text-[11px] text-muted-foreground">
            Diga qual loja do ERP é cada loja daqui. A conversa vai para a loja escolhida pelo robô, a loja de quem atende ou a do responsável;
            sem isso, vale a linha de WhatsApp. Usado na TV da loja e para dizer ao ERP em que loja foi o atendimento.
          </p>
          {!links ? <p className="text-muted-foreground">Carregando...</p> : (
            <>
              {links.erpStoresError && (
                <p className="text-[11px] text-amber-800 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {links.erpStoresError}</p>
              )}
              <p className="font-semibold pt-1">Lojas</p>
              {links.crmStores.length === 0 && <p className="text-muted-foreground">Nenhuma loja cadastrada aqui (Setores › Lojas da Rede).</p>}
              {links.crmStores.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2">
                  <span>{s.name}</span>
                  {erpSelect("store", String(s.id))}
                </div>
              ))}
              <p className="font-semibold pt-1">Linhas (quando a conversa não tem loja)</p>
              {links.lines.map((l) => (
                <div key={l.ref} className="flex items-center justify-between gap-2">
                  <span>{l.label}</span>
                  {erpSelect("line", l.ref)}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
