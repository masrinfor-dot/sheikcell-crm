import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, gte, lt, max, sql, count, type SQL } from "drizzle-orm";
import { db, erpExchangeLogsTable, tenantErpIntegrationsTable } from "@workspace/db";
import { logger } from "./logger";

// Trocas com o ERP (19/10/2026 — Samuel: "nessa integração cria uma aba com
// todas as informações que são trocadas entre o CRM e o Prumo").
//   1. MAPA fixo (CRM_ERP_FLOWS): cada fluxo, para que lado, o que vai, o
//      acesso (scope) que a chave do ERP precisa, de quanto em quanto tempo e
//      qual chave liga/desliga aqui. Fluxo novo = um item a mais no array.
//   2. HISTÓRICO: o erpFetch grava cada chamada ao ERP (rota sem query, status,
//      duração, contagem). Nunca o conteúdo: nada de texto de mensagem de
//      cliente, documento ou chave. Guardado 90 dias (limpeza no scheduler).
// A loja (tenant) de cada chamada vem do contexto `withErpTenant` — quem chama
// o ERP dentro de um laço por loja embrulha a chamada nele.

export type ErpDirection = "CRM_TO_ERP" | "ERP_TO_CRM";
export type ErpFlowStatus = "ON" | "OFF" | "NO_ACCESS" | "MANUAL";

export const ERP_EXCHANGE_RETENTION_DAYS = 90;
const PAGE_SIZE = 50;
const MAX_ERROR = 300;
const MAX_BODY_TO_COUNT = 1_000_000;

type IntegrationRow = typeof tenantErpIntegrationsTable.$inferSelect;

export interface ErpFlowRoute {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "FILE";
  /** Caminho a partir de `/integrations` (`:id` onde houver id; `/**` no fim = qualquer subcaminho). */
  path: string;
  direction: ErpDirection;
  one: string;
  many: string;
}

export interface ErpFlowDef {
  key: string;
  label: string;
  what: string;
  scope: string | null;
  frequency: string;
  /** Feito à mão por uma tela (arquivo exportado para o ERP). */
  manual?: string;
  /** Liga/desliga aqui no CRM (null = sem chave própria: basta a integração existir). */
  enabled?: (row: IntegrationRow) => boolean;
  enabledHint?: string;
  routes: ErpFlowRoute[];
}

