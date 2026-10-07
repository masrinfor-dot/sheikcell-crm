import { eq } from "drizzle-orm";
import { db, tenantErpIntegrationsTable } from "@workspace/db";
import { decryptErpSecret } from "./erpCrypto";
import { erpFetch } from "./erpOsMessages";
import { logger } from "./logger";

// Situação da OS pelo robô (07/10/2026 — pedido do Samuel: o cliente pergunta
// "meu celular como que tá?" e o robô respondia só "vou encaminhar"). O robô
// consulta o ERP Prumo (GET /integrations/service-orders/status) com o número
// do WhatsApp de quem escreveu: o ERP só devolve OS de cliente com esse
// celular, então ninguém consulta a OS dos outros. Sem OS, sem integração ou
// com o ERP fora do ar, o robô segue o fluxo de sempre (atendente humano).

/** Tempo máximo esperando o ERP antes de seguir o fluxo normal. */
export const OS_STATUS_TIMEOUT_MS = 8_000;

export interface ErpOsStatusItem {
  number: string | null;
  store: { name: string; phone: string | null };
  equipment: { type: string | null; typeLabel: string; brand: string | null; model: string | null; description: string };
  status: string;
  statusLabel: string;
  message: string;
  forecast: { at: string | null; text: string; dependsOnPart: boolean } | null;
  readyForPickup: boolean;
  total: number | null;
  amountDue: number | null;
  technicianFirstName: string | null;
  openedAt: string;
  lastUpdate: string;
}

