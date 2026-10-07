import { useEffect, useState } from "react";
import { api, type InstagramIntegrationStatus, type Sector } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Instagram, Trash2, CheckCircle2, AlertTriangle, Copy } from "lucide-react";

// Instagram Direct (07/10/2026): as mensagens do Direct da conta profissional
// da loja entram no Atendimento como conversas (canal "instagram") e as
// respostas do vendedor voltam pelo Direct. Token e chave secreta do app são
// colados aqui (nunca mandados por chat) e ficam criptografados no banco.
export default function InstagramIntegrationCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<InstagramIntegrationStatus | null>(null);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings.instagram.get().then(setStatus).catch(() => {});
    api.sectors.list().then((s) => setSectors(s.filter((x) => x.isActive !== false))).catch(() => {});
  }, []);

  const run = async (fn: () => Promise<InstagramIntegrationStatus | void>, ok?: string) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) setStatus(s);
      if (ok) toast({ title: ok });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    const s = await api.settings.instagram.save({
      ...(token.trim() ? { accessToken: token.trim() } : {}),
      ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
    });
    setToken(""); setAppSecret("");
    return s;
  }, "Instagram salvo! Agora clique em Testar conexão.");

  const test = () => run(async () => {
    const r = await api.settings.instagram.test();
    toast({
      title: `Conectado: @${r.username ?? r.igUserId}`,
      description: r.webhookSubscribed ? "Conta inscrita para receber mensagens." : `Conta ok, mas a inscrição do webhook falhou: ${r.webhookError}`,
      variant: r.webhookSubscribed ? "default" : "destructive",
    });
    return api.settings.instagram.get();
  });

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast({ title: "Copiado!" }));
  };

  const connected = !!status?.igUserId;

  return (
    <div className="shk-card p-5 space-y-4" data-testid="instagram-integration-card">
      <div className="flex items-center gap-2">
        <Instagram className="w-4 h-4 text-pink-600" />
        <h3 className="font-bold text-sm text-foreground">Instagram Direct</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        As mensagens do Direct da conta profissional da loja entram no Atendimento como conversas, e a resposta do vendedor volta pelo Direct.
        Pelo Instagram, só dá pra responder até 24h depois da última mensagem do cliente.
      </p>

      {status?.configured && (
        <div className={`rounded-xl border p-3 space-y-2 text-xs ${connected ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {connected ? <>Conta: <span className="font-semibold">@{status.username ?? status.igUserId}</span></> : "Token salvo — falta testar a conexão"}
              {status.tokenLast4 && <span className="font-mono opacity-70">(…{status.tokenLast4})</span>}
            </span>
            <button onClick={() => run(() => api.settings.instagram.remove(), "Instagram desconectado")} disabled={busy}
              className="text-[11px] font-semibold text-red-600 hover:underline flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3 h-3" /> Remover
            </button>
          </div>

          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={status.enabled} disabled={busy} data-testid="checkbox-instagram-enabled"
              onChange={(e) => run(() => api.settings.instagram.save({ enabled: e.target.checked }), e.target.checked ? "Instagram ligado no Atendimento" : "Instagram desligado")} />
            Receber e responder o Direct no Atendimento
          </label>

          <div>
            <label className="text-[11px] font-medium block mb-0.5">Setor que recebe as conversas</label>
            <select value={status.sectorId ?? ""} disabled={busy} data-testid="select-instagram-sector"
              onChange={(e) => run(() => api.settings.instagram.save({ sectorId: e.target.value ? Number(e.target.value) : null }), "Setor salvo")}
              className="w-full px-2 py-1.5 rounded-lg border border-border bg-white text-xs text-foreground">
              <option value="">Primeiro setor ativo</option>
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <p className="text-[11px]">
            {status.lastWebhookAt ? `Última mensagem recebida: ${new Date(status.lastWebhookAt).toLocaleString("pt-BR")}` : "Nenhuma mensagem recebida ainda."}
            {status.tokenExpiresAt && <> · Token renova sozinho (vence {new Date(status.tokenExpiresAt).toLocaleDateString("pt-BR")})</>}
          </p>
          {!status.hasAppSecret && (
            <p className="text-[11px] text-amber-800 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> Falta a chave secreta do app — sem ela as mensagens recebidas são recusadas.</p>
          )}
          {status.lastError && (
            <p className="text-[11px] text-red-700 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {status.lastError}</p>
          )}
        </div>
      )}

      {status?.verifyToken && (
        <div className="rounded-xl border border-border p-3 space-y-2 text-xs">
          <p className="font-semibold">Cole no painel da Meta (app › Instagram › Webhooks):</p>
          {[["URL de retorno", status.webhookUrl], ["Verificar token", status.verifyToken]].map(([label, value]) => (
            <div key={label}>
              <span className="text-[11px] text-muted-foreground">{label}</span>
              <div className="flex items-center gap-1">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">{value}</code>
                <button type="button" onClick={() => copy(value!)} className="p-1 rounded hover:bg-muted" title="Copiar"><Copy className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">Marque o campo <b>messages</b> na lista de assinaturas.</p>
        </div>
      )}

      <div>
        <label className="text-xs font-medium mb-1 block">{status?.configured ? "Trocar token de acesso" : "Token de acesso do Instagram"}</label>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="IGAA..." autoComplete="off" data-testid="input-instagram-token"
          className="w-full px-3 py-2 rounded-xl border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <p className="text-[10px] text-muted-foreground mt-1">No app da Meta: Instagram › Configuração da API com login do Instagram › Gerar token.</p>
      </div>
      <div>
        <label className="text-xs font-medium mb-1 block">{status?.hasAppSecret ? "Trocar chave secreta do app" : "Chave secreta do app"}</label>
        <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="32 caracteres" autoComplete="off" data-testid="input-instagram-app-secret"
          className="w-full px-3 py-2 rounded-xl border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <p className="text-[10px] text-muted-foreground mt-1">Na mesma tela do token: "Chave secreta do app do Instagram". Depois de salvos, nenhum dos dois aparece de novo.</p>
      </div>
      <div className="flex justify-end gap-2">
        {status?.configured && (
          <button type="button" onClick={test} disabled={busy} data-testid="button-test-instagram"
            className="px-4 py-2 rounded-xl border border-border text-sm font-semibold hover:bg-muted transition disabled:opacity-50">
            Testar conexão
          </button>
        )}
        <button type="button" onClick={save} disabled={busy || (!token.trim() && !appSecret.trim())} data-testid="button-save-instagram"
          className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
          {busy ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </div>
  );
}
