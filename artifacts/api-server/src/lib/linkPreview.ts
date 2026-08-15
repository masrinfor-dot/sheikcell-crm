import { lookup as dnsLookup } from "node:dns";
import * as cheerio from "cheerio";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import type { MessageMetadata } from "@workspace/db";
import { logger } from "./logger";

// Preview de link (OG tags) pra mensagens de texto — só disparado pra
// mensagens da própria equipe (atendente no Atendimento, qualquer um no Chat
// Interno), nunca pra mensagens recebidas de clientes no WhatsApp: aqui é
// "buscar uma URL que um usuário autenticado do tenant escolheu", ali seria
// "buscar qualquer URL que um número desconhecido no WhatsApp mandar", uma
// superfície de entrada bem mais arriscada.
//
// Proteção contra SSRF: a validação de IP roda dentro do próprio `lookup`
// usado pra abrir a conexão (via undici Agent + connect.lookup), não como um
// resolve-then-fetch separado — isso fecha a janela de DNS rebinding (onde o
// IP validado poderia não ser o mesmo usado na conexão real).

const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB — suficiente pro <head> de qualquer página normal
const MAX_REDIRECTS = 3;

function isBlockedAddress(address: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(address);
  } catch {
    return true; // não conseguiu parsear o IP resolvido -> bloqueia por segurança
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isBlockedAddress(v6.toIPv4Address().toString());
    }
  }
  // "unicast" é a única faixa pública de verdade; tudo mais (private,
  // loopback, linkLocal — inclui o metadata de cloud 169.254.169.254 —,
  // uniqueLocal, carrierGradeNat, multicast, reserved etc.) é bloqueado.
  return addr.range() !== "unicast";
}

// O undici usa Happy Eyeballs (RFC 8305) pra conectar e pede TODOS os
// endereços resolvidos de uma vez (options.all=true), esperando de volta um
// array de {address,family} — não um endereço só. Passar o formato errado
// pro callback quebra silenciosamente a conexão (net.js trata a string como
// se fosse um array). Por isso sempre resolvemos com all:true internamente e
// respondemos no formato que o chamador pediu, filtrando endereços bloqueados
// da lista em vez de só checar o primeiro.
function safeLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) { callback(err, options.all ? [] : "", 0); return; }
    const safe = (addresses as unknown as Array<{ address: string; family: number }>)
      .filter((a) => !isBlockedAddress(a.address));
    if (safe.length === 0) {
      callback(new Error(`Nenhum endereço público seguro para: ${hostname}`) as NodeJS.ErrnoException, options.all ? [] : "", 0);
      return;
    }
    if (options.all) { callback(null, safe); return; }
    callback(null, safe[0]!.address, safe[0]!.family);
  });
}

const safeAgent = new Agent({
  connect: { lookup: safeLookup as never, timeout: FETCH_TIMEOUT_MS },
});

// Limita a frequência de fetch por usuário — é um recurso best-effort
// (fire-and-forget depois de enviar mensagem), não precisa de fila/infra;
// só evita que uma conta comprometida use isso pra martelar hosts internos.
const lastFetchByUser = new Map<number, number>();
const MIN_INTERVAL_MS = 2_000;

function throttled(userId: number): boolean {
  const last = lastFetchByUser.get(userId) ?? 0;
  const now = Date.now();
  if (now - last < MIN_INTERVAL_MS) return true;
  lastFetchByUser.set(userId, now);
  return false;
}

async function readBounded(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseOgTags(html: string, pageUrl: string): NonNullable<MessageMetadata["linkPreview"]> | null {
  const $ = cheerio.load(html);
  const meta = (name: string): string | undefined =>
    $(`meta[property="${name}"]`).attr("content") || $(`meta[name="${name}"]`).attr("content") || undefined;

  const title = meta("og:title") || $("title").first().text().trim() || undefined;
  const description = meta("og:description") || meta("description") || undefined;
  const siteName = meta("og:site_name") || undefined;
  let image = meta("og:image");
  if (image) {
    try { image = new URL(image, pageUrl).toString(); } catch { image = undefined; }
  }

  if (!title && !description && !image) return null; // nada de útil pra mostrar
  return { url: pageUrl, title, description, image, siteName };
}

// O connect.lookup só entra em ação quando o host precisa ser RESOLVIDO —
// se a URL já traz um IP literal (ex.: "http://169.254.169.254/"), o
// net.connect() do Node conecta direto nele, sem nunca chamar nosso lookup
// customizado. Sem essa checagem à parte, um IP literal contornaria toda a
// proteção de SSRF de safeLookup().
function isBlockedHostnameLiteral(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (!ipaddr.isValid(bare)) return false; // não é um IP literal — o DNS lookup resolve e valida
  return isBlockedAddress(bare);
}

// Retorna null em qualquer falha (URL inválida, host bloqueado, timeout,
// resposta não-HTML, excesso de redirects) — sem lançar: preview é um
// "melhor esforço", nunca deve derrubar o envio da mensagem em si.
export async function fetchLinkPreview(rawUrl: string, userId: number): Promise<NonNullable<MessageMetadata["linkPreview"]> | null> {
  if (throttled(userId)) return null;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return null;
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") return null;
  if (isBlockedHostnameLiteral(current.hostname)) return null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await undiciFetch(current, {
        dispatcher: safeAgent,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "Mozilla/5.0 (compatible; SheikcellLinkPreview/1.0)" },
      }) as unknown as Response;
    } catch (err) {
      logger.debug({ err, url: current.toString() }, "link preview: fetch falhou");
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      let next: URL;
      try { next = new URL(location, current); } catch { return null; }
      if (isBlockedHostnameLiteral(next.hostname)) return null;
      if (next.protocol !== "http:" && next.protocol !== "https:") return null;
      current = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) return null;

    const html = await readBounded(res);
    if (html == null) return null;

    try {
      return parseOgTags(html, current.toString());
    } catch (err) {
      logger.debug({ err, url: current.toString() }, "link preview: parsing falhou");
      return null;
    }
  }
  return null; // excedeu o limite de redirects
}

// Primeira URL http(s) encontrada num texto — usado pra decidir se vale a
// pena tentar buscar preview. Não precisa ser um parser RFC-completo, só
// pegar o caso comum (link solto no meio do texto).
const URL_REGEX = /https?:\/\/[^\s<>"']+/i;

export function firstUrlIn(text: string): string | null {
  const match = URL_REGEX.exec(text);
  if (!match) return null;
  // Remove pontuação de fechamento comum colada no fim do link (ex.: "veja
  // https://exemplo.com." ou "(https://exemplo.com)").
  return match[0].replace(/[.,;:!?)\]}'"]+$/, "");
}
