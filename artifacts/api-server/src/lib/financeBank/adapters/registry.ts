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

// Para a tela de cadastro de contas: lista todos os provedores conhecidos e se
// já têm integração real implementada (hoje só o PagBank) ou ainda são stub.
export function listProviders(): { provider: Provider; isBank: boolean; isAcquirer: boolean; configured: boolean }[] {
  return ALL_PROVIDERS.map((provider) => ({
    provider,
    isBank: BANK_PROVIDERS.includes(provider),
    isAcquirer: ACQUIRER_PROVIDERS.includes(provider),
    configured: provider === "pagbank",
  }));
}
