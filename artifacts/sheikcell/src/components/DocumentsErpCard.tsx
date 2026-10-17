import { useState } from "react";
import { api, API_BASE } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { ArrowRightLeft, Download, ExternalLink } from "lucide-react";

// Documentos da loja vão para o ERP (17/10/2026). Admin: 1) exporta,
// 2) importa no ERP, 3) desliga aqui. Desligado, a tela mostra o aviso com o
// link pro ERP e a lista fica só para consulta (sem enviar nem excluir).
export function DocumentsMovedNotice({ erpUrl }: { erpUrl: string }) {
  return (
    <div className="shk-card p-6 text-center space-y-2" data-testid="documents-moved-notice">
      <ArrowRightLeft className="w-8 h-8 text-primary mx-auto" />
      <p className="text-sm font-bold">Os documentos da loja agora ficam no ERP</p>
      <p className="text-xs text-muted-foreground">Enviar, baixar e excluir: tudo em ERP › Documentos da loja. A lista abaixo continua aqui só para consulta.</p>
      {erpUrl && (
        <a href={`${erpUrl.replace(/\/+$/, "")}/documentos-loja`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold">
          Abrir no ERP <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}

export default function DocumentsErpCard({ moved, erpUrl, onChange }: {
  moved: boolean; erpUrl: string; onChange: (s: { moved: boolean; erpUrl: string }) => void;
}) {
  const { toast } = useToast();
  const [url, setUrl] = useState(erpUrl);
  const [busy, setBusy] = useState(false);

  const save = async (data: { moved?: boolean; erpUrl?: string }, ok: string) => {
    setBusy(true);
    try {
      onChange(await api.documents.setMoved(data));
      toast({ title: ok });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="shk-card p-4 space-y-3 border-2 border-primary/20" data-testid="documents-erp-card">
      <p className="text-sm font-bold flex items-center gap-2"><ArrowRightLeft className="w-4 h-4 text-primary" /> Documentos no ERP</p>
      <ol className="text-xs text-muted-foreground list-decimal ml-4 space-y-0.5">
        <li>Baixe o arquivo abaixo (todos os documentos, com os arquivos).</li>
        <li>No ERP, em <b>Documentos da loja › Importar do CRM</b>, envie o arquivo em até 3 dias (os links dos arquivos vencem).</li>
        <li>Confira no ERP e clique em <b>Desligar no CRM</b>.</li>
      </ol>
      <div className="flex flex-wrap gap-2 items-center">
        <a href={`${API_BASE}/documents/export`} download data-testid="button-documents-export-erp"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary">
          <Download className="w-3.5 h-3.5" /> Exportar documentos para o ERP
        </a>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Endereço do ERP (https://...)"
          className="flex-1 min-w-[12rem] px-3 py-2 rounded-xl border border-border text-xs" data-testid="input-documents-erp-url" />
        <button type="button" disabled={busy || url.trim() === erpUrl} onClick={() => save({ erpUrl: url.trim() }, "Endereço salvo")}
          className="px-3 py-2 rounded-xl border border-border text-xs font-semibold disabled:opacity-40">Salvar endereço</button>
      </div>
      <button type="button" disabled={busy} data-testid="button-documents-toggle-moved"
        onClick={() => {
          if (!moved && !window.confirm("Desligar os documentos no CRM? Ninguém mais envia nem exclui documentos aqui — só no ERP. A lista continua para consulta.")) return;
          void save({ moved: !moved, ...(url.trim() !== erpUrl ? { erpUrl: url.trim() } : {}) }, moved ? "Documentos religados no CRM" : "Documentos desligados no CRM");
        }}
        className={`px-4 py-2 rounded-xl text-xs font-bold disabled:opacity-40 ${moved ? "border border-border" : "bg-red-600 text-white"}`}>
        {moved ? "Religar no CRM (voltar atrás)" : "Desligar no CRM"}
      </button>
    </div>
  );
}
