// Contratos comuns dos adapters de banco/gateway (BankIntegrationAdapter) e de
// credenciadora/maquininha (AcquirerAdapter). Todo provedor novo implementa uma
// ou ambas as interfaces — a camada de rotas/scheduler/conciliação nunca conhece
// detalhes de um banco específico, só fala com esse contrato (Adapter Pattern).

import type { BankAccount, BankIntegrationCredential } from "@workspace/db";

// Credencial já decifrada (ver lib/crypto.ts), pronta para uso pelo adapter.
// O adapter nunca vê o payload criptografado nem toca em lib/crypto.ts diretamente.
export type DecryptedCredential = {
  authType: BankIntegrationCredential["authType"];
  secret: string; // token/API key, ou refresh token no caso de OAuth
};

// Abstração mínima sobre fetch — permite injetar um mock com respostas fixas
// (fixtures) nos testes, sem nenhuma chamada de rede real.
export interface HttpClient {
  request(input: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH";
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; json: unknown }>;
}

export class NotImplementedError extends Error {
  constructor(provider: string) {
    super(`${provider} não configurado — integração ainda não implementada`);
    this.name = "NotImplementedError";
  }
}

// Uma transação normalizada, no formato comum independente do banco de origem.
export type NormalizedTransaction = {
  externalId: string;
  postedAt: Date;
  amountCents: number; // assinado
  type: "credit" | "debit";
  description: string | null;
  counterpartyDoc: string | null;
  rawPayload: unknown;
};

// Uma venda de cartão normalizada, vinda de uma credenciadora/maquininha.
export type NormalizedSale = {
  externalSaleId: string;
  soldAt: Date;
  grossAmountCents: number;
  feeAmountCents: number;
  netAmountCents: number;
  installments: number;
  cardBrand: string | null;
  paymentMethod: "credito" | "debito" | "pix";
  authorizationCode: string | null;
  nsu: string | null;
  rawPayload: unknown;
};

// Um repasse normalizado (a credenciadora consolidou N vendas num crédito só).
export type NormalizedRepasse = {
  externalRepasseId: string;
  settledAt: Date;
  amountCents: number;
  rawPayload: unknown;
};

export type WebhookVerification =
  | { valid: true }
  | { valid: false; reason: string };

// Formato único de retorno de parseWebhookPayload nas duas interfaces —
// necessário porque um adapter (PagBank) implementa as duas ao mesmo tempo;
// se cada interface declarasse um formato próprio, o TypeScript "perde" campos
// ao computar a interseção dos dois métodos (a chamada resolve só a última
// assinatura). Um adapter só-banco devolve sales/repasses vazios, e vice-versa.
export type ParsedWebhookPayload = {
  externalAccountId: string;
  transactions: NormalizedTransaction[];
  sales: NormalizedSale[];
  repasses: NormalizedRepasse[];
};

// Conta bancária/gateway (extrato + saldo). PagBank implementa esta interface
// E AcquirerAdapter ao mesmo tempo (é banco e maquininha simultaneamente).
export interface BankIntegrationAdapter {
  readonly provider: string;
  fetchBalance(account: BankAccount, credential: DecryptedCredential, http: HttpClient): Promise<{ balanceCents: number; asOf: Date }>;
  fetchTransactions(account: BankAccount, credential: DecryptedCredential, http: HttpClient, since: Date, until: Date): Promise<NormalizedTransaction[]>;
  verifyWebhookSignature(headers: Record<string, string>, rawBody: Buffer): WebhookVerification;
  parseWebhookPayload(rawBody: Buffer): ParsedWebhookPayload;
}

// Credenciadora/maquininha de cartão (vendas + repasses).
export interface AcquirerAdapter {
  readonly provider: string;
  fetchSales(account: BankAccount, credential: DecryptedCredential, http: HttpClient, since: Date, until: Date): Promise<NormalizedSale[]>;
  fetchRepasses(account: BankAccount, credential: DecryptedCredential, http: HttpClient, since: Date, until: Date): Promise<NormalizedRepasse[]>;
  verifyWebhookSignature(headers: Record<string, string>, rawBody: Buffer): WebhookVerification;
  parseWebhookPayload(rawBody: Buffer): ParsedWebhookPayload;
}
