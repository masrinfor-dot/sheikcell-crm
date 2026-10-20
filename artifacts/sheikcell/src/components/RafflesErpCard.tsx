import { useState } from "react";
import { api, API_BASE } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { ArrowRightLeft, Download, ExternalLink } from "lucide-react";

// Sorteios vão para o ERP Prumo (17/10/2026). Admin: 1) exporta, 2) importa
// no ERP (Sorteios › Importar do CRM), 3) desliga aqui. Desligado, a tela
// vira consulta do histórico com o link do ERP; o sorteio automático e o
// reenvio param. Os avisos aos ganhadores dos sorteios do ERP continuam
// saindo pelo WhatsApp deste CRM.

const erpLink = (erpUrl: string) => `${erpUrl.trim().replace(/\/+$/, "")}/sorteios`;

export function RafflesMovedNotice({ erpUrl }: { erpUrl: string }) {
  return (
    <div className="shk-card p-6 text-center space-y-2" data-testid="raffles-moved-notice">
      <ArrowRightLeft className="w-8 h-8 text-primary mx-auto" />
      <p className="text-sm font-bold">Os sorteios agora são feitos no ERP</p>
      <p className="text-xs text-muted-foreground">
        Criar, sortear e avisar os ganhadores: tudo em ERP › Sorteios (o aviso continua saindo pelo WhatsApp daqui).
        O histórico abaixo fica só para consulta.
      </p>
      {erpUrl.trim() && (
        <a href={erpLink(erpUrl)} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold">
          Abrir no ERP <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}

export default function RafflesErpCard({ moved, erpUrl, onChange }: {
  moved: boolean; erpUrl: string; onChange: (s: { moved: boolean; erpUrl: string }) => void;
}) {
  const { toast } = useToast();
  const [url, setUrl] = useState(erpUrl);
  const [busy, setBusy] = useState(false);

  const save = async (data: { moved?: boolean; erpUrl?: string }, ok: string) => {
    setBusy(true);
    try {
      onChange(await api.raffles.setMoved(data));
      toast({ title: ok });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="shk-card p-4 space-y-3 border-2 border-primary/20" data-testid="raffles-erp-card">
      <p className="text-sm font-bold flex items-center gap-2"><ArrowRightLeft className="w-4 h-4 text-primary" /> Passar os sorteios para o ERP</p>
      <ol className="text-xs text-muted-foreground list-decimal ml-4 space-y-0.5">
        <li>Baixe o arquivo abaixo (todos os sorteios e todos os resultados).</li>
        <li>No ERP, em <b>Sorteios › Importar do CRM</b>, envie o arquivo.</li>
        <li>Na chave do ERP (Integrações), marque o acesso <b>Sorteios</b> — é por ele que os avisos aos ganhadores saem pelo WhatsApp daqui.</li>
        <li>Confira no ERP e clique em <b>Desligar no CRM</b>.</li>
      </ol>
      <div className="flex flex-wrap gap-2 items-center">
        <a href={`${API_BASE}/raffles/export`} download data-testid="button-raffles-export-erp"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary">
          <Download className="w-3.5 h-3.5" /> Exportar sorteios para o ERP
        </a>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Endereço do ERP (https://...)"
          className="flex-1 min-w-[12rem] px-3 py-2 rounded-xl border border-border text-xs" data-testid="input-raffles-erp-url" />
        <button type="button" disabled={busy || url.trim() === erpUrl} onClick={() => save({ erpUrl: url.trim() }, "Endereço salvo")}
          className="px-3 py-2 rounded-xl border border-border text-xs font-semibold disabled:opacity-40">Salvar endereço</button>
      </div>
      <button type="button" disabled={busy} data-testid="button-raffles-toggle-moved"
        onClick={() => {
          if (!moved && !window.confirm("Desligar os sorteios no CRM? Os sorteios automáticos daqui param e a tela fica só para consulta. Os novos sorteios passam a ser feitos no ERP.")) return;
          void save({ moved: !moved, ...(url.trim() !== erpUrl ? { erpUrl: url.trim() } : {}) }, moved ? "Sorteios religados no CRM" : "Sorteios desligados no CRM");
        }}
        className={`px-4 py-2 rounded-xl text-xs font-bold disabled:opacity-40 ${moved ? "border border-border" : "bg-red-600 text-white"}`}>
        {moved ? "Religar no CRM (voltar atrás)" : "Desligar no CRM"}
      </button>
    </div>
  );
}
