import { useEffect, useState } from "react";
import { api, type ErpIntegrationStatus } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Link2, Trash2, CheckCircle2, AlertTriangle } from "lucide-react";

// Ligação com o ERP Prumo (06/10/2026): endereço da API e a chave gerada no
// ERP (Auxiliares › Integrações, acesso "Mensagens das OS"). Ligado, o CRM
// busca a cada minuto as mensagens das ordens de serviço e manda pelo
// WhatsApp no setor "Assistência Técnica", já abrindo o atendimento.
export default function ErpIntegrationCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<ErpIntegrationStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  // Linhas de WhatsApp da loja, pra escolher a de atacado (16/10/2026).
  const [waLines, setWaLines] = useState<{ sessionKey: string; displayName: string | null; phoneNumber: string | null }[]>([]);
  useEffect(() => { api.chat.waSessions().then(setWaLines).catch(() => {}); }, []);

  const load = () => {
    api.settings.erp.get().then((s) => { setStatus(s); setBaseUrl(s.baseUrl); }).catch(() => {});
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<ErpIntegrationStatus | void>, ok: string) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) { setStatus(s); setBaseUrl(s.baseUrl); }
      toast({ title: ok });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    const s = await api.settings.erp.save({ baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    setApiKey("");
    return s;
  }, "Ligação com o ERP salva!");

  const test = () => run(async () => {
    const r = await api.settings.erp.test();
    toast({
      title: `Conectado ao ERP: ${r.tenant}`,
      description: [
        r.canSendOsMessages ? "Mensagens das OS: ok." : "Sem o acesso \"Mensagens das OS\".",
        r.canSyncHr ? "RH: ok." : "Sem o acesso \"RH (colaboradores e ponto)\".",
      ].join(" "),
      variant: r.canSendOsMessages || r.canSyncHr ? "default" : "destructive",
    });
  }, "Teste concluído");

  return (
    <div className="shk-card p-5 space-y-4" data-testid="erp-integration-card">
      <div className="flex items-center gap-2">
        <Link2 className="w-4 h-4 text-primary" />
        <h3 className="font-bold text-sm text-foreground">ERP Prumo — mensagens das OS e RH</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        A cada mudança da OS no ERP (orçamento, aguardando peça, pronta, entregue…), o CRM manda a mensagem com peças, valores, laudo e o link de acompanhamento pelo WhatsApp e abre o atendimento no setor "Assistência Técnica".
        Com a chave salva, o robô do WhatsApp também responde quando o cliente pergunta da OS ("meu celular já ficou pronto?"), consultando a situação no ERP pelo número de quem escreveu.
      </p>

      {status?.configured && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2 text-xs text-emerald-900">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Chave salva: <span className="font-mono font-semibold">erp_...{status.last4}</span>
            </span>
            <button onClick={() => run(() => api.settings.erp.remove(), "Ligação removida")} disabled={busy}
              className="text-[11px] font-semibold text-red-600 hover:underline flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3 h-3" /> Remover
            </button>
          </div>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={status.osMessagesEnabled} disabled={busy} data-testid="checkbox-erp-os-messages"
              onChange={(e) => run(() => api.settings.erp.save({ osMessagesEnabled: e.target.checked }), e.target.checked ? "Mensagens das OS ligadas" : "Mensagens das OS desligadas")} />
            Mandar as mensagens das OS pelo WhatsApp
          </label>
          <p className="text-[11px]">
            {status.lastPollAt ? `Última busca: ${new Date(status.lastPollAt).toLocaleString("pt-BR")}` : "Ainda não buscou."} · {status.sentCount} mensagem(ns) enviada(s)
          </p>
          {status.lastError && (
            <p className="text-[11px] text-red-700 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {status.lastError}</p>
          )}
          <label className="flex items-center gap-2 font-medium pt-2 border-t border-emerald-200">
            <input type="checkbox" checked={status.hrSyncEnabled} disabled={busy} data-testid="checkbox-erp-hr-sync"
              onChange={(e) => run(() => api.settings.erp.save({ hrSyncEnabled: e.target.checked }), e.target.checked ? "RH ligado ao ERP" : "RH desligado do ERP")} />
            RH no ERP: mandar batidas de ponto, fechamento do mês e documentos da contratação
          </label>
          <p className="text-[11px]">
            O ERP é o dono do cadastro dos colaboradores (salário, documentos, folha). Aqui fica só o ponto pelo WhatsApp.
            {" "}{status.hrImportedAt ? `Importação inicial feita em ${new Date(status.hrImportedAt).toLocaleString("pt-BR")}.` : "Ao ligar, os colaboradores daqui vão uma vez para o ERP."}
            {status.hrLastSyncAt ? ` Última sincronização: ${new Date(status.hrLastSyncAt).toLocaleString("pt-BR")}.` : ""}
          </p>
          {status.hrLastError && (
            <p className="text-[11px] text-red-700 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {status.hrLastError}</p>
          )}
          {status.hrSyncEnabled && (
            <div className="pt-2 border-t border-emerald-200 space-y-1">
              {status.hrMovedToErp ? (
                <>
                  <p className="font-semibold">RH no ERP desde {status.hrMovedAt ? new Date(status.hrMovedAt).toLocaleDateString("pt-BR") : "—"}.</p>
                  <p className="text-[11px]">
                    {status.hrHistoryDoneAt
                      ? `Histórico todo enviado em ${new Date(status.hrHistoryDoneAt).toLocaleString("pt-BR")}.`
                      : `Enviando o histórico: ${Object.values(status.hrHistoryCursors ?? {}).filter((v) => v === -1).length} de 13 partes prontas…`}
                    {" "}As telas de RH daqui ficam só de consulta; o ponto pelo WhatsApp continua aqui.
                  </p>
                </>
              ) : (
                <>
                  <button type="button" disabled={busy || !status.erpWebUrl} data-testid="button-erp-hr-move"
                    onClick={() => window.confirm("Mudar o RH para o ERP? Recrutamento, contratação, departamento pessoal e documentos passam a ser feitos só no ERP (aqui fica de consulta). O link \"Trabalhe conosco\" continua o mesmo e abre no ERP. O ponto pelo WhatsApp continua aqui.")
                      && run(() => api.settings.erp.save({ hrMovedToErp: true }), "RH mudando para o ERP")}
                    className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-[11px] font-semibold disabled:opacity-50">
                    Mudar o RH para o ERP
                  </button>
                  {!status.erpWebUrl && <p className="text-[11px]">Clique em Testar primeiro (o ERP informa o endereço das telas).</p>}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {status?.configured && (
        <div className="rounded-xl border border-border p-3 space-y-2 text-xs" data-testid="erp-demand-block">
          <p className="font-bold text-sm">Pedidos de clientes sem estoque (atacado)</p>
          <p className="text-[11px] text-muted-foreground">
            As conversas da linha de atacado vão para a IA do ERP, que lista o que os clientes pediram e confere o estoque.
            A lista fica no ERP, em Compras › Pedidos de clientes. Só o texto do cliente é enviado; primeira rodada: últimos 90 dias.
            A chave do ERP precisa do acesso "Pedidos de clientes (atacado)".
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select value={status.demandSessionKey ?? ""} disabled={busy} data-testid="select-erp-demand-line"
              onChange={(e) => run(() => api.settings.erp.save({ demandSessionKey: e.target.value || null }), e.target.value ? "Linha de atacado salva" : "Linha de atacado removida")}
              className="px-2 py-1.5 rounded-lg border border-border bg-white text-xs">
              <option value="">Linha de atacado: escolher…</option>
              {waLines.map((l) => (
                <option key={l.sessionKey} value={l.sessionKey}>{l.displayName || l.sessionKey}{l.phoneNumber ? ` · ${l.phoneNumber}` : ""}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={status.demandSyncEnabled} disabled={busy || !status.demandSessionKey} data-testid="checkbox-erp-demand"
                onChange={(e) => run(() => api.settings.erp.save({ demandSyncEnabled: e.target.checked }), e.target.checked ? "Pedidos de clientes ligados" : "Pedidos de clientes desligados")} />
              Mandar para o ERP
            </label>
            {status.demandSyncEnabled && (
              <button type="button" disabled={busy} data-testid="button-erp-demand-run"
                onClick={() => run(async () => {
                  const r = await api.settings.erp.demandRun();
                  toast({ title: `${r.requests} pedido(s) lidos em ${r.conversations} conversa(s)`, description: `${r.outOfStock} sem estoque nesta rodada.` });
                  return r.status;
                }, "Conversas enviadas ao ERP")}
                className="px-3 py-1.5 rounded-lg border border-border text-[11px] font-semibold disabled:opacity-50">
                Enviar agora
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {status.demandLastSyncAt ? `Último envio: ${new Date(status.demandLastSyncAt).toLocaleString("pt-BR")}` : "Ainda não enviou."}
            {" "}· {status.demandSentCount} pedido(s) lido(s)
            {status.demandPendingCount > 0 ? ` · ${status.demandPendingCount} conversa(s) ainda por mandar` : ""}
          </p>
          {status.demandLastError && (
            <p className="text-[11px] text-red-700 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {status.demandLastError}</p>
          )}
        </div>
      )}

      <div>
        <label className="text-xs font-medium mb-1 block">Endereço da API do ERP</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} data-testid="input-erp-base-url"
          placeholder="https://api.sheikcell.com.br/api/v1"
          className="w-full px-3 py-2 rounded-xl border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <p className="text-[10px] text-muted-foreground mt-1">É o endereço da API (api.…/api/v1), não o das telas do ERP.</p>
      </div>
      <div>
        <label className="text-xs font-medium mb-1 block">{status?.configured ? "Trocar chave" : "Colar a chave do ERP"}</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="erp_..." autoComplete="off" data-testid="input-erp-api-key"
          className="w-full px-3 py-2 rounded-xl border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <p className="text-[10px] text-muted-foreground mt-1">
          Gere no ERP em Auxiliares › Integrações com o acesso "Mensagens das OS". Depois de salva, a chave não aparece de novo.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        {status?.configured && (
          <button type="button" onClick={test} disabled={busy}
            className="px-4 py-2 rounded-xl border border-border text-sm font-semibold hover:bg-muted transition disabled:opacity-50">
            Testar
          </button>
        )}
        <button type="button" onClick={save} disabled={busy || (!status?.configured && !apiKey.trim())} data-testid="button-save-erp"
          className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
          {busy ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </div>
  );
}
