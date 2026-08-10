// Fluxo OAuth ("Conectar") do Financeiro Bancário — só PagBank e Mercado
// Pago oferecem esse tipo de conexão (login no banco, autoriza, volta
// conectado). Os outros bancos exigem certificado digital (ver rota
// POST /finance-bank/accounts/:id/certificate) ou token colado manualmente.

export type OAuthProvider = "pagbank" | "mercado_pago";

export function isOAuthProvider(provider: string): provider is OAuthProvider {
  return provider === "pagbank" || provider === "mercado_pago";
}

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  raw: Record<string, unknown>;
};

type ProviderEnv = "sandbox" | "production";

function envMode(varName: string): ProviderEnv {
  return process.env[varName] === "production" ? "production" : "sandbox";
}

function requireEnv(varName: string): string {
  const v = process.env[varName];
  if (!v) throw new Error(`${varName} não configurada — conexão OAuth desabilitada para este provedor.`);
  return v;
}

// ── Mercado Pago ────────────────────────────────────────────────────────────
// Doc oficial: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/additional-content/security/oauth
// URLs iguais em sandbox/produção (o ambiente é definido pelas credenciais,
// não pela URL) — env var mantida só por simetria/uso futuro.
const MERCADOPAGO_AUTHORIZE_URL = "https://auth.mercadopago.com/authorization";
const MERCADOPAGO_TOKEN_URL = "https://api.mercadopago.com/oauth/token";

// ── PagBank/PagSeguro Connect ───────────────────────────────────────────────
// Doc oficial: https://developer.pagbank.com.br/docs/connect +
// https://developer.pagbank.com.br/reference/obter-access-token
// ⚠️ A URL de PRODUÇÃO do token exchange foi inferida por convenção de nome
// a partir da URL de sandbox (confirmada na doc) — confirme antes de usar
// com credenciais reais de produção. Sandbox está 100% confirmada.
const PAGBANK_URLS: Record<ProviderEnv, { authorize: string; token: string }> = {
  sandbox: { authorize: "https://connect.sandbox.pagbank.com.br/oauth2/authorize", token: "https://sandbox.api.pagseguro.com/oauth2/token" },
  production: { authorize: "https://connect.pagbank.com.br/oauth2/authorize", token: "https://api.pagseguro.com/oauth2/token" },
};

export function authorizeUrl(provider: OAuthProvider, redirectUri: string, state: string): string {
  if (provider === "mercado_pago") {
    const clientId = requireEnv("MERCADOPAGO_CLIENT_ID");
    const qs = new URLSearchParams({
      client_id: clientId, response_type: "code", platform_id: "mp",
      state, redirect_uri: redirectUri,
    });
    return `${MERCADOPAGO_AUTHORIZE_URL}?${qs.toString()}`;
  }
  const clientId = requireEnv("PAGBANK_CLIENT_ID");
  const env = envMode("PAGBANK_ENV");
  const qs = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, state,
    scope: "connect.payments.read connect.payments.write",
  });
  return `${PAGBANK_URLS[env].authorize}?${qs.toString()}`;
}

export async function exchangeCode(provider: OAuthProvider, code: string, redirectUri: string): Promise<TokenResponse> {
  if (provider === "mercado_pago") {
    const clientId = requireEnv("MERCADOPAGO_CLIENT_ID");
    const clientSecret = requireEnv("MERCADOPAGO_CLIENT_SECRET");
    const res = await fetch(MERCADOPAGO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Mercado Pago recusou a troca de código: ${JSON.stringify(body)}`);
    return {
      accessToken: String(body["access_token"]),
      refreshToken: body["refresh_token"] ? String(body["refresh_token"]) : null,
      expiresInSeconds: typeof body["expires_in"] === "number" ? body["expires_in"] : null,
      raw: body,
    };
  }

  const clientId = requireEnv("PAGBANK_CLIENT_ID");
  const clientSecret = requireEnv("PAGBANK_CLIENT_SECRET");
  const env = envMode("PAGBANK_ENV");
  const res = await fetch(PAGBANK_URLS[env].token, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X_CLIENT_ID": clientId, "X_CLIENT_SECRET": clientSecret },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(`PagBank recusou a troca de código: ${JSON.stringify(body)}`);
  return {
    accessToken: String(body["access_token"]),
    refreshToken: body["refresh_token"] ? String(body["refresh_token"]) : null,
    expiresInSeconds: typeof body["expires_in"] === "number" ? body["expires_in"] : null,
    raw: body,
  };
}
