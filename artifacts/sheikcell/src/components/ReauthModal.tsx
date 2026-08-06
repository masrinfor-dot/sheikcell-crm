import { useState } from "react";
import { ShieldCheck } from "lucide-react";

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

// Modal genérico de "confirme sua senha" para ações sensíveis (ver
// requireReauth no backend) — não é específico de nenhuma ação: quem chama
// passa `onConfirm`, que reenvia a MESMA requisição original com a senha
// preenchida. Se `onConfirm` rejeitar (senha errada), o erro aparece aqui
// dentro sem fechar o modal; se resolver, quem chama fecha o modal.
export default function ReauthModal({ title, onConfirm, onClose }: {
  title?: string;
  onConfirm: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setError("");
    setConfirming(true);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Senha incorreta");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-base flex items-center gap-2 mb-1">
          <ShieldCheck className="w-4 h-4 text-primary" /> {title ?? "Confirme sua senha"}
        </h3>
        <p className="text-[11px] text-muted-foreground mb-3">
          Essa é uma ação sensível — confirme sua senha para continuar.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs font-medium mb-1 block">Sua senha</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus
              data-testid="input-reauth-password" className={INPUT} />
          </div>
          {error && <p className="text-xs text-destructive font-medium">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
              Cancelar
            </button>
            <button type="submit" disabled={confirming || !password} data-testid="button-confirm-reauth"
              className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition">
              {confirming ? "Confirmando..." : "Confirmar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
