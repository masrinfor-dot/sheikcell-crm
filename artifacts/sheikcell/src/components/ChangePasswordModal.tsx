import { useState } from "react";
import { api } from "@/lib/api";
import { KeyRound } from "lucide-react";

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

// Modal de troca de senha. Com `forced`, não dá para fechar sem trocar
// (primeiro acesso ou senha resetada pelo admin).
export default function ChangePasswordModal({ forced, onDone, onClose }: {
  forced?: boolean;
  onDone: () => void;
  onClose?: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < 6) { setError("A nova senha precisa ter pelo menos 6 caracteres"); return; }
    if (next !== confirm) { setError("A confirmação não confere com a nova senha"); return; }
    setSaving(true);
    try {
      await api.auth.changePassword(current, next);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao trocar a senha");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5">
        <h3 className="font-bold text-base flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-primary" /> {forced ? "Crie sua nova senha" : "Trocar minha senha"}
        </h3>
        {forced && (
          <p className="text-[11px] text-muted-foreground mb-3">
            Por segurança, você precisa criar uma senha nova antes de continuar
            (a atual é a senha temporária que você recebeu).
          </p>
        )}
        <form onSubmit={submit} className="space-y-3 mt-2">
          <div>
            <label className="text-xs font-medium mb-1 block">{forced ? "Senha temporária (atual)" : "Senha atual"}</label>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required
              data-testid="input-current-password" className={INPUT} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Nova senha (mín. 6 caracteres)</label>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required
              data-testid="input-new-password" className={INPUT} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Repita a nova senha</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
              data-testid="input-confirm-password" className={INPUT} />
          </div>
          {error && <p className="text-xs text-destructive font-medium">{error}</p>}
          <div className="flex gap-2 pt-1">
            {!forced && onClose && (
              <button type="button" onClick={onClose}
                className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">Cancelar</button>
            )}
            <button type="submit" disabled={saving} data-testid="button-confirm-change-password"
              className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition">
              {saving ? "Salvando..." : "Salvar nova senha"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
