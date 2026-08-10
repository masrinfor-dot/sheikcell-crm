import { useState } from "react";
import { Link } from "wouter";
import { api, ApiError } from "@/lib/api";
import { Smartphone, Mail, AlertCircle, CheckCircle2, ArrowLeft } from "lucide-react";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.auth.forgotPassword(email);
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Erro ao solicitar redefinição");
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
          <p className="text-muted-foreground text-sm mt-1">Recuperar senha</p>
        </div>

        <div className="shk-card p-6">
          {sent ? (
            <div className="text-center py-2">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
              <h2 className="text-lg font-bold mb-2 text-foreground">Verifique seu e-mail</h2>
              <p className="text-sm text-muted-foreground">
                Se o e-mail informado estiver cadastrado, você vai receber um link
                para redefinir sua senha. O link expira em 30 minutos.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-bold mb-1.5 text-foreground">Esqueceu a senha?</h2>
              <p className="text-sm text-muted-foreground mb-5">
                Informe o e-mail cadastrado e enviaremos um link para você criar uma nova senha.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="seu@sheikcell.com"
                      required
                      data-testid="input-forgot-email"
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
                  data-testid="button-send-reset-link"
                  className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition disabled:opacity-60"
                >
                  {loading ? "Enviando..." : "Enviar link de redefinição"}
                </button>
              </form>
            </>
          )}

          <Link
            href="/login"
            data-testid="link-back-to-login"
            className="mt-4 flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Voltar para o login
          </Link>
        </div>
      </div>
    </div>
  );
}