export const CRM_ERP_FLOWS: readonly ErpFlowDef[] = [
  {
    key: "ping",
    label: "Teste da conexão",
    what: "O CRM confere se a chave funciona; o ERP responde o nome da empresa, da chave e os acessos dela.",
    scope: null,
    frequency: "Ao clicar em \"Testar\" e ao abrir esta aba",
    routes: [{ method: "GET", path: "/ping", direction: "ERP_TO_CRM", one: "teste", many: "testes" }],
  },
  {
    key: "os_messages",
    label: "Mensagens das OS",
    what: "O ERP entrega as mensagens das ordens de serviço (situação, peças e valores, laudo e link); o CRM manda no WhatsApp, abre o atendimento e avisa o ERP se foi enviada.",
    scope: "service_orders.notify",
    frequency: "A cada 1 minuto",
    enabled: (r) => r.osMessagesEnabled,
    enabledHint: "Ligue \"Mensagens das OS\" no cartão do ERP (aba Conexões).",
    routes: [
      { method: "GET", path: "/service-orders/messages/due", direction: "ERP_TO_CRM", one: "mensagem de OS recebida do ERP", many: "mensagens de OS recebidas do ERP" },
      { method: "POST", path: "/service-orders/messages/:id/result", direction: "CRM_TO_ERP", one: "resultado de envio de mensagem de OS", many: "resultados de envio de mensagens de OS" },
    ],
  },
  {
    key: "os_status",
    label: "Situação da OS para o robô",
    what: "Quando o cliente pergunta no WhatsApp, o robô consulta no ERP a situação das OS dele (só do próprio celular).",
    scope: "service_orders.notify",
    frequency: "Cada vez que um cliente pergunta",
    routes: [
      { method: "GET", path: "/service-orders/status", direction: "ERP_TO_CRM", one: "OS informada ao robô", many: "OS informadas ao robô" },
    ],
  },
  {
    key: "hr",
    label: "Colaboradores e ponto (RH)",
    what: "O CRM manda as batidas de ponto do WhatsApp, o fechamento do mês, os documentos da contratação e o histórico do RH; o ERP devolve a lista de colaboradores.",
    scope: "hr.sync",
    frequency: "A cada 5 minutos",
    enabled: (r) => r.hrSyncEnabled,
    enabledHint: "Ligue \"RH no ERP\" no cartão do ERP (aba Conexões).",
    routes: [
      { method: "POST", path: "/hr/employees", direction: "CRM_TO_ERP", one: "colaborador enviado", many: "colaboradores enviados" },
      { method: "GET", path: "/hr/employees", direction: "ERP_TO_CRM", one: "colaborador atualizado aqui", many: "colaboradores atualizados aqui" },
      { method: "POST", path: "/hr/employees/link", direction: "CRM_TO_ERP", one: "colaborador ligado ao ERP", many: "colaboradores ligados ao ERP" },
      { method: "POST", path: "/hr/punches", direction: "CRM_TO_ERP", one: "batida de ponto enviada", many: "batidas de ponto enviadas" },
      { method: "POST", path: "/hr/punches/delete", direction: "CRM_TO_ERP", one: "batida apagada", many: "batidas apagadas" },
      { method: "POST", path: "/hr/timesheets", direction: "CRM_TO_ERP", one: "fechamento de ponto enviado", many: "fechamentos de ponto enviados" },
      { method: "POST", path: "/hr/documents", direction: "CRM_TO_ERP", one: "documento de contratação enviado", many: "documentos de contratação enviados" },
      { method: "POST", path: "/hr/import", direction: "CRM_TO_ERP", one: "registro do histórico do RH enviado", many: "registros do histórico do RH enviados" },
    ],
  },
  {
    key: "storefront_export",
    label: "Vitrine de aparelhos",
    what: "Arquivo com produtos, fotos, categorias, cupons e leads da Vitrine, que o ERP importa.",
    scope: null,
    frequency: "Uma vez (na mudança para o ERP)",
    manual: "Vitrine › Exportar para o ERP",
    routes: [
      { method: "FILE", path: "/catalog/export", direction: "CRM_TO_ERP", one: "produto exportado", many: "produtos exportados" },
    ],
  },
  {
    key: "trade_in_export",
    label: "Avaliação de usados",
    what: "Arquivo com as avaliações, compras fechadas, configuração e tabela de valores, que o ERP importa.",
    scope: null,
    frequency: "Uma vez (na mudança para o ERP)",
    manual: "Avaliação de usados › Exportar para o ERP",
    routes: [
      { method: "FILE", path: "/trade-in/export", direction: "CRM_TO_ERP", one: "avaliação exportada", many: "avaliações exportadas" },
    ],
  },
  {
    key: "demand",
    label: "Pedidos de clientes sem estoque (atacado)",
    what: "O CRM manda o texto que os clientes escreveram na linha de atacado; a IA do ERP lista o que foi pedido e confere o estoque (Compras › Pedidos de clientes).",
    scope: "demand.write",
    frequency: "A cada 30 minutos (ou \"Enviar agora\")",
    enabled: (r) => r.demandSyncEnabled,
    enabledHint: "Escolha a linha de atacado e ligue \"Mandar para o ERP\" no cartão do ERP (aba Conexões).",
    routes: [
      { method: "POST", path: "/customer-demand/conversations", direction: "CRM_TO_ERP", one: "conversa de atacado enviada", many: "conversas de atacado enviadas" },
    ],
  },
  {
    key: "attendance",
    label: "Atendimentos e vendas do atendimento",
    what: "O CRM manda os atendimentos (celular, atendente, setor, loja, último contato) e a lista de atendentes; o ERP marca as vendas que vieram do atendimento e devolve as vendas por atendente e as compras do cliente.",
    scope: "attendance.write",
    frequency: "A cada 10 minutos (atendentes: a cada hora); vendas ao abrir o Financeiro ou a conversa",
    routes: [
      { method: "POST", path: "/crm-attendance/attendances", direction: "CRM_TO_ERP", one: "atendimento enviado", many: "atendimentos enviados" },
      { method: "POST", path: "/crm-attendance/attendants", direction: "CRM_TO_ERP", one: "atendente enviado", many: "atendentes enviados" },
      { method: "GET", path: "/sales/by-attendant", direction: "ERP_TO_CRM", one: "atendente com vendas", many: "atendentes com vendas" },
      { method: "GET", path: "/sales/by-phone", direction: "ERP_TO_CRM", one: "compra do cliente", many: "compras do cliente" },
    ],
  },
  {
    key: "raffles",
    label: "Sorteios (aviso aos ganhadores)",
    what: "O ERP faz os sorteios; o CRM busca os avisos aos ganhadores, manda pelo WhatsApp e devolve se foi enviado.",
    scope: "raffles.send",
    frequency: "A cada minuto (depois de mudar os sorteios para o ERP)",
    routes: [
      { method: "GET", path: "/raffles/messages/due", direction: "ERP_TO_CRM", one: "aviso de sorteio recebido", many: "avisos de sorteio recebidos" },
      { method: "POST", path: "/raffles/messages/:id/result", direction: "CRM_TO_ERP", one: "resultado de aviso enviado", many: "resultados de aviso enviados" },
    ],
  },
  {
    key: "tasks",
    label: "Quadro de tarefas",
    what: "As tarefas moram no ERP; o quadro do CRM lista, cria, edita, move e comenta as mesmas tarefas (sempre dizendo quem fez).",
    scope: "tasks.sync",
    frequency: "Ao usar o quadro de tarefas (avisos a cada 2 minutos)",
    routes: [
      { method: "GET", path: "/tasks/**", direction: "ERP_TO_CRM", one: "leitura do quadro", many: "leituras do quadro" },
      { method: "POST", path: "/tasks/import", direction: "CRM_TO_ERP", one: "tarefa antiga levada ao ERP", many: "tarefas antigas levadas ao ERP" },
      { method: "POST", path: "/tasks/**", direction: "CRM_TO_ERP", one: "tarefa criada/alterada", many: "tarefas criadas/alteradas" },
      { method: "PATCH", path: "/tasks/**", direction: "CRM_TO_ERP", one: "tarefa alterada", many: "tarefas alteradas" },
      { method: "PUT", path: "/tasks/**", direction: "CRM_TO_ERP", one: "tarefa alterada", many: "tarefas alteradas" },
      { method: "DELETE", path: "/tasks/**", direction: "CRM_TO_ERP", one: "tarefa apagada", many: "tarefas apagadas" },
    ],
  },
  {
    key: "supplier_prices",
    label: "Listas de preço dos fornecedores (WhatsApp de compras)",
    what: "Cada mensagem, foto, PDF ou planilha que os fornecedores mandam no WhatsApp de compras vai para o ERP, que lê com IA e monta a cotação (Compras › Cotações).",
    scope: "supplier_prices.write",
    frequency: "Na hora em que a mensagem chega (com novas tentativas se o ERP estiver fora)",
    enabledHint: "Marque \"Encaminhar listas de fornecedores ao ERP\" na conexão do número de compras (Administração › WhatsApp).",
    routes: [
      { method: "POST", path: "/supplier-price-lists", direction: "CRM_TO_ERP", one: "lista de fornecedor enviada", many: "listas de fornecedor enviadas" },
    ],
  },
  {
    key: "raffles_export",
    label: "Sorteios (arquivo)",
    what: "Arquivo com os sorteios e os resultados do CRM, que o ERP importa.",
    scope: null,
    frequency: "Uma vez (na mudança para o ERP)",
    manual: "Sorteios › Exportar para o ERP",
    routes: [
      { method: "FILE", path: "/raffles/export", direction: "CRM_TO_ERP", one: "sorteio exportado", many: "sorteios exportados" },
    ],
  },
  {
    key: "tvbox_export",
    label: "TV Box (arquivo)",
    what: "Arquivo com os assinantes, mensalidades e se a cobrança do CRM foi desligada, que o ERP importa.",
    scope: null,
    frequency: "Uma vez (na mudança para o ERP)",
    manual: "TV Box › Exportar para o ERP",
    routes: [
      { method: "FILE", path: "/tvbox/export", direction: "CRM_TO_ERP", one: "assinante exportado", many: "assinantes exportados" },
    ],
  },
  {
    key: "documents_export",
    label: "Documentos (arquivo)",
    what: "Arquivo com os documentos da loja; o ERP baixa cada arquivo do CRM.",
    scope: null,
    frequency: "Uma vez (na mudança para o ERP)",
    manual: "Documentos › Exportar para o ERP",
    routes: [
      { method: "FILE", path: "/documents/export", direction: "CRM_TO_ERP", one: "documento exportado", many: "documentos exportados" },
    ],
  },
];

