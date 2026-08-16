import { useState, useEffect } from "react";
import { api, type AiCredentialsStatus } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Plug, KeyRound, Trash2, CheckCircle2 } from "lucide-react";

// Chave da OpenAI própria da loja: quando configurada e ligada, substitui a
// chave global da plataforma em todos os recursos de IA (robô, sugestão de
// resposta, correção de texto, transcrição, avaliação de usados). Sem
// chave própria (ou desligada), continua usando a chave global — ninguém
// perde o recurso só por não ter configurado ainda.
export default function ConfiguracoesIntegracoes() {
  const { toast } = useToast();
  const [status, setStatus] = useState<AiCredentialsStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = () => { api.settings.ai.get().then(setStatus).catch(() => {}); };
  useEffect(load, []);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const s = await api.settings.ai.save({ apiKey: apiKey.trim() });
      setStatus(s);
      setApiKey("");
      toast({ title: "Chave da OpenAI salva!", description: "A partir de agora, os recursos de IA desta loja usam essa chave." });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleToggle = async (useOwnKey: boolean) => {
    try {
      setStatus(await api.settings.ai.save({ useOwnKey }));
    } catch (err) {
      toast({ title: "Erro ao atualizar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    }
  };

  const handleRemove = async () => {
    if (!confirm("Remover a chave da OpenAI desta loja? Os recursos de IA voltam a usar a chave da plataforma.")) return;
    setRemoving(true);
    try {
      setStatus(await api.settings.ai.remove());
      toast({ title: "Chave removida" });
    } catch (err) {
      toast({ title: "Erro ao remover", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setRemoving(false); }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="font-bold text-foreground flex items-center gap-2"><Plug className="w-5 h-5" /> Integrações</h2>
        <p className="text-xs text-muted-foreground mt-1">Conecte a própria conta OpenAI pra esta loja usar a sua chave em vez da chave da plataforma.</p>
      </div>

      <div className="shk-card p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-primary" />
          <h3 className="font-bold text-sm text-foreground">Chave da OpenAI</h3>
        </div>

        {status?.hasKey && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2" data-testid="ai-key-status">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-emerald-800 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Chave configurada: <span className="font-mono font-semibold">sk-...{status.last4}</span>
              </p>
              <button onClick={handleRemove} disabled={removing} data-testid="button-remove-ai-key"
                className="text-[11px] font-semibold text-red-600 hover:underline shrink-0 flex items-center gap-1 disabled:opacity-50">
                <Trash2 className="w-3 h-3" /> Remover
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs font-medium text-emerald-900">
              <input type="checkbox" checked={status.useOwnKey} data-testid="checkbox-use-own-key"
                onChange={(e) => handleToggle(e.target.checked)} />
              Usar esta chave (desmarque pra voltar a usar a chave da plataforma temporariamente)
            </label>
          </div>
        )}

        <div>
          <label className="text-xs font-medium mb-1 block">{status?.hasKey ? "Trocar chave" : "Colar chave"}</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..." data-testid="input-ai-api-key" autoComplete="off"
            className="w-full px-3 py-2 rounded-xl border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
          <p className="text-[10px] text-muted-foreground mt-1">
            Crie uma chave em <span className="font-mono">platform.openai.com/api-keys</span>. Depois de salva, a chave nunca é exibida de novo — só os últimos 4 caracteres, pra você conferir qual está em uso.
          </p>
        </div>

        <div className="flex justify-end">
          <button type="button" onClick={handleSave} disabled={saving || !apiKey.trim()} data-testid="button-save-ai-key"
            className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
            {saving ? "Salvando..." : "Salvar chave"}
          </button>
        </div>
      </div>
    </div>
  );
}
