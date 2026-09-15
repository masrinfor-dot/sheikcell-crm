import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Smartphone, Lock, Mail, AlertCircle, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const { login, verifyTwoFactor } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Superadmin (Fase 1 - gaps): depois da senha, ainda precisa confirmar um
  // código de 6 dígitos mandado por e-mail — challenge fica em memória só,
  // nunca em localStorage (expira em 10min de qualquer jeito).
  const [challenge, setChallenge] = useState<{ id: number; maskedEmail: string } | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await login(email, password);
      if (r.twoFactorRequired) {
        setChallenge({ id: r.challengeId, maskedEmail: r.maskedEmail });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erro ao fazer login");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge || !code.trim()) return;
    setError("");
    setVerifying(true);
    try {
      await verifyTwoFactor(challenge.id, code.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Código inválido");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      {/* Background pattern */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-primary/5" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-accent/5" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary shadow-lg mb-4">
            <Smartphone className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold text-foreground tracking-tight">Sheikcell</h1>
          <p className="text-muted-foreground text-sm mt-1">Sistema de Atendimento</p>
        </div>

        {/* Login card */}
        <div className="shk-card p-6">
          {challenge ? (
            <>
              <h2 className="text-lg font-bold mb-1 text-foreground flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-primary" /> Código de acesso
              </h2>
              <p className="text-sm text-muted-foreground mb-5">
                Mandamos um código de 6 dígitos para <strong>{challenge.maskedEmail}</strong>. Ele vale por 10 minutos.
              </p>
              <form onSubmit={handleVerify} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Código</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    required
                    data-testid="input-2fa-code"
                    className="w-full px-4 py-2.5 rounded-xl border border-border bg-background text-center text-lg tracking-[0.3em] font-semibold focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-xl p-3">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={verifying || code.length < 6}
                  data-testid="button-verify-2fa"
                  className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition disabled:opacity-60"
                >
                  {verifying ? "Confirmando..." : "Confirmar"}
                </button>
                <button
                  type="button"
                  onClick={() => { setChallenge(null); setCode(""); setError(""); }}
                  data-testid="button-cancel-2fa"
                  className="w-full text-center text-xs text-muted-foreground hover:underline"
                >
                  Voltar
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-lg font-bold mb-5 text-foreground">Entrar</h2>

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
                      data-testid="input-email"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Senha</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      data-testid="input-password"
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
                  data-testid="button-login"
                  className="w-full py-2.5 rounded-xl bg-primary text-white font-semibold text-sm hover:bg-primary/90 transition disabled:opacity-60"
                >
                  {loading ? "Entrando..." : "Entrar"}
                </button>
              </form>
              <p className="mt-3 text-center text-[11px] text-muted-foreground">
                <Link href="/forgot-password" data-testid="link-forgot-password" className="text-primary font-semibold hover:underline">
                  Esqueceu a senha?
                </Link>
              </p>
            </>
          )}
        </div>

        {/* Dev-only credential hints */}
        {import.meta.env.DEV && (
          <div className="mt-4 text-center text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-xl p-2">
            <p className="font-semibold text-amber-700 mb-0.5">Ambiente de desenvolvimento</p>
            <p>Admin: admin@sheikcell.com / admin123</p>
          </div>
        )}
      </div>
    </div>
  );
}