export const OTHER_FLOW = "other";

// ─── Contexto da loja (tenant) ──────────────────────────────────────────────

const tenantStorage = new AsyncLocalStorage<number>();

/** Roda `fn` com a loja definida: as chamadas ao ERP dentro dela entram no histórico dessa loja. */
export function withErpTenant<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(tenantId, fn);
}

export function currentErpTenant(): number | null {
  return tenantStorage.getStore() ?? null;
}

// ─── Funções puras ──────────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** "/integrations/surveys/<uuid>/result?x=1" → "/surveys/:id/result" (sem query: lá vai celular). */
export function erpRoutePath(pathWithQuery: string): string {
  const raw = pathWithQuery.split("?")[0] ?? "";
  const at = raw.indexOf("/integrations");
  const rest = at >= 0 ? raw.slice(at + "/integrations".length) : raw;
  return (rest.replace(UUID_RE, ":id").replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/+$/, "") || "/").slice(0, 200);
}

function pathMatches(template: string, path: string): boolean {
  const a = template.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a[a.length - 1] === "**") {
    const head = a.slice(0, -1);
    return b.length >= head.length && head.every((seg, i) => seg.startsWith(":") || seg === b[i]);
  }
  return a.length === b.length && a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
}

export function findErpFlow(method: string, path: string): { flow: ErpFlowDef; route: ErpFlowRoute } | null {
  const m = method.toUpperCase();
  let fallback: { flow: ErpFlowDef; route: ErpFlowRoute } | null = null;
  for (const flow of CRM_ERP_FLOWS) {
    for (const route of flow.routes) {
      if (route.method !== m) continue;
      if (route.path === path) return { flow, route };
      if (!fallback && pathMatches(route.path, path)) fallback = { flow, route };
    }
  }
  return fallback;
}

