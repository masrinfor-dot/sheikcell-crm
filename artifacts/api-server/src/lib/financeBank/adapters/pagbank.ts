import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AcquirerAdapter, BankIntegrationAdapter, DecryptedCredential, HttpClient,
  NormalizedRepasse, NormalizedSale, NormalizedTransaction, WebhookVerification,
} from "./types.ts";
import type { BankAccount } from "@workspace/db";

// ⚠️ RISCO CONHECIDO (ver plano da Fase 1): os endpoints, o fluxo de
// autenticação (OAuth/Connect vs. token direto) e os nomes de campo abaixo
// foram desenhados a partir do formato geral conhecido das APIs públicas do
// PagSeguro/PagBank (conhecimento de treinamento), NÃO de uma consulta à
// documentação oficial atual. ANTES de usar isto contra a API real do PagBank:
//   1. Confirmar a URL base e o fluxo de auth atuais na documentação oficial.
//   2. Confirmar os nomes de campo de cada resposta (o mapeamento abaixo é a
//      melhor suposição, não um contrato confirmado).
//   3. Confirmar o mecanismo de assinatura de webhook real do PagBank
//      (assumido aqui como HMAC-SHA256 num header, no mesmo padrão já usado
//      pelo webhook do WhatsApp neste projeto — pode não ser assim de verdade).
// Até lá, este adapter só deve ser exercitado com um HttpClient mockado
// (fixtures) — é isso que permite testar conciliação/rotas/scheduler/UI
// inteiros sem nenhuma credencial real.
const BASE_URL = "https://api.pagseguro.com"; // TODO: confirmar na doc oficial antes de usar em produção

function mapTransaction(raw: Record<string, unknown>): NormalizedTransaction {
  const amountCents = Number(raw["amount"] ?? raw["value_cents"] ?? 0);
  return {
    externalId: String(raw["id"] ?? raw["reference_id"]),
    postedAt: new Date(String(raw["date"] ?? raw["created_at"])),
    amountCents,
    type: amountCents >= 0 ? "credit" : "debit",
    description: typeof raw["description"] === "string" ? raw["description"] : null,
    counterpartyDoc: typeof raw["payer_document"] === "string" ? raw["payer_document"] : null,
    rawPayload: raw,
  };
}

function mapSale(raw: Record<string, unknown>): NormalizedSale {
  const gross = Number(raw["amount"] ?? 0);
  const fee = Number(raw["fee_amount"] ?? 0);
  return {
    externalSaleId: String(raw["id"] ?? raw["charge_id"]),
    soldAt: new Date(String(raw["created_at"])),
    grossAmountCents: gross,
    feeAmountCents: fee,
    netAmountCents: gross - fee,
    installments: Number(raw["installments"] ?? 1),
    cardBrand: typeof raw["card_brand"] === "string" ? raw["card_brand"] : null,
    paymentMethod: raw["payment_method"] === "DEBIT_CARD" ? "debito" : raw["payment_method"] === "PIX" ? "pix" : "credito",
    authorizationCode: typeof raw["authorization_code"] === "string" ? raw["authorization_code"] : null,
    nsu: typeof raw["nsu"] === "string" ? raw["nsu"] : null,
    rawPayload: raw,
  };
}

function mapRepasse(raw: Record<string, unknown>): NormalizedRepasse {
  return {
    externalRepasseId: String(raw["id"] ?? raw["settlement_id"]),
    settledAt: new Date(String(raw["settlement_date"] ?? raw["date"])),
    amountCents: Number(raw["amount"] ?? 0),
    rawPayload: raw,
  };
}

function verifySignature(headers: Record<string, string>, rawBody: Buffer): WebhookVerification {
  const secret = process.env["PAGBANK_WEBHOOK_SECRET"];
  if (!secret) return { valid: false, reason: "PAGBANK_WEBHOOK_SECRET não configurado" };
  const signature = headers["x-pagbank-signature"] ?? headers["x-signature"];
  if (!signature) return { valid: false, reason: "assinatura ausente no header" };
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "assinatura inválida" };
  return { valid: true };
}

async function authHeaders(credential: DecryptedCredential): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${credential.secret}`, "Content-Type": "application/json" };
}

export const pagBankAdapter: BankIntegrationAdapter & AcquirerAdapter = {
  provider: "pagbank",

  async fetchBalance(_account: BankAccount, credential: DecryptedCredential, http: HttpClient) {
    const res = await http.request({ url: `${BASE_URL}/account/balance`, method: "GET", headers: await authHeaders(credential) });
    const body = res.json as Record<string, unknown>;
    return { balanceCents: Number(body["balance"] ?? 0), asOf: new Date() };
  },

  async fetchTransactions(_account: BankAccount, credential: DecryptedCredential, http: HttpClient, since: Date, until: Date) {
    const qs = new URLSearchParams({ from: since.toISOString(), to: until.toISOString() });
    const res = await http.request({ url: `${BASE_URL}/account/statement?${qs}`, method: "GET", headers: await authHeaders(credential) });
    const body = res.json as { items?: Record<string, unknown>[] };
    return (body.items ?? []).map(mapTransaction);
  },

  async fetchSales(_account: BankAccount, credential: DecryptedCredential, http: HttpClient, since: Date, until: Date) {
    const qs = new URLSearchParams({ from: since.toISOString(), to: until.toISOString() });
    const res = await http.request({ url: `${BASE_URL}/pos/sales?${qs}`, method: "GET", headers: await authHeaders(credential) });
    const body = res.json as { items?: Record<string, unknown>[] };
    return (body.items ?? []).map(mapSale);
  },

  async fetchRepasses(_account: BankAccount, credential: DecryptedCredential, http: HttpClient, since: Date, until: Date) {
    const qs = new URLSearchParams({ from: since.toISOString(), to: until.toISOString() });
    const res = await http.request({ url: `${BASE_URL}/pos/settlements?${qs}`, method: "GET", headers: await authHeaders(credential) });
    const body = res.json as { items?: Record<string, unknown>[] };
    return (body.items ?? []).map(mapRepasse);
  },

  verifyWebhookSignature(headers: Record<string, string>, rawBody: Buffer) {
    return verifySignature(headers, rawBody);
  },

  parseWebhookPayload(rawBody: Buffer) {
    const body = JSON.parse(rawBody.toString("utf8")) as {
      account_id?: string;
      transactions?: Record<string, unknown>[];
      sales?: Record<string, unknown>[];
      settlements?: Record<string, unknown>[];
    };
    return {
      externalAccountId: String(body.account_id ?? ""),
      transactions: (body.transactions ?? []).map(mapTransaction),
      sales: (body.sales ?? []).map(mapSale),
      repasses: (body.settlements ?? []).map(mapRepasse),
    };
  },
};

// Implementação padrão de HttpClient para uso real (poll job / rotas) — fetch
// nativo com timeout, no mesmo estilo já usado em outbound.ts/whatsappInbound.ts.
// Os testes injetam um mock em vez desta implementação.
export function createFetchHttpClient(): HttpClient {
  return {
    async request({ url, method, headers, body }) {
      const res = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
  };
}
