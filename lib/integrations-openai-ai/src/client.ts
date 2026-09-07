import OpenAI from "openai";

// Supports either a user-provided key (OPENAI_API_KEY, using the default
// OpenAI API) or the Replit AI Integrations proxy (AI_INTEGRATIONS_*).
const apiKey = (
  process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY
)?.trim();

if (!apiKey) {
  throw new Error(
    "OPENAI_API_KEY must be set. Add your OpenAI API key to enable AI features.",
  );
}

const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

export const openai = new OpenAI({
  apiKey,
  ...(baseURL ? { baseURL } : {}),
  // SDK default é 10 min sem timeout configurado — uma chave inválida/rede
  // fora do ar deixa a chamada pendurada por muito tempo (ex.: preço base
  // da Avaliação de Usados nunca resolve e a etapa seguinte não abre).
  // 25s é generoso pro modelo com busca na web, mas falha rápido o
  // suficiente pra quem chamou poder cair no fallback/erro tratado.
  timeout: 25_000,
  // Antes era 1 — muito pouco pra picos passageiros de "rate_limit_exceeded"
  // (várias lojas/módulos usando IA ao mesmo tempo nessa mesma chave
  // compartilhada da plataforma): o SDK já espera o tempo do header
  // "Retry-After" entre tentativas, então mais tentativas só ajudam a
  // atravessar o pico sem precisar que o lojista clique "tentar de novo".
  maxRetries: 3,
});