export function exchangeSummary(route: ErpFlowRoute, n: number): string {
  return `${n} ${n === 1 ? route.one : route.many}`;
}

/** Só a QUANTIDADE do que foi trocado: envio pelos itens mandados, busca pelo que voltou. */
export function countErpExchange(method: string, body: unknown, response: unknown): number | null {
  const len = (v: unknown) => (Array.isArray(v) ? v.length : null);
  if (method.toUpperCase() === "POST") {
    let parsed: unknown = body;
    if (typeof body === "string") {
      if (body.length > MAX_BODY_TO_COUNT) return 1;
      try { parsed = JSON.parse(body); } catch { return 1; }
    }
    const b = (parsed ?? {}) as Record<string, unknown>;
    return len(b["items"]) ?? len(b["crmEntryIds"]) ?? 1;
  }
  if (Array.isArray(response)) return response.length;
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const n = len(r["items"]) ?? len(r["orders"]);
    if (n !== null) return n;
    if (r["found"] === false) return 0;
  }
  return null;
}

/** Tira chave/token da mensagem de erro e corta. */
export function scrubErpError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  return msg
    .replace(/erp_[0-9a-f]{12}_[A-Za-z0-9_-]+/g, "erp_***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, MAX_ERROR);
}

/** Situação de um fluxo aqui no CRM. `scopes` null = não deu para conferir na chave agora. */
export function erpFlowStatus(flow: ErpFlowDef, row: IntegrationRow | null, scopes: string[] | null): { status: ErpFlowStatus; reason: string } {
  if (flow.manual) return { status: "MANUAL", reason: `Feito à mão: ${flow.manual}.` };
  if (!row) return { status: "OFF", reason: "Sem chave do ERP salva (aba Conexões)." };
  if (flow.enabled && !flow.enabled(row)) return { status: "OFF", reason: flow.enabledHint ?? "Desligado aqui no CRM." };
  if (flow.scope && scopes && !scopes.includes(flow.scope)) {
    return { status: "NO_ACCESS", reason: "A chave do ERP não tem esse acesso. Gere outra chave no ERP marcando o acesso." };
  }
  return { status: "ON", reason: scopes ? "Ligado e com acesso na chave." : "Ligado (não deu para conferir os acessos da chave agora)." };
}

