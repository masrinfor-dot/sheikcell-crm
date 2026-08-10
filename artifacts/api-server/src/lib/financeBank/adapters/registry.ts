// Registry central: "qual adapter atende o provider X" — rotas e o job de
// polling nunca importam um adapter concreto diretamente, sempre passam pelo
// registry. Adicionar um banco novo = escrever 1 arquivo de adapter e registrar
// aqui, sem tocar em rotas/scheduler/conciliação.

import { NotImplementedError, type AcquirerAdapter, type BankIntegrationAdapter } from "./types.ts";
import { pagBankAdapter } from "./pagbank.ts";

export const ALL_PROVIDERS = [
  "pagbank", "inter", "itau", "asaas", "mercado_pago",
  "cappta", "rede", "bradesco", "nubank", "sicoob", "sicredi",
] as const;
export type Provider = (typeof ALL_PROVIDERS)[number];

// Provedores que hoje só existem como conta bancária, só como credenciadora,
// ou como ambos (PagBank) — usado pelo /providers da API para a UI saber que
// tipo de cadastro oferecer para cada um.
export const BANK_PROVIDERS: Provider[] = ["pagbank", "inter", "itau", "asaas", "mercado_pago", "bradesco", "nubank", "sicoob", "sicredi"];
export const ACQUIRER_PROVIDERS: Provider[] = ["pagbank", "cappta", "rede"];

// "async" nos métodos que lançam é proposital: sem isso, o throw seria
// síncrono em vez de virar uma Promise rejeitada, quebrando o contrato das
// interfaces (todo chamador espera poder dar `await`/`.catch` nesses métodos).
function makeStubBankAdapter(provider: Provider): BankIntegrationAdapter {
  return {
    provider,
    async fetchBalance() { throw new NotImplementedError(provider); },
    async fetchTransactions() { throw new NotImplementedError(provider); },
    verifyWebhookSignature() { return { valid: false, reason: `${provider} não configurado` }; },
    parseWebhookPayload() { throw new NotImplementedError(provider); },
  };
}

function makeStubAcquirerAdapter(provider: Provider): AcquirerAdapter {
  return {
    provider,
    async fetchSales() { throw new NotImplementedError(provider); },
    async fetchRepasses() { throw new NotImplementedError(provider); },
    verifyWebhookSignature() { return { valid: false, reason: `${provider} não configurado` }; },
    parseWebhookPayload() { throw new NotImplementedError(provider); },
  };
}

const bankAdapters = new Map<Provider, BankIntegrationAdapter>(
  BANK_PROVIDERS.map((p) => [p, p === "pagbank" ? pagBankAdapter : makeStubBankAdapter(p)]),
);
const acquirerAdapters = new Map<Provider, AcquirerAdapter>(
  ACQUIRER_PROVIDERS.map((p) => [p, p === "pagbank" ? pagBankAdapter : makeStubAcquirerAdapter(p)]),
);

export function getBankAdapter(provider: string): BankIntegrationAdapter | null {
  return bankAdapters.get(provider as Provider) ?? null;
}

export function getAcquirerAdapter(provider: string): AcquirerAdapter | null {
  return acquirerAdapters.get(provider as Provider) ?? null;
}

// Como cada provedor é conectado (levantamento com o usuário, ver plano):
// oauth = login no banco + autoriza, sem ver a chave (só PagBank/Mercado Pago
// oferecem isso de verdade); certificate = client_id/secret + certificado
// digital gerado pelo próprio titular (bancos tradicionais via Open
// Finance/API própria); api_key = token colado manualmente (o que já existia).
const AUTH_METHOD: Record<Provider, "oauth" | "certificate" | "api_key"> = {
  pagbank: "oauth", mercado_pago: "oauth",
  inter: "certificate", itau: "certificate", bradesco: "certificate", sicoob: "certificate", sicredi: "certificate",
  asaas: "api_key", cappta: "api_key", rede: "api_key", nubank: "api_key",
};

// Avisos exibidos na tela quando não há confirmação de API pública de
// terceiros pra aquele provedor — o campo manual continua disponível (pode
// haver algum outro token/canal), só deixa claro que não é uma conexão
// automática confirmada.
const PROVIDER_NOTE: Partial<Record<Provider, string>> = {
  nubank: "O Nubank não oferece API própria para conexão de terceiros — só via Open Finance regulado ou um agregador (ex.: Pluggy). Sem isso, não há conexão automática confirmada.",
  cappta: "Não encontramos confirmação pública de conexão automática para a Cappta — vale confirmar direto com o suporte deles antes de depender desse token.",
};

// Para a tela de cadastro de contas: lista todos os provedores conhecidos, se
// já têm integração real implementada (hoje só o PagBank) ou ainda são stub,
// e como se conecta (oauth/certificate/api_key) + aviso quando aplicável.
export function listProviders(): { provider: Provider; isBank: boolean; isAcquirer: boolean; configured: boolean; authMethod: "oauth" | "certificate" | "api_key"; note: string | null }[] {
  return ALL_PROVIDERS.map((provider) => ({
    provider,
    isBank: BANK_PROVIDERS.includes(provider),
    isAcquirer: ACQUIRER_PROVIDERS.includes(provider),
    configured: provider === "pagbank",
    authMethod: AUTH_METHOD[provider],
    note: PROVIDER_NOTE[provider] ?? null,
  }));
}