export interface ErpOsStatusAnswer {
  found: boolean;
  orders: ErpOsStatusItem[];
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Número da OS do Prumo: {sigla da loja}-{ano}-{sequencial} (ex.: LJ01-2026-000004).
const OS_NUMBER = /\b([a-z]{1,8}\d{0,4})\s*-\s*(20\d{2})\s*-\s*(\d{1,8})\b/i;

const MENTIONS_OS = /\b(minha|da|na|sobre a|a|numero da|n[ou]mero da) (os|o\.s\.?)\b|\bordem de servico\b/;
const READY_QUESTION = /\b(ja )?(ficou|fica|esta|ta|estaria|tah) pront[oa]\b/;
const MY_DEVICE = /\b(meu|minha|o|a) (celular|aparelho|telefone|fone|iphone|smartphone|tablet|ipad|notebook|relogio|conserto|reparo|manutencao)\b/;
const STATUS_WORDS = /(como (que )?(ta|tah|esta|anda|ficou|vai)|andamento|situacao|status|previsao|novidade|noticia|quando (fica|vai ficar|ficara|posso (buscar|pegar|retirar)|vou poder)|ja (deu|ficou|consertou|terminou|arrumou)|pront[oa]\b|consertad[oa]|arrumad[oa])/;

/**
 * A mensagem pergunta da situação de uma OS/conserto? Devolve o número da OS
 * quando o cliente escreveu um (normalizado em maiúsculas), ou null quando é
 * uma pergunta genérica ("meu celular já ficou pronto?"). `undefined` = não é
 * pergunta de situação (o robô segue o fluxo de sempre). Puro (testável).
 */
export function detectOsStatusQuestion(text: string): { number: string | null } | undefined {
  if (!text || !text.trim()) return undefined;
  const m = text.match(OS_NUMBER);
  if (m) return { number: `${m[1]}-${m[2]}-${m[3]}`.toUpperCase() };
  const t = norm(text);
  if (MENTIONS_OS.test(t)) return { number: null };
  if (READY_QUESTION.test(t) && MY_DEVICE.test(t)) return { number: null };
  if (MY_DEVICE.test(t) && STATUS_WORDS.test(t)) return { number: null };
  return undefined;
}

const BRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function pickupLine(o: ErpOsStatusItem): string | null {
  if (!o.readyForPickup) return null;
  if (o.amountDue != null && o.amountDue > 0) return `✅ Pode retirar na loja! Valor a pagar na retirada: *${BRL(o.amountDue)}*`;
  if (o.amountDue === 0 && (o.total ?? 0) > 0) return "✅ Pode retirar na loja! O valor já está pago.";
  return "✅ Pode retirar na loja!";
}

/** Resposta de UMA OS para o cliente. Puro (testável). */
export function formatSingleOs(o: ErpOsStatusItem): string {
  const lines = [
    `Encontrei a sua OS *${o.number ?? "(sem número)"}* — ${o.equipment.description}, na loja ${o.store.name}.`,
    `📌 Situação: *${o.statusLabel}*. ${o.message}`,
  ];
  if (o.forecast) {
    lines.push(o.forecast.dependsOnPart
      ? "🗓️ Previsão de entrega: depende da chegada da peça (avisamos assim que chegar)."
      : `🗓️ Previsão de entrega: ${o.forecast.text}.`);
  }
  const pickup = pickupLine(o);
  if (pickup) lines.push(pickup);
  if (o.store.phone) lines.push(`📞 Telefone da loja: ${o.store.phone}`);
  lines.push("Se precisar de mais alguma coisa, é só escrever aqui.");
  return lines.join("\n");
}

/** Resposta de VÁRIAS OS em aberto. Puro (testável). */
export function formatManyOs(orders: ErpOsStatusItem[]): string {
  const lines = [`Encontrei ${orders.length} ordens de serviço em aberto no seu número:`];
  for (const o of orders) {
    let extra = "";
    if (o.readyForPickup) extra = o.amountDue != null && o.amountDue > 0 ? ` ✅ pode retirar (a pagar ${BRL(o.amountDue)})` : " ✅ pode retirar";
    else if (o.forecast) extra = o.forecast.dependsOnPart ? " (depende da chegada da peça)" : ` (previsão ${o.forecast.text})`;
    lines.push(`• *${o.number ?? "(sem número)"}* — ${o.equipment.description} (${o.store.name}): *${o.statusLabel}*${extra}`);
  }
  lines.push("Quer os detalhes de alguma? É só mandar o número da OS.");
  return lines.join("\n");
}

/**
 * Texto para o cliente a partir da resposta do ERP. `askedNumber` é o número
 * que o cliente escreveu (se escreveu) e que NÃO foi achado no número dele —
 * aí avisa antes de listar as que existem. null = nada para responder.
 */
export function formatOsStatusReply(answer: ErpOsStatusAnswer, askedNumber?: string | null): string | null {
  if (!answer.found || answer.orders.length === 0) return null;
  const body = answer.orders.length === 1 ? formatSingleOs(answer.orders[0]!) : formatManyOs(answer.orders);
  return askedNumber ? `Não encontrei a OS ${askedNumber} no seu número de WhatsApp. ${body}` : body;
}

export type OsStatusLookup =
  | { kind: "not_configured" }
  | { kind: "unavailable"; error: string }
  | { kind: "ok"; answer: ErpOsStatusAnswer; askedNumberMissing: string | null };

/**
 * Consulta o ERP da loja (tenant) pela situação das OS do cliente. Nunca
 * lança: integração ausente/chave ilegível/ERP fora do ar/timeout viram
 * `not_configured`/`unavailable` e o robô segue o fluxo de sempre.
 * Número informado e não achado no celular do cliente → tenta as OS em
 * aberto do mesmo celular (continua só dele).
 */
export async function lookupOsStatus(tenantId: number, phone: string, number: string | null): Promise<OsStatusLookup> {
  try {
    const [row] = await db.select().from(tenantErpIntegrationsTable).where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
    if (!row) return { kind: "not_configured" };
    const apiKey = decryptErpSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
    const ask = async (n: string | null) => {
      const qs = new URLSearchParams({ phone });
      if (n) qs.set("number", n);
      return (await erpFetch(row.baseUrl, apiKey, `/integrations/service-orders/status?${qs.toString()}`, undefined, OS_STATUS_TIMEOUT_MS)) as ErpOsStatusAnswer;
    };
    const first = await ask(number);
    if (first.found || !number) return { kind: "ok", answer: first, askedNumberMissing: null };
    const open = await ask(null);
    return { kind: "ok", answer: open, askedNumberMissing: open.found ? number : null };
  } catch (err) {
    logger.warn({ err, tenantId }, "Robô: não deu para consultar a situação da OS no ERP");
    return { kind: "unavailable", error: String(err).slice(0, 200) };
  }
}

/** A loja tem a integração com o ERP cadastrada? (para oferecer a ferramenta à IA) */
export async function hasErpIntegration(tenantId: number): Promise<boolean> {
  try {
    const [row] = await db.select({ tenantId: tenantErpIntegrationsTable.tenantId }).from(tenantErpIntegrationsTable)
      .where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
    return !!row;
  } catch {
    return false;
  }
}