// ─── Banco ──────────────────────────────────────────────────────────────────

export interface ErpExchangeRecord {
  tenantId: number;
  method: string;
  /** Caminho como foi chamado (com /integrations e query — a query é descartada). */
  path: string;
  httpStatus: number | null;
  ok: boolean;
  durationMs: number;
  itemCount?: number | null;
  error?: string | null;
}

/** Nunca derruba quem chamou: erro ao gravar só vira aviso no log. */
export async function recordErpExchange(r: ErpExchangeRecord): Promise<void> {
  try {
    const route = r.method === "FILE" ? r.path : erpRoutePath(r.path);
    const match = findErpFlow(r.method, route);
    const n = r.itemCount ?? null;
    await db.insert(erpExchangeLogsTable).values({
      tenantId: r.tenantId,
      flow: match?.flow.key ?? OTHER_FLOW,
      direction: match?.route.direction ?? "CRM_TO_ERP",
      method: r.method.toUpperCase(),
      path: route,
      httpStatus: r.httpStatus,
      ok: r.ok,
      durationMs: Math.max(0, Math.round(r.durationMs)),
      itemCount: n,
      summary: match && n !== null && r.ok ? exchangeSummary(match.route, n) : null,
      error: r.ok ? null : (scrubErpError(r.error) ?? `ERP respondeu ${r.httpStatus ?? "sem resposta"}`),
    });
  } catch (err) {
    logger.warn({ err }, "Trocas com o ERP: não gravou o registro");
  }
}

export async function cleanupErpExchanges(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ERP_EXCHANGE_RETENTION_DAYS * 86_400_000);
  const res = await db.delete(erpExchangeLogsTable).where(lt(erpExchangeLogsTable.createdAt, cutoff))
    .returning({ id: erpExchangeLogsTable.id });
  return res.length;
}

/** Início do dia de hoje no horário de Brasília (UTC-3, sem horário de verão desde 2019). */
export function startOfTodayBr(now = new Date()): Date {
  const br = new Date(now.getTime() - 3 * 3600_000);
  return new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate(), 3));
}

/** "2026-10-19" → início desse dia em Brasília; null se inválida. */
export function brDayStart(key: string | undefined, plusDays = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays, 3));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ErpExchangeQuery {
  flow?: string;
  direction?: string;
  result?: string;
  from?: string;
  to?: string;
  hideEmpty?: string;
  page?: string;
}

