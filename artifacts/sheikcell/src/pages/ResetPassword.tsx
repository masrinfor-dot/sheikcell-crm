import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { api, ApiError } from "@/lib/api";
import { Smartphone, Lock, AlertCircle, CheckCircle2 } from "lucide-react";

export default function ResetPassword() {
  const { token } = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmNewPassword) {
      setError("As senhas não coincidem");
      return;
    }
    setLoading(true);
    try {
      await api.auth.resetPassword(token, newPassword, confirmNewPassword);
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Erro ao redefinir senha");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-primary/5" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-accent/5" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary shadow-lg mb-4">
            <Smartphone className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold text-foreground tracking-tight">Sheikcell</h1>
          <p className="text-muted-foreground text-sm mt-1">Criar nova senha</p>
        </div>

        <div className="shk-card p-6">
          {done ? (
            <div className="text-center py-2">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
              <h2 className="text-lg font-bold mb-2 text-foreground">Senha redefinida!</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Sua senha foi alterada com sucesso. Já pode entrar com a nova senha.
              </p>
              <button
                onClick={() => navigate("/login")}
                data-testid="button-go-to-login"
                className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition"
              >
                Ir para o login
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-bold mb-5 text-foreground">Nova senha</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Nova senha</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="mín. 6 caracteres"
                      required
                      minLength={6}
                      data-testid="input-new-password"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Confirme a nova senha</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="password"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      placeholder="repita a senha"
                      required
                      minLength={6}
                      data-testid="input-confirm-new-password"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                    />
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-xl p-3">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  data-testid="button-reset-password"
                  className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition disabled:opacity-60"
                >
                  {loading ? "Salvando..." : "Redefinir senha"}
                </button>
              </form>
            </>
          )}

          {!done && (
            <Link
              href="/login"
              data-testid="link-back-to-login"
              className="mt-4 block text-center text-sm text-muted-foreground hover:text-foreground transition"
            >
              Voltar para o login
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