export async function listErpExchanges(tenantId: number, q: ErpExchangeQuery, now = new Date()) {
  const t = erpExchangeLogsTable;
  const conds: SQL[] = [eq(t.tenantId, tenantId)];
  if (q.flow) conds.push(eq(t.flow, q.flow));
  if (q.direction === "CRM_TO_ERP" || q.direction === "ERP_TO_CRM") conds.push(eq(t.direction, q.direction));
  if (q.result === "ok") conds.push(eq(t.ok, true));
  if (q.result === "error") conds.push(eq(t.ok, false));
  const from = brDayStart(q.from);
  const to = brDayStart(q.to, 1);
  if (from) conds.push(gte(t.createdAt, from));
  if (to) conds.push(lt(t.createdAt, to));
  // Buscas que voltaram vazias (fila sem nada, a cada minuto) poluem a lista.
  if (q.hideEmpty === "true") conds.push(sql`NOT (${t.ok} AND ${t.method} = 'GET' AND ${t.itemCount} IS NOT DISTINCT FROM 0)`);
  const where = and(...conds);
  const page = Math.max(1, parseInt(q.page ?? "1", 10) || 1);

  const [[{ total } = { total: 0 }], items, todayRows] = await Promise.all([
    db.select({ total: count() }).from(t).where(where),
    db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ direction: t.direction, ok: t.ok, n: count() }).from(t)
      .where(and(eq(t.tenantId, tenantId), gte(t.createdAt, startOfTodayBr(now))))
      .groupBy(t.direction, t.ok),
  ]);
  const sum = (pred: (r: (typeof todayRows)[number]) => boolean) => todayRows.filter(pred).reduce((a, r) => a + Number(r.n), 0);
  return {
    items: items.map(({ tenantId: _t, ...rest }) => rest),
    total: Number(total),
    page,
    pageSize: PAGE_SIZE,
    today: {
      total: sum(() => true),
      ok: sum((r) => r.ok),
      errors: sum((r) => !r.ok),
      crmToErp: sum((r) => r.direction === "CRM_TO_ERP"),
      erpToCrm: sum((r) => r.direction === "ERP_TO_CRM"),
    },
    retentionDays: ERP_EXCHANGE_RETENTION_DAYS,
  };
}

// Acessos da chave (vêm do /integrations/ping): guardados em memória por 10 min
// para abrir a aba não chamar o ERP toda hora.
const SCOPES_TTL_MS = 10 * 60_000;
const scopesCache = new Map<number, { scopes: string[]; at: number }>();

export function rememberErpScopes(tenantId: number, scopes: string[]): void {
  scopesCache.set(tenantId, { scopes, at: Date.now() });
}

export function forgetErpScopes(tenantId: number): void {
  scopesCache.delete(tenantId);
}

export async function erpKeyScopes(
  tenantId: number,
  ping: () => Promise<{ key?: { scopes?: string[] } }>,
): Promise<{ scopes: string[] | null; error: string | null }> {
  const hit = scopesCache.get(tenantId);
  if (hit && Date.now() - hit.at < SCOPES_TTL_MS) return { scopes: hit.scopes, error: null };
  try {
    const res = await ping();
    const scopes = res.key?.scopes ?? [];
    rememberErpScopes(tenantId, scopes);
    return { scopes, error: null };
  } catch (err) {
    return { scopes: hit?.scopes ?? null, error: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

export async function erpFlowsOverview(tenantId: number, row: IntegrationRow | null, scopes: string[] | null, now = new Date()) {
  const t = erpExchangeLogsTable;
  const [lastRows, todayRows] = await Promise.all([
    db.select({ flow: t.flow, last: max(t.createdAt) }).from(t).where(eq(t.tenantId, tenantId)).groupBy(t.flow),
    db.select({ flow: t.flow, ok: t.ok, n: count() }).from(t)
      .where(and(eq(t.tenantId, tenantId), gte(t.createdAt, startOfTodayBr(now))))
      .groupBy(t.flow, t.ok),
  ]);
  const lastAt = new Map(lastRows.map((r) => [r.flow, r.last]));
  const today = (flow: string, ok: boolean) => Number(todayRows.find((r) => r.flow === flow && r.ok === ok)?.n ?? 0);
  return CRM_ERP_FLOWS.map((f) => {
    const { status, reason } = erpFlowStatus(f, row, scopes);
    return {
      key: f.key,
      label: f.label,
      what: f.what,
      scope: f.scope,
      frequency: f.frequency,
      manual: f.manual ?? null,
      directions: [...new Set(f.routes.map((r) => r.direction))],
      status,
      reason,
      lastExchangeAt: lastAt.get(f.key) ?? null,
      todayOk: today(f.key, true),
      todayErrors: today(f.key, false),
    };
  });
}
