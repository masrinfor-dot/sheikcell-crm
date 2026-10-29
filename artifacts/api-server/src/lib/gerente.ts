// Gerente IA — secretária executiva / gerente geral por WhatsApp.
//
// Liga as regras puras (gerenteRules.ts) ao banco, à IA e ao WhatsApp:
//   • reconhece o remetente autorizado (celular pessoal do dono) em qualquer
//     linha de WhatsApp conectada ao CRM — a mensagem NUNCA vira conversa de
//     atendimento nem aparece pra equipe;
//   • interpreta a frase (regras primeiro, sem custo; IA com function-calling
//     quando as regras não entendem) e executa a ação: lembrete, gasto/
//     receita, conta a pagar/receber, tarefa pra equipe, compromisso,
//     consulta ("meu dia", "contas"...), busca de cliente;
//   • responde pelo mesmo número e guarda tudo em gerente_messages;
//   • avisa lembretes/compromissos na hora (job periódico — ver scheduler.ts)
//     e manda o resumo "Meu dia" de manhã.
// Nunca lança pra fora: falha aqui não pode derrubar o webhook do WhatsApp.
import type OpenAI from "openai";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, or, eq, desc, asc, gte, lte, lt, isNull, isNotNull, inArray, ilike, ne, sql } from "drizzle-orm";
import {
  db,
  gerenteSettingsTable, gerenteMessagesTable, gerenteEventsTable, gerenteRemindersTable, gerenteMembersTable, type GerenteMember, gerenteTaskAcksTable, taskCommentsTable,
  gerenteEntriesTable, gerenteBillsTable, gerentePendingActionsTable, gerenteTaskDispatchesTable,
  tasksTable, taskAssigneesTable, usersTable, gerenteTaskMetaTable, storesTable, tenantsTable, whatsappSessionsTable,
  crmContactsTable, crmInternalNotesTable, conversationsTable,
  type GerenteSettings,
} from "@workspace/db";
import { normalizePhone, phoneVariants } from "./phone";
import { sendRawWhatsAppText } from "./outbound";
import { logger } from "./logger";
import {
  parseByRules, extractWhen, parseSpLocal, spDateISO, spTimeHM, withinRange, fmtWhen, fmtDateISO,
  describeNow, brl, cleanTitle, norm, HELP_TEXT, parseBRL as parseBRLText, type RuleIntent,
} from "./gerenteRules";

export const GERENTE_MODULE = "gerente";
const PENDING_TTL_MS = 10 * 60_000;
const HISTORY_LIMIT = 12;

// ─── Configuração (cache curto — roda em TODA mensagem recebida) ─────────────

type SettingsCacheEntry = { at: number; settings: GerenteSettings; moduleOn: boolean; members: GerenteMember[] };

// ─── Quem está falando: o dono ou um gestor (2º número) ─────────────────────
// Guardado no contexto da execução: as funções de lembrete/agenda filtram por
// ele sem precisar passar o telefone por todo lado.
export type GerenteActor = { role: "dono" | "gestor"; phone: string; name: string; userId: number | null };
const actorStore = new AsyncLocalStorage<GerenteActor>();
export function currentActor(): GerenteActor | null { return actorStore.getStore() ?? null; }
const gestorPhone = (): string | null => { const a = actorStore.getStore(); return a?.role === "gestor" ? a.phone : null; };
const isGestor = (): boolean => actorStore.getStore()?.role === "gestor";
const remScope = () => { const p = gestorPhone(); return p ? eq(gerenteRemindersTable.memberPhone, p) : isNull(gerenteRemindersTable.memberPhone); };
const evScope = () => { const p = gestorPhone(); return p ? eq(gerenteEventsTable.memberPhone, p) : isNull(gerenteEventsTable.memberPhone); };
const FIN_BLOCK = "💰 Financeiro, contas e ERP ficam só com o dono. Pra isso, fale com ele.";

export async function activeMembers(tenantId: number): Promise<GerenteMember[]> {
  return db.select().from(gerenteMembersTable).where(and(eq(gerenteMembersTable.tenantId, tenantId), eq(gerenteMembersTable.isActive, true)));
}
export function memberForPhone(members: GerenteMember[], phone: string): GerenteMember | null {
  const p = normalizePhone(phone);
  return p ? members.find((m) => normalizePhone(m.phone) === p) ?? null : null;
}
const settingsCache = new Map<number, SettingsCacheEntry>();
const SETTINGS_TTL_MS = 30_000;

export function invalidateGerenteCache(tenantId?: number): void {
  if (tenantId == null) settingsCache.clear();
  else settingsCache.delete(tenantId);
}

export async function getGerenteSettings(tenantId: number): Promise<GerenteSettings> {
  const [row] = await db.select().from(gerenteSettingsTable).where(eq(gerenteSettingsTable.tenantId, tenantId)).limit(1);
  if (row) return row;
  await db.insert(gerenteSettingsTable).values({ tenantId }).onConflictDoNothing();
  const [created] = await db.select().from(gerenteSettingsTable).where(eq(gerenteSettingsTable.tenantId, tenantId)).limit(1);
  return created!;
}

async function cachedContext(tenantId: number): Promise<SettingsCacheEntry> {
  const now = Date.now();
  const hit = settingsCache.get(tenantId);
  if (hit && now - hit.at < SETTINGS_TTL_MS) return hit;
  const settings = await getGerenteSettings(tenantId);
  const [tenant] = await db.select({ enabledModules: tenantsTable.enabledModules, isActive: tenantsTable.isActive })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  const moduleOn = !!tenant?.isActive && (tenant.enabledModules ?? []).includes("gerente");
  const entry = { at: now, settings, moduleOn, members: await activeMembers(tenantId) };
  settingsCache.set(tenantId, entry);
  return entry;
}

/** Normaliza a lista de telefones autorizados (aceita com/sem 55, com/sem o 9). */
export function normalizeAuthorizedPhones(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const v of input) {
    const p = normalizePhone(String(v ?? ""));
    if (p && p.length >= 10) out.add(p);
  }
  return [...out];
}

export function isAuthorizedPhone(settings: Pick<GerenteSettings, "authorizedPhones">, phone: string): boolean {
  const p = normalizePhone(phone);
  if (!p) return false;
  return (settings.authorizedPhones ?? []).some((a) => normalizePhone(a) === p);
}

// ─── Memória da conversa ─────────────────────────────────────────────────────

type MsgRef = { table: "reminder" | "entry" | "bill" | "event" | "task" | "bill_paid"; id: number };
type ActionResult = { text: string; ref?: MsgRef };

async function saveOut(tenantId: number, phone: string, sessionKey: string | null, content: string, source: string): Promise<void> {
  await db.insert(gerenteMessagesTable).values({ tenantId, phone, sessionKey, direction: "out", source, content });
  // Espelho na sala "🤖 Gerente IA" do chat interno (o que veio do chat já está lá).
  if (source !== "chat") {
    void (async () => {
      const gestor = memberForPhone(await activeMembers(tenantId), phone);
      const { mirrorToGerenteRoom } = await import("./gerenteInternal");
      await mirrorToGerenteRoom(tenantId, "out", content, gestor ? phone : null);
    })().catch(() => undefined);
  }
}

// ─── Ações (compartilhadas pelas regras, pela IA e pelo painel) ──────────────

async function ownerUserId(tenantId: number): Promise<number | null> {
  const [u] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin")))
    .orderBy(asc(usersTable.id)).limit(1);
  return u?.id ?? null;
}

async function teamUsers(tenantId: number): Promise<{ id: number; name: string; role: string }[]> {
  return db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), ne(usersTable.role, "superadmin")))
    .orderBy(asc(usersTable.name));
}

function matchUser(users: { id: number; name: string }[], name: string | null | undefined): { id: number; name: string } | null {
  if (!name) return null;
  const q = norm(name);
  if (!q) return null;
  const exact = users.find((u) => norm(u.name) === q);
  if (exact) return exact;
  const first = users.find((u) => norm(u.name).split(" ")[0] === q);
  if (first) return first;
  const partial = users.filter((u) => norm(u.name).includes(q));
  return partial.length === 1 ? partial[0]! : null;
}

export async function createReminder(tenantId: number, p: { title: string; dueAt: Date; urgent?: boolean }): Promise<ActionResult> {
  const [r] = await db.insert(gerenteRemindersTable)
    .values({ tenantId, title: p.title.slice(0, 200), dueAt: p.dueAt, urgent: !!p.urgent, memberPhone: gestorPhone() }).returning();
  return { text: `⏰ Lembrete anotado: *${r!.title}* — ${fmtWhen(r!.dueAt)}${r!.urgent ? " (urgente)" : ""}.`, ref: { table: "reminder", id: r!.id } };
}

async function createEntry(tenantId: number, p: {
  kind: "gasto" | "receita"; amountCents: number; description: string; category?: string | null; scope?: "pessoal" | "empresa";
  storeName?: string | null; paymentMethod?: string | null; installments?: number; reimbursementPending?: boolean; entryDate?: string | null;
}): Promise<ActionResult> {
  const entryDate = p.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(p.entryDate) ? p.entryDate : spDateISO();
  // Duplicidade: mesmo valor + mesma descrição no mesmo dia — avisa, mas grava
  // (o dono pode desfazer); nunca descarta em silêncio.
  const [dup] = await db.select({ id: gerenteEntriesTable.id }).from(gerenteEntriesTable).where(and(
    eq(gerenteEntriesTable.tenantId, tenantId), eq(gerenteEntriesTable.kind, p.kind),
    eq(gerenteEntriesTable.amountCents, p.amountCents), eq(gerenteEntriesTable.entryDate, entryDate),
    ilike(gerenteEntriesTable.description, p.description.slice(0, 200)),
  )).limit(1);
  const [e] = await db.insert(gerenteEntriesTable).values({
    tenantId, kind: p.kind, amountCents: p.amountCents, description: p.description.slice(0, 200),
    category: p.category?.slice(0, 60) ?? null, scope: p.scope ?? "empresa", storeName: p.storeName?.slice(0, 60) ?? null,
    paymentMethod: p.paymentMethod?.slice(0, 40) ?? null, installments: Math.max(1, Math.min(60, Math.floor(p.installments ?? 1))),
    reimbursementPending: !!p.reimbursementPending, entryDate,
  }).returning();
  const label = p.kind === "gasto" ? "💸 Gasto" : "💰 Receita";
  const extras = [
    e!.scope === "pessoal" ? "pessoal" : "empresa",
    e!.storeName ?? null,
    e!.paymentMethod ?? null,
    e!.installments > 1 ? `${e!.installments}x` : null,
    e!.reimbursementPending ? "reembolso pendente" : null,
  ].filter(Boolean).join(" · ");
  return {
    text: `${label} lançado: *${brl(e!.amountCents)}* — ${e!.description} (${extras})${entryDate !== spDateISO() ? ` em ${fmtDateISO(entryDate)}` : ""}.${dup ? "\n⚠️ Já existe um lançamento igual hoje — se for repetido, mande *desfazer*." : ""}`,
    ref: { table: "entry", id: e!.id },
  };
}

export async function createBill(tenantId: number, p: {
  kind: "pagar" | "receber"; description: string; amountCents: number; dueDate: string;
  counterparty?: string | null; responsible?: string | null; scope?: "pessoal" | "empresa"; storeName?: string | null;
}): Promise<ActionResult> {
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate) ? p.dueDate : spDateISO();
  const [b] = await db.insert(gerenteBillsTable).values({
    tenantId, kind: p.kind, description: p.description.slice(0, 200), amountCents: p.amountCents, dueDate,
    counterparty: p.counterparty?.slice(0, 120) ?? null, responsible: p.responsible?.slice(0, 80) ?? null,
    scope: p.scope ?? "empresa", storeName: p.storeName?.slice(0, 60) ?? null,
  }).returning();
  const label = p.kind === "pagar" ? "📤 Conta a pagar" : "📥 Conta a receber";
  return {
    text: `${label}: *${brl(b!.amountCents)}* — ${b!.description}${b!.counterparty ? ` (${b!.counterparty})` : ""}, vence ${fmtDateISO(dueDate)}${b!.responsible ? `, responsável: ${b!.responsible}` : ""}. Quando quitar, me avise que eu dou baixa.`,
    ref: { table: "bill", id: b!.id },
  };
}

export const TASK_CATEGORIES = ["Loja PP", "Loja SJ", "Loja SC", "Compras", "Financeiro", "Marketing", "Sistema", "Equipe/RH", "Atacado", "Pessoal"] as const;

/** Título canônico pra achar duplicada: sem acento, sem pontuação, x→s, sem plural. */
export function canonTitle(t: string): string {
  return norm(t).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/x/g, "s").replace(/s$/, "")).join(" ");
}

export async function findDuplicateTask(tenantId: number, title: string): Promise<{ id: number; title: string } | null> {
  const key = canonTitle(title);
  if (!key) return null;
  const open = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done")))
    .orderBy(asc(tasksTable.id)).limit(1000);
  return open.find((t) => canonTitle(t.title) === key) ?? null;
}

export async function createTask(tenantId: number, p: {
  title: string; assigneeName?: string | null; assigneeNames?: string[] | null; dueAt?: Date | null;
  priority?: "baixa" | "media" | "alta"; description?: string | null; category?: string | null;
}): Promise<ActionResult> {
  // Nunca cria a mesma tarefa duas vezes (a IA às vezes repete a chamada).
  const dup = await findDuplicateTask(tenantId, p.title);
  if (dup) return { text: `📋 Já existe a tarefa *${dup.id} — ${dup.title}* (não criei outra). Pra mudar algo: *link da tarefa ${dup.id}*.` };

  const users = await teamUsers(tenantId);
  const owner = await ownerUserId(tenantId);
  const names = [...(p.assigneeNames ?? []), ...(p.assigneeName ? [p.assigneeName] : [])].map((n) => n.trim()).filter(Boolean);
  const matched: { id: number; name: string }[] = [];
  const notFound: string[] = [];
  for (const n of names) {
    const u = matchUser(users, n);
    if (u) { if (!matched.some((m) => m.id === u.id)) matched.push(u); } else notFound.push(n);
  }
  // Setor: o nome que veio vira o setor cadastrado (ADM, Financeiro, RH…).
  const { findSector } = await import("./gerenteSectors");
  const sector = await findSector(tenantId, p.category);
  const category = sector?.name ?? (p.category && p.category.trim() ? p.category.trim().slice(0, 40) : null);
  // Sem pessoa citada: responsáveis do setor; sem setor com responsável = quem pediu.
  const actor = actorStore.getStore();
  const me = actor?.role === "gestor" && actor.userId ? actor.userId : owner;
  const sectorPeople = !matched.length && sector?.responsibleIds.length
    ? users.filter((u) => sector.responsibleIds.includes(u.id)).map((u) => ({ id: u.id, name: u.name }))
    : [];
  const assignees = matched.length ? matched : sectorPeople.length ? sectorPeople : me ? [{ id: me, name: users.find((u) => u.id === me)?.name ?? "Você" }] : [];
  const [t] = await db.insert(tasksTable).values({
    tenantId, title: p.title.slice(0, 200), description: p.description?.slice(0, 2000) ?? null,
    priority: p.priority ?? "media", dueDate: p.dueAt ?? null, createdById: me,
  }).returning();
  for (const a of assignees) await db.insert(taskAssigneesTable).values({ tenantId, taskId: t!.id, userId: a.id });
  if (category) await db.insert(gerenteTaskMetaTable).values({ taskId: t!.id, tenantId, category }).onConflictDoNothing();

  // Gerentes (dono + gestores) não recebem a tarefa como vendedor: recebem o
  // pedido de ciência e confirmação do prazo (quando foi o OUTRO gerente que criou).
  const leaderIds = new Set([...(owner ? [owner] : []), ...(await activeMembers(tenantId)).map((m) => m.userId).filter((x): x is number => x != null)]);
  const leadersAsked = assignees.filter((a) => leaderIds.has(a.id) && a.id !== me);
  const team = assignees.filter((a) => a.id !== owner && a.id !== me && !leaderIds.has(a.id));
  const others = [...team, ...leadersAsked];
  const who = others.length ? `para *${others.map((a) => a.name.trim().split(" ")[0]).join(", ")}*` : "nas *suas* tarefas";
  let dispatchLine = "";
  for (const a of leadersAsked) dispatchLine += "\n" + await requestLeaderAck(tenantId, { taskId: t!.id, title: t!.title, dueAt: p.dueAt ?? null, userId: a.id, name: a.name, requestedBy: me });
  if (team.length) {
    const settings = await getGerenteSettings(tenantId);
    const { dispatchTaskToSeller } = await import("./gerenteDispatch");
    for (const a of team) {
      dispatchLine += "\n" + await dispatchTaskToSeller(tenantId, {
        taskId: t!.id, userId: a.id, assigneeName: a.name, title: t!.title,
        dueAt: p.dueAt ?? null, priority: p.priority ?? "media", ownerSessionKey: settings.lastSessionKey,
      });
    }
  }
  const nf = notFound.length ? `\n⚠️ Não achei na equipe: ${notFound.join(", ")}.` : "";
  return {
    text: `📋 Tarefa *${t!.id}* criada ${who}: *${t!.title}*${category ? ` · ${category}` : ""}${sectorPeople.length ? " (responsáveis do setor)" : ""}${p.dueAt ? ` — prazo ${fmtWhen(p.dueAt)}` : ""}${p.priority === "alta" ? " · 🔴 prioridade alta" : ""}.${nf}${dispatchLine}`,
    ref: { table: "task", id: t!.id },
  };
}

// ─── Ciência e prazo entre gerentes (Samuel ↔ Lucelia) ───────────────────────

async function leaderContact(tenantId: number, userId: number): Promise<{ phone: string | null; name: string; isOwner: boolean }> {
  const owner = await ownerUserId(tenantId);
  const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const name = u?.name.trim() ?? "Gerente";
  if (userId === owner) { const s = await getGerenteSettings(tenantId); return { phone: s.lastPhone ?? s.authorizedPhones[0] ?? null, name, isOwner: true }; }
  const m = (await activeMembers(tenantId)).find((x) => x.userId === userId);
  return { phone: m ? normalizePhone(m.phone) ?? m.phone : null, name, isOwner: false };
}

/** Manda pra um gerente (dono ou gestor) pelo WhatsApp do Gerente. */
export async function notifyLeaderUser(tenantId: number, userId: number, text: string): Promise<boolean> {
  const c = await leaderContact(tenantId, userId);
  const settings = await getGerenteSettings(tenantId);
  if (c.isOwner) return notifyOwner(settings, text);
  return c.phone ? notifyPhone(settings, c.phone, text) : false;
}

async function requestLeaderAck(tenantId: number, p: { taskId: number; title: string; dueAt: Date | null; userId: number; name: string; requestedBy: number | null }): Promise<string> {
  await db.insert(gerenteTaskAcksTable).values({ tenantId, taskId: p.taskId, userId: p.userId, requestedBy: p.requestedBy }).onConflictDoNothing();
  const by = p.requestedBy ? (await leaderContact(tenantId, p.requestedBy)).name.split(" ")[0] : "O Gerente";
  const ok = await notifyLeaderUser(tenantId, p.userId, [
    `📋 *${by} criou uma tarefa pra você:* #${p.taskId} ${p.title}`,
    p.dueAt ? `⏰ Prazo: ${fmtWhen(p.dueAt)}` : "⏰ Sem prazo definido",
    "",
    `Confirme a ciência: *ok ${p.taskId}* (ciente${p.dueAt ? " e prazo ok" : ""})`,
    `ou *prazo ${p.taskId} sexta 15h* pra combinar outro prazo.`,
  ].join("\n"));
  const first = p.name.split(" ")[0];
  return ok ? `📨 Pedi a ${first} a ciência e a confirmação do prazo — te aviso quando ${first} confirmar.` : `⚠️ Não consegui avisar ${first} (sem número/linha). A tarefa está no quadro.`;
}

/** "ok 201" / "ciente" / "prazo 201 sexta 15h" de um gerente com ciência pendente. */
async function tryAckCommand(tenantId: number, text: string): Promise<string | null> {
  const actor = actorStore.getStore();
  const userId = actor?.role === "gestor" ? actor.userId : await ownerUserId(tenantId);
  if (!userId) return null;
  const t = norm(text).replace(/[.!]+$/, "");
  const okM = t.match(/^(ok|ciente|confirmo|confirmado|de acordo|combinado|beleza|blz)(?:\s*(?:tarefa\s*)?#?(\d+))?(?:\s*,?\s*(?:ciente|prazo ok|confirmado))?$/);
  const prazoM = t.match(/^(?:prazo|novo prazo|muda o prazo|mudar prazo)(?:\s*(?:da\s*)?(?:tarefa\s*)?#?(\d+))?\s+(.+)$/);
  if (!okM && !prazoM) return null;
  const pending = await db.select({ a: gerenteTaskAcksTable, title: tasksTable.title, dueDate: tasksTable.dueDate }).from(gerenteTaskAcksTable)
    .innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskAcksTable.taskId))
    .where(and(eq(gerenteTaskAcksTable.tenantId, tenantId), eq(gerenteTaskAcksTable.userId, userId), isNull(gerenteTaskAcksTable.ackedAt), eq(tasksTable.isArchived, false)))
    .orderBy(desc(gerenteTaskAcksTable.id)).limit(20);
  if (!pending.length) return null;
  const n = Number((okM ?? prazoM)![okM ? 2 : 1]) || null;
  const target = n ? pending.find((p) => p.a.taskId === n) : pending.length === 1 ? pending[0] : undefined;
  if (!target) {
    if (n) return null;
    return `Qual tarefa? Responda *ok N* ou *prazo N …*:\n${pending.map((p) => `• ${p.a.taskId} — ${p.title}${p.dueDate ? ` (${fmtWhen(p.dueDate)})` : ""}`).join("\n")}`;
  }
  const me = (await leaderContact(tenantId, userId)).name.split(" ")[0];
  let newDue: Date | null = null;
  if (prazoM) {
    const { when } = extractWhen(` ${prazoM[2]} `, new Date(), 18);
    if (!when) return "Não entendi o novo prazo. Ex.: *prazo " + target.a.taskId + " sexta 15h*.";
    newDue = when;
    await db.update(tasksTable).set({ dueDate: when, updatedAt: new Date() }).where(eq(tasksTable.id, target.a.taskId));
  }
  await db.update(gerenteTaskAcksTable).set({ ackedAt: new Date() }).where(eq(gerenteTaskAcksTable.id, target.a.id));
  await db.insert(taskCommentsTable).values({ tenantId, taskId: target.a.taskId, authorId: userId, content: newDue ? `📅 Ciente; prazo combinado: ${fmtWhen(newDue)}.` : `✅ Ciente${target.dueDate ? " e prazo confirmado" : ""}.` });
  if (target.a.requestedBy && target.a.requestedBy !== userId) {
    await notifyLeaderUser(tenantId, target.a.requestedBy, newDue
      ? `📅 *${me}* está ciente da tarefa #${target.a.taskId} (${target.title}) e combinou um novo prazo: *${fmtWhen(newDue)}*.`
      : `✅ *${me}* está ciente da tarefa #${target.a.taskId} (${target.title})${target.dueDate ? ` e confirmou o prazo (${fmtWhen(target.dueDate)})` : ""}.`);
  }
  return newDue ? `📅 Prazo da tarefa #${target.a.taskId} ajustado para ${fmtWhen(newDue)}. Avisei quem criou.` : `✅ Ciência confirmada na tarefa #${target.a.taskId}. Avisei quem criou.`;
}

/** Job: ciência pendente há 3h → lembra o gerente uma vez e avisa quem criou. */
export async function runAckReminders(tenantId: number, now: Date = new Date()): Promise<number> {
  const rows = await db.select({ a: gerenteTaskAcksTable, title: tasksTable.title, status: tasksTable.status }).from(gerenteTaskAcksTable)
    .innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskAcksTable.taskId))
    .where(and(eq(gerenteTaskAcksTable.tenantId, tenantId), isNull(gerenteTaskAcksTable.ackedAt), isNull(gerenteTaskAcksTable.remindedAt),
      lt(gerenteTaskAcksTable.requestedAt, new Date(now.getTime() - 3 * 3_600_000)), eq(tasksTable.isArchived, false))).limit(20);
  let n = 0;
  for (const r of rows) {
    await db.update(gerenteTaskAcksTable).set({ remindedAt: now }).where(eq(gerenteTaskAcksTable.id, r.a.id));
    if (r.status === "done") continue;
    await notifyLeaderUser(tenantId, r.a.userId, `⏳ Falta sua ciência na tarefa #${r.a.taskId} — ${r.title}.\nResponda *ok ${r.a.taskId}* ou *prazo ${r.a.taskId} …*`);
    if (r.a.requestedBy) {
      const who = (await leaderContact(tenantId, r.a.userId)).name.split(" ")[0];
      await notifyLeaderUser(tenantId, r.a.requestedBy, `⏳ *${who}* ainda não confirmou a ciência da tarefa #${r.a.taskId} (${r.title}). Lembrei de novo.`);
    }
    n++;
  }
  return n;
}

async function createEvent(tenantId: number, p: {
  title: string; startsAt: Date; endsAt?: Date | null; location?: string | null; participants?: string | null;
  scope?: "pessoal" | "empresa"; storeName?: string | null; notes?: string | null; remindMinutesBefore?: number;
}): Promise<ActionResult> {
  // Conflito de agenda: outro compromisso ativo na mesma hora (±59 min).
  const windowStart = new Date(p.startsAt.getTime() - 59 * 60_000);
  const windowEnd = new Date(p.startsAt.getTime() + 59 * 60_000);
  const [clash] = await db.select({ title: gerenteEventsTable.title, startsAt: gerenteEventsTable.startsAt }).from(gerenteEventsTable).where(and(
    eq(gerenteEventsTable.tenantId, tenantId), eq(gerenteEventsTable.status, "agendado"),
    gte(gerenteEventsTable.startsAt, windowStart), lte(gerenteEventsTable.startsAt, windowEnd), evScope(),
  )).limit(1);
  const [e] = await db.insert(gerenteEventsTable).values({
    tenantId, title: p.title.slice(0, 200), startsAt: p.startsAt, endsAt: p.endsAt ?? null,
    location: p.location?.slice(0, 200) ?? null, participants: p.participants?.slice(0, 300) ?? null,
    scope: p.scope ?? "empresa", storeName: p.storeName?.slice(0, 60) ?? null, notes: p.notes?.slice(0, 1000) ?? null,
    remindMinutesBefore: Math.max(0, Math.min(1440, Math.floor(p.remindMinutesBefore ?? 30))), memberPhone: gestorPhone(),
  }).returning();
  return {
    text: `📅 Agendado: *${e!.title}* — ${fmtWhen(e!.startsAt)}${e!.location ? ` em ${e!.location}` : ""}${e!.participants ? ` com ${e!.participants}` : ""}. Aviso ${e!.remindMinutesBefore} min antes.${clash ? `\n⚠️ Conflito: você já tem *${clash.title}* ${fmtWhen(clash.startsAt)}.` : ""}`,
    ref: { table: "event", id: e!.id },
  };
}

// "feito"/"adia" se referem SÓ ao último lembrete já AVISADO (sentAt
// preenchido). Um lembrete que ainda não tocou nunca é concluído/adiado por
// um "feito" solto — o dono pode estar respondendo a outra coisa.
async function lastSentReminder(tenantId: number) {
  const [r] = await db.select().from(gerenteRemindersTable).where(and(
    eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"),
    isNotNull(gerenteRemindersTable.sentAt), remScope(),
  )).orderBy(desc(gerenteRemindersTable.sentAt)).limit(1);
  return r ?? null;
}

async function completeLastReminder(tenantId: number): Promise<string> {
  const r = await lastSentReminder(tenantId);
  if (!r) return "Nenhum lembrete avisado está pendente. Mande *lembretes* pra ver a lista. 👍";
  await db.update(gerenteRemindersTable).set({ status: "concluido", updatedAt: new Date() }).where(eq(gerenteRemindersTable.id, r.id));
  if (r.taskId != null) {
    await db.update(tasksTable).set({ status: "done", updatedAt: new Date() }).where(and(eq(tasksTable.id, r.taskId), eq(tasksTable.tenantId, tenantId)));
  }
  return `✅ Feito: *${r.title}*.`;
}

async function snoozeLastReminder(tenantId: number, minutes: number | null, when: Date | null): Promise<string> {
  const r = await lastSentReminder(tenantId);
  if (!r) return "Nenhum lembrete avisado está pendente pra adiar. Mande *lembretes* pra ver a lista.";
  const dueAt = when ?? new Date(Math.max(Date.now(), r.dueAt.getTime()) + (minutes ?? 60) * 60_000);
  await db.update(gerenteRemindersTable).set({ dueAt, sentAt: null, snoozeCount: r.snoozeCount + 1, updatedAt: new Date() })
    .where(eq(gerenteRemindersTable.id, r.id));
  return `⏳ Adiado: *${r.title}* — aviso de novo ${fmtWhen(dueAt)}.`;
}

async function undoLast(tenantId: number, phone: string): Promise<string> {
  const rows = await db.select().from(gerenteMessagesTable).where(and(
    eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.phone, phone), eq(gerenteMessagesTable.direction, "in"),
  )).orderBy(desc(gerenteMessagesTable.id)).limit(10);
  for (const m of rows) {
    const refs = ((m.payload as { refs?: MsgRef[] } | null)?.refs ?? []).filter((r) => r && typeof r.id === "number");
    if (refs.length === 0) continue;
    const done: string[] = [];
    for (const ref of refs) {
      if (ref.table === "reminder") { await db.delete(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.id, ref.id), eq(gerenteRemindersTable.tenantId, tenantId))); done.push("lembrete"); }
      else if (ref.table === "entry") { await db.delete(gerenteEntriesTable).where(and(eq(gerenteEntriesTable.id, ref.id), eq(gerenteEntriesTable.tenantId, tenantId))); done.push("lançamento"); }
      else if (ref.table === "bill") { await db.delete(gerenteBillsTable).where(and(eq(gerenteBillsTable.id, ref.id), eq(gerenteBillsTable.tenantId, tenantId))); done.push("conta"); }
      else if (ref.table === "event") { await db.delete(gerenteEventsTable).where(and(eq(gerenteEventsTable.id, ref.id), eq(gerenteEventsTable.tenantId, tenantId))); done.push("compromisso"); }
      else if (ref.table === "task") {
        await db.update(tasksTable).set({ isArchived: true, updatedAt: new Date() }).where(and(eq(tasksTable.id, ref.id), eq(tasksTable.tenantId, tenantId)));
        const cancelled = await db.update(gerenteTaskDispatchesTable).set({ status: "cancelada" })
          .where(and(eq(gerenteTaskDispatchesTable.taskId, ref.id), eq(gerenteTaskDispatchesTable.tenantId, tenantId), inArray(gerenteTaskDispatchesTable.status, ["enviada", "aguardando_prova"])))
          .returning({ phone: gerenteTaskDispatchesTable.phone, sessionKey: gerenteTaskDispatchesTable.sessionKey });
        for (const c of cancelled) if (c.phone && c.sessionKey) void sendRawWhatsAppText(c.phone, c.sessionKey, `❌ A tarefa ${ref.id} foi cancelada — pode desconsiderar.`);
        done.push("tarefa (arquivada)");
      }
      else if (ref.table === "bill_paid") { await db.update(gerenteBillsTable).set({ status: "aberta", paidAt: null, updatedAt: new Date() }).where(and(eq(gerenteBillsTable.id, ref.id), eq(gerenteBillsTable.tenantId, tenantId))); done.push("baixa da conta (reaberta)"); }
    }
    await db.update(gerenteMessagesTable).set({ payload: { ...(m.payload as object), refs: [], undone: true } }).where(eq(gerenteMessagesTable.id, m.id));
    return `↩️ Desfeito: ${done.join(", ")} de "${m.content.slice(0, 80)}".`;
  }
  return "Não achei nada recente pra desfazer.";
}

// ─── Confirmação ("baixa só com confirmação") ────────────────────────────────

type PendingAction =
  // withEntry: além da baixa, lança o gasto/receita correspondente (quando o
  // dono disse "paguei X" e X era uma conta em aberto).
  | { type: "pay_bill"; billId: number; withEntry?: boolean }
  | { type: "cancel_bill"; billId: number }
  | { type: "cancel_event"; eventId: number }
  | { type: "cancel_reminder"; reminderId: number }
  | { type: "organize_tasks"; items: import("./gerenteOrganize").OrganizeItem[] }
  | { type: "send_client"; conversationId: number | null; phone: string; sessionKey: string | null; name: string; text: string; senderName: string };

async function setPending(tenantId: number, phone: string, action: PendingAction, summary: string): Promise<string> {
  await db.insert(gerentePendingActionsTable)
    .values({ tenantId, phone, action, summary, expiresAt: new Date(Date.now() + PENDING_TTL_MS) })
    .onConflictDoUpdate({ target: [gerentePendingActionsTable.tenantId, gerentePendingActionsTable.phone], set: { action, summary, expiresAt: new Date(Date.now() + PENDING_TTL_MS), createdAt: new Date() } });
  return `${summary}\nConfirma? Responda *sim* ou *não*.`;
}

/** Junta duplicadas e deixa o plano de arrumação esperando o "sim". */
export async function organizeTasksCommand(tenantId: number, phone: string): Promise<string> {
  const { mergeDuplicateTasks } = await import("./gerenteTaskOps");
  const { buildOrganizePlan, describePlan } = await import("./gerenteOrganize");
  const merged = await mergeDuplicateTasks(tenantId);
  const archived = merged.reduce((s, g) => s + g.archived.length, 0);
  const head = archived ? `🧹 Juntei ${archived} tarefa(s) duplicada(s).\n\n` : "";
  const items = await buildOrganizePlan(tenantId);
  if (!items.length) return `${head}${describePlan(items)}`;
  const action: PendingAction = { type: "organize_tasks", items };
  const summary = `Arrumar ${items.length} tarefa(s)`;
  const expiresAt = new Date(Date.now() + 2 * 3_600_000);
  await db.insert(gerentePendingActionsTable).values({ tenantId, phone, action, summary, expiresAt })
    .onConflictDoUpdate({ target: [gerentePendingActionsTable.tenantId, gerentePendingActionsTable.phone], set: { action, summary, expiresAt, createdAt: new Date() } });
  return `${head}${describePlan(items)}\n\nAplico? Responda *sim* ou *não*. (Dá pra ajustar uma por uma no *link*.)`;
}

async function resolvePending(tenantId: number, phone: string, yes: boolean): Promise<{ text: string; refs: MsgRef[] }> {
  const [p] = await db.select().from(gerentePendingActionsTable)
    .where(and(eq(gerentePendingActionsTable.tenantId, tenantId), eq(gerentePendingActionsTable.phone, phone))).limit(1);
  if (!p) return { text: yes ? "Não tenho nada aguardando confirmação. 👍" : "Certo, nada pendente.", refs: [] };
  await db.delete(gerentePendingActionsTable).where(eq(gerentePendingActionsTable.id, p.id));
  if (p.expiresAt.getTime() < Date.now()) return { text: "Essa confirmação expirou — me peça de novo, por favor.", refs: [] };
  if (!yes) return { text: "Ok, cancelado. Nada foi alterado.", refs: [] };
  const a = p.action as PendingAction;
  const one = (text: string, ...refs: MsgRef[]) => ({ text, refs });
  if (a.type === "pay_bill") {
    const [b] = await db.update(gerenteBillsTable).set({ status: "paga", paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(gerenteBillsTable.id, a.billId), eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"))).returning();
    if (!b) return one("Não achei mais essa conta em aberto.");
    const refs: MsgRef[] = [{ table: "bill_paid", id: b.id }];
    let extra = "";
    if (a.withEntry) {
      const e = await createEntry(tenantId, {
        kind: b.kind === "pagar" ? "gasto" : "receita", amountCents: b.amountCents, description: b.description,
        scope: b.scope === "pessoal" ? "pessoal" : "empresa", storeName: b.storeName,
      });
      if (e.ref) refs.push(e.ref);
      extra = `\n${e.text}`;
    }
    return { text: `✅ Baixa dada: *${b.description}* (${brl(b.amountCents)}).${extra}`, refs };
  }
  if (a.type === "cancel_bill") {
    const [b] = await db.update(gerenteBillsTable).set({ status: "cancelada", updatedAt: new Date() })
      .where(and(eq(gerenteBillsTable.id, a.billId), eq(gerenteBillsTable.tenantId, tenantId))).returning();
    return one(b ? `🗑️ Conta cancelada: *${b.description}*.` : "Não achei mais essa conta.");
  }
  if (a.type === "cancel_event") {
    const [e] = await db.update(gerenteEventsTable).set({ status: "cancelado", updatedAt: new Date() })
      .where(and(eq(gerenteEventsTable.id, a.eventId), eq(gerenteEventsTable.tenantId, tenantId))).returning();
    return one(e ? `🗑️ Compromisso cancelado: *${e.title}*.` : "Não achei mais esse compromisso.");
  }
  if (a.type === "send_client") {
    let ok = false;
    if (a.conversationId) {
      const { sendOutboundText } = await import("./outbound");
      ok = await sendOutboundText(a.conversationId, a.text, a.senderName);
    } else if (a.sessionKey) {
      ok = await sendRawWhatsAppText(a.phone, a.sessionKey, a.text);
    }
    return one(ok ? `✅ Enviado pra *${a.name}*${a.conversationId ? " (ficou registrado na conversa dele no atendimento)" : ""}.` : `⚠️ Não consegui enviar pra ${a.name} (linha desconectada?). Tente de novo ou mande pelo atendimento.`);
  }
  if (a.type === "organize_tasks") {
    const { applyOrganizePlan } = await import("./gerenteOrganize");
    const n = await applyOrganizePlan(tenantId, a.items);
    return one(`✅ Pronto! Arrumei ${n} tarefa(s): categorias e prazos novos aplicados. Pra ver: *link*.`);
  }
  if (a.type === "cancel_reminder") {
    const [r] = await db.update(gerenteRemindersTable).set({ status: "cancelado", updatedAt: new Date() })
      .where(and(eq(gerenteRemindersTable.id, a.reminderId), eq(gerenteRemindersTable.tenantId, tenantId))).returning();
    return one(r ? `🗑️ Lembrete cancelado: *${r.title}*.` : "Não achei mais esse lembrete.");
  }
  return one("Ok.");
}

// ─── Consultas ───────────────────────────────────────────────────────────────

function dayBounds(dateISO: string): { start: Date; end: Date } {
  const start = parseSpLocal(`${dateISO}T00:00`)!;
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

async function listAgenda(tenantId: number, days: number): Promise<string> {
  const { start } = dayBounds(spDateISO());
  const end = new Date(start.getTime() + days * 86_400_000);
  const rows = await db.select().from(gerenteEventsTable).where(and(
    eq(gerenteEventsTable.tenantId, tenantId), eq(gerenteEventsTable.status, "agendado"),
    gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, end), evScope(),
  )).orderBy(asc(gerenteEventsTable.startsAt)).limit(30);
  if (rows.length === 0) return days === 1 ? "📅 Nenhum compromisso hoje." : `📅 Nenhum compromisso nos próximos ${days} dias.`;
  return `📅 *Agenda${days === 1 ? " de hoje" : ` (${days} dias)`}:*\n` + rows.map((e) =>
    `• ${fmtWhen(e.startsAt)} — ${e.title}${e.location ? ` (${e.location})` : ""}${e.participants ? ` com ${e.participants}` : ""}`).join("\n");
}

async function listReminders(tenantId: number): Promise<string> {
  const rows = await db.select().from(gerenteRemindersTable).where(and(
    eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), remScope(),
  )).orderBy(asc(gerenteRemindersTable.dueAt)).limit(30);
  if (rows.length === 0) return "⏰ Nenhum lembrete pendente.";
  return "⏰ *Lembretes pendentes:*\n" + rows.map((r) => `• ${fmtWhen(r.dueAt)} — ${r.title}${r.urgent ? " ‼️" : ""}${r.sentAt ? " (já avisado)" : ""}`).join("\n");
}

async function listTasks(tenantId: number): Promise<string> {
  const rows = await db.select({
    id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, priority: tasksTable.priority, dueDate: tasksTable.dueDate,
  }).from(tasksTable).where(and(
    eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"),
  )).orderBy(sql`${tasksTable.dueDate} asc nulls last`, desc(tasksTable.id)).limit(25);
  if (rows.length === 0) return "📋 Nenhuma tarefa aberta no quadro.";
  const ids = rows.map((r) => r.id);
  const assignees = await db.select({ taskId: taskAssigneesTable.taskId, name: usersTable.name })
    .from(taskAssigneesTable).innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId))
    .where(inArray(taskAssigneesTable.taskId, ids));
  const byTask = new Map<number, string[]>();
  for (const a of assignees) byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a.name.split(" ")[0]!]);
  const now = Date.now();
  return "📋 *Tarefas abertas da equipe:*\n" + rows.map((t) => {
    const who = byTask.get(t.id)?.join(", ") ?? "sem responsável";
    const late = t.dueDate && t.dueDate.getTime() < now ? " ⚠️ atrasada" : "";
    return `• ${t.title} — ${who}${t.dueDate ? `, ${fmtWhen(t.dueDate)}` : ""}${t.status === "doing" ? " (em andamento)" : ""}${late}`;
  }).join("\n");
}

async function listBills(tenantId: number): Promise<string> {
  const rows = await db.select().from(gerenteBillsTable).where(and(
    eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"),
  )).orderBy(asc(gerenteBillsTable.dueDate)).limit(30);
  if (rows.length === 0) return "💳 Nenhuma conta em aberto.";
  const today = spDateISO();
  const fmt = (b: typeof rows[number]) => `• ${fmtDateISO(b.dueDate)} — ${b.description}: ${brl(b.amountCents)}${b.counterparty ? ` (${b.counterparty})` : ""}${b.dueDate < today ? " ⚠️ vencida" : ""}`;
  const pagar = rows.filter((b) => b.kind === "pagar");
  const receber = rows.filter((b) => b.kind === "receber");
  const parts: string[] = [];
  if (pagar.length) parts.push(`📤 *A pagar* (${brl(pagar.reduce((s, b) => s + b.amountCents, 0))}):\n${pagar.map(fmt).join("\n")}`);
  if (receber.length) parts.push(`📥 *A receber* (${brl(receber.reduce((s, b) => s + b.amountCents, 0))}):\n${receber.map(fmt).join("\n")}`);
  return parts.join("\n\n");
}

async function financeSummary(tenantId: number, month?: string | null): Promise<string> {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : spDateISO().slice(0, 7);
  const rows = await db.select().from(gerenteEntriesTable).where(and(
    eq(gerenteEntriesTable.tenantId, tenantId), sql`to_char(${gerenteEntriesTable.entryDate}, 'YYYY-MM') = ${m}`,
  )).orderBy(desc(gerenteEntriesTable.entryDate), desc(gerenteEntriesTable.id));
  const sum = (kind: string, scope?: string) => rows.filter((r) => r.kind === kind && (!scope || r.scope === scope)).reduce((s, r) => s + r.amountCents, 0);
  const gastos = sum("gasto"), receitas = sum("receita");
  const [y, mo] = m.split("-");
  const lines = [
    `💼 *Financeiro ${mo}/${y}:*`,
    `• Receitas: ${brl(receitas)} (empresa ${brl(sum("receita", "empresa"))} · pessoal ${brl(sum("receita", "pessoal"))})`,
    `• Gastos: ${brl(gastos)} (empresa ${brl(sum("gasto", "empresa"))} · pessoal ${brl(sum("gasto", "pessoal"))})`,
    `• Saldo: ${brl(receitas - gastos)}`,
  ];
  const byCat = new Map<string, number>();
  for (const r of rows.filter((r) => r.kind === "gasto")) byCat.set(r.category ?? "sem categoria", (byCat.get(r.category ?? "sem categoria") ?? 0) + r.amountCents);
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) lines.push(`• Maiores gastos: ${top.map(([c, v]) => `${c} ${brl(v)}`).join(", ")}`);
  const reimb = rows.filter((r) => r.reimbursementPending);
  if (reimb.length) lines.push(`• Reembolsos pendentes: ${reimb.length} (${brl(reimb.reduce((s, r) => s + r.amountCents, 0))})`);
  const last = rows.slice(0, 5);
  if (last.length) lines.push("Últimos: " + last.map((r) => `${r.kind === "gasto" ? "-" : "+"}${brl(r.amountCents)} ${r.description}`).join("; "));
  return lines.join("\n");
}

export async function buildDigest(tenantId: number): Promise<string> {
  const today = spDateISO();
  const { start, end } = dayBounds(today);
  const events = await db.select().from(gerenteEventsTable).where(and(
    eq(gerenteEventsTable.tenantId, tenantId), eq(gerenteEventsTable.status, "agendado"),
    gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, end), evScope(),
  )).orderBy(asc(gerenteEventsTable.startsAt)).limit(20);
  const reminders = await db.select().from(gerenteRemindersTable).where(and(
    eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end), remScope(),
  )).orderBy(asc(gerenteRemindersTable.dueAt)).limit(20);
  const tasks = await db.select({ id: tasksTable.id, title: tasksTable.title, dueDate: tasksTable.dueDate }).from(tasksTable).where(and(
    eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"), lt(tasksTable.dueDate, end),
  )).orderBy(asc(tasksTable.dueDate)).limit(20);
  const bills = isGestor() ? [] : await db.select().from(gerenteBillsTable).where(and(
    eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"), lte(gerenteBillsTable.dueDate, today),
  )).orderBy(asc(gerenteBillsTable.dueDate)).limit(20);

  const who = actorStore.getStore();
  const sections: string[] = [`☀️ *${who?.role === "gestor" ? `Dia de ${who.name.split(" ")[0]}` : "Meu dia"} — ${describeNow().split(",").slice(0, 2).join(",")}*`];
  sections.push(events.length ? `📅 *Compromissos:*\n${events.map((e) => `• ${spTimeHM(e.startsAt)} — ${e.title}${e.location ? ` (${e.location})` : ""}`).join("\n")}` : "📅 Sem compromissos hoje.");
  if (reminders.length) sections.push(`⏰ *Lembretes:*\n${reminders.map((r) => `• ${r.dueAt.getTime() < start.getTime() ? "atrasado" : spTimeHM(r.dueAt)} — ${r.title}`).join("\n")}`);
  if (tasks.length) sections.push(`📋 *Tarefas da equipe vencendo:*\n${tasks.map((t) => `• ${t.title}${t.dueDate && t.dueDate.getTime() < start.getTime() ? " ⚠️ atrasada" : ""}`).join("\n")}`);
  if (bills.length) sections.push(`💳 *Contas vencendo/vencidas:*\n${bills.map((b) => `• ${b.kind === "pagar" ? "pagar" : "receber"} ${brl(b.amountCents)} — ${b.description}${b.dueDate < today ? " ⚠️" : ""}`).join("\n")}`);
  if (!reminders.length && !tasks.length && !bills.length) sections.push("Nada pendente além disso. Bom dia! 💪");
  return sections.join("\n\n");
}

async function findClient(tenantId: number, name: string): Promise<string> {
  const q = name.trim().slice(0, 60);
  if (!q) return "Me diga o nome do cliente.";
  const contacts = await db.select().from(crmContactsTable).where(and(
    eq(crmContactsTable.tenantId, tenantId), ilike(crmContactsTable.name, `%${q}%`),
  )).orderBy(desc(crmContactsTable.id)).limit(3);
  if (contacts.length === 0) return `👤 Não achei nenhum cliente com "${q}" no CRM.`;
  const parts: string[] = [];
  for (const c of contacts) {
    const notes = await db.select().from(crmInternalNotesTable)
      .where(and(eq(crmInternalNotesTable.tenantId, tenantId), eq(crmInternalNotesTable.contactId, c.id)))
      .orderBy(desc(crmInternalNotesTable.createdAt)).limit(3);
    const variants = phoneVariants(c.phone ?? c.contact);
    const [conv] = variants.length ? await db.select({ lastMessage: conversationsTable.lastMessage, lastMessageAt: conversationsTable.lastMessageAt, status: conversationsTable.status })
      .from(conversationsTable).where(and(eq(conversationsTable.tenantId, tenantId), inArray(conversationsTable.phone, variants)))
      .orderBy(desc(conversationsTable.lastMessageAt)).limit(1) : [];
    const lines = [`👤 *${c.name}*${c.contact ? ` — ${c.contact}` : ""} · ${c.profile} · ${c.status}${c.serviceStore ? ` · ${c.serviceStore}` : ""}`];
    if (c.notes) lines.push(`Obs.: ${c.notes.slice(0, 200)}`);
    if (notes.length) lines.push(`Anotações: ${notes.map((n) => `"${n.content.slice(0, 120)}"${n.authorName ? ` (${n.authorName})` : ""}`).join(" | ")}`);
    if (conv?.lastMessageAt) lines.push(`Última conversa ${fmtWhen(conv.lastMessageAt)}: "${(conv.lastMessage ?? "").slice(0, 120)}"`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Acha o cliente (nome ou telefone) e a conversa dele no atendimento; deixa
 * a mensagem esperando o "sim" do dono/gestor. Sai pela linha da conversa
 * (a mesma que o cliente já usa) e fica registrada no atendimento.
 */
export async function prepareClientMessage(tenantId: number, phone: string, cliente: string, text: string): Promise<string> {
  if (!cliente || !text) return "Pra quem e o que eu mando? Ex.: *avisa o cliente João que o aparelho ficou pronto*.";
  const digits = cliente.replace(/\D/g, "");
  let name = cliente;
  let variants: string[] = [];
  if (digits.length >= 10) {
    variants = phoneVariants(digits);
  } else {
    const contacts = await db.select().from(crmContactsTable).where(and(eq(crmContactsTable.tenantId, tenantId), ilike(crmContactsTable.name, `%${cliente.slice(0, 60)}%`)))
      .orderBy(desc(crmContactsTable.id)).limit(5);
    if (contacts.length === 0) return `👤 Não achei o cliente "${cliente}" no CRM. Me mande o telefone dele.`;
    if (contacts.length > 1) return `Achei mais de um cliente:\n${contacts.map((c) => `• ${c.name}${c.contact ? ` — ${c.contact}` : ""}`).join("\n")}\nQual deles? Mande o nome completo ou o telefone.`;
    name = contacts[0]!.name;
    variants = phoneVariants(contacts[0]!.phone ?? contacts[0]!.contact);
  }
  if (!variants.length) return `O cadastro de ${name} não tem telefone. Me mande o número.`;
  const [conv] = await db.select({ id: conversationsTable.id, phone: conversationsTable.phone, sessionKey: conversationsTable.sessionKey, contactName: conversationsTable.name })
    .from(conversationsTable).where(and(eq(conversationsTable.tenantId, tenantId), inArray(conversationsTable.phone, variants)))
    .orderBy(desc(conversationsTable.lastMessageAt)).limit(1);
  const settings = await getGerenteSettings(tenantId);
  const [anyLine] = await db.select({ sessionKey: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, tenantId), eq(whatsappSessionsTable.status, "connected"), ...(settings.admSessionKey ? [ne(whatsappSessionsTable.sessionKey, settings.admSessionKey)] : []))).limit(1);
  const sessionKey = conv?.sessionKey ?? anyLine?.sessionKey ?? null;
  if (!conv && !sessionKey) return "Nenhuma linha da loja conectada pra enviar agora.";
  const displayName = conv?.contactName || name;
  const actor = actorStore.getStore();
  const senderName = actor?.name.split(" ")[0] ?? "Sheikcell";
  const [line] = sessionKey ? await db.select({ displayName: whatsappSessionsTable.displayName }).from(whatsappSessionsTable).where(eq(whatsappSessionsTable.sessionKey, sessionKey)).limit(1) : [];
  const action: PendingAction = { type: "send_client", conversationId: conv?.id ?? null, phone: conv?.phone ?? variants[0]!, sessionKey, name: displayName, text, senderName };
  return setPending(tenantId, phone, action, `📨 Mensagem pra *${displayName}* (${conv?.phone ?? variants[0]})${line?.displayName ? ` pela linha ${line.displayName}` : ""}:\n“${text}”`);
}

async function findBill(tenantId: number, query: string): Promise<typeof gerenteBillsTable.$inferSelect | null> {
  const rows = await db.select().from(gerenteBillsTable).where(and(
    eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"),
  )).orderBy(asc(gerenteBillsTable.dueDate)).limit(50);
  const q = norm(query);
  const hits = rows.filter((b) => norm(b.description).includes(q) || (b.counterparty && norm(b.counterparty).includes(q)));
  return hits.length === 1 ? hits[0]! : null;
}

// ─── IA (function-calling) ───────────────────────────────────────────────────

type ToolDef = {
  name: string; description: string; parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: { tenantId: number; phone: string; inMessageId: number }) => Promise<ActionResult>;
};

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const optStr = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const scopeArg = (v: unknown): "pessoal" | "empresa" => (v === "pessoal" ? "pessoal" : "empresa");

const GESTOR_BLOCKED_TOOLS = new Set(["lancar_gasto_ou_receita", "registrar_conta", "dar_baixa_conta"]);

const TOOLS: ToolDef[] = [
  {
    name: "criar_lembrete",
    description: "Cria um lembrete que será enviado ao dono pelo WhatsApp no horário.",
    parameters: { type: "object", properties: {
      titulo: { type: "string" }, quando: { type: "string", description: "Data e hora local em São Paulo: YYYY-MM-DDTHH:mm" },
      urgente: { type: "boolean" },
    }, required: ["titulo", "quando"] },
    run: async (a, ctx) => {
      const when = parseSpLocal(str(a["quando"]));
      if (!when) return { text: "Não entendi o horário do lembrete. Pode repetir com dia e hora?" };
      return createReminder(ctx.tenantId, { title: cleanTitle(str(a["titulo"], 200)), dueAt: when, urgent: a["urgente"] === true });
    },
  },
  {
    name: "lancar_gasto_ou_receita",
    description: "Registra um gasto (saída) ou uma receita (entrada) de dinheiro.",
    parameters: { type: "object", properties: {
      tipo: { type: "string", enum: ["gasto", "receita"] }, valor: { type: "number", description: "Valor em reais" },
      descricao: { type: "string" }, categoria: { type: "string" }, ambito: { type: "string", enum: ["pessoal", "empresa"] },
      loja: { type: "string" }, forma_pagamento: { type: "string" }, parcelas: { type: "integer" },
      reembolso_pendente: { type: "boolean" }, data: { type: "string", description: "YYYY-MM-DD (omitir = hoje)" },
    }, required: ["tipo", "valor", "descricao"] },
    run: async (a, ctx) => {
      const cents = typeof a["valor"] === "number" ? Math.round(a["valor"] * 100) : null;
      if (cents == null || cents <= 0) return { text: "Não entendi o valor. Pode repetir?" };
      return createEntry(ctx.tenantId, {
        kind: a["tipo"] === "receita" ? "receita" : "gasto", amountCents: cents, description: str(a["descricao"], 200) || (a["tipo"] === "receita" ? "Receita" : "Gasto"),
        category: optStr(a["categoria"], 60), scope: scopeArg(a["ambito"]), storeName: optStr(a["loja"], 60), paymentMethod: optStr(a["forma_pagamento"], 40),
        installments: typeof a["parcelas"] === "number" ? a["parcelas"] : 1, reimbursementPending: a["reembolso_pendente"] === true, entryDate: optStr(a["data"], 10),
      });
    },
  },
  {
    name: "registrar_conta",
    description: "Registra uma conta a pagar ou a receber com vencimento.",
    parameters: { type: "object", properties: {
      tipo: { type: "string", enum: ["pagar", "receber"] }, descricao: { type: "string" }, valor: { type: "number" },
      vencimento: { type: "string", description: "YYYY-MM-DD" }, contraparte: { type: "string", description: "De quem/para quem" },
      responsavel: { type: "string" }, ambito: { type: "string", enum: ["pessoal", "empresa"] }, loja: { type: "string" },
    }, required: ["tipo", "descricao", "valor", "vencimento"] },
    run: async (a, ctx) => {
      const cents = typeof a["valor"] === "number" ? Math.round(a["valor"] * 100) : null;
      if (cents == null || cents <= 0) return { text: "Não entendi o valor da conta." };
      return createBill(ctx.tenantId, {
        kind: a["tipo"] === "receber" ? "receber" : "pagar", description: str(a["descricao"], 200), amountCents: cents, dueDate: str(a["vencimento"], 10),
        counterparty: optStr(a["contraparte"], 120), responsible: optStr(a["responsavel"], 80), scope: scopeArg(a["ambito"]), storeName: optStr(a["loja"], 60),
      });
    },
  },
  {
    name: "dar_baixa_conta",
    description: "Marca uma conta em aberto como paga/recebida. Pede confirmação ao dono antes de efetivar.",
    parameters: { type: "object", properties: { descricao: { type: "string", description: "Palavras da descrição ou contraparte" } }, required: ["descricao"] },
    run: async (a, ctx) => {
      const b = await findBill(ctx.tenantId, str(a["descricao"], 100));
      if (!b) return { text: "Não achei uma única conta em aberto com essa descrição. Mande *contas* pra ver a lista." };
      return { text: await setPending(ctx.tenantId, ctx.phone, { type: "pay_bill", billId: b.id }, `Dar baixa em *${b.description}* (${brl(b.amountCents)}, vence ${fmtDateISO(b.dueDate)})?`) };
    },
  },
  {
    name: "criar_tarefa_equipe",
    description: "Cria UMA tarefa no quadro. Um assunto = uma tarefa: se várias pessoas fazem a mesma coisa, é UMA tarefa com vários responsáveis. Sem responsável = tarefa do próprio dono.",
    parameters: { type: "object", properties: {
      titulo: { type: "string", description: "Curto e claro, começando pelo verbo (ex.: Negociar taxa com Sicoob)" },
      responsaveis: { type: "array", items: { type: "string" }, description: "Nomes de quem da equipe vai fazer (vazio = o dono)" },
      prazo: { type: "string", description: "YYYY-MM-DDTHH:mm — só se ele disser um prazo" },
      prioridade: { type: "string", enum: ["baixa", "media", "alta"] },
      categoria: { type: "string", description: "Setor da tarefa — um dos setores listados nas instruções (ADM, Financeiro, RH, Compras, Comercial…)" },
      detalhes: { type: "string" },
    }, required: ["titulo"] },
    run: async (a, ctx) => createTask(ctx.tenantId, {
      title: cleanTitle(str(a["titulo"], 200)),
      assigneeNames: Array.isArray(a["responsaveis"]) ? (a["responsaveis"] as unknown[]).map((x) => str(x, 80)).filter(Boolean) : null,
      assigneeName: optStr(a["responsavel"], 80), dueAt: parseSpLocal(optStr(a["prazo"], 20)),
      priority: a["prioridade"] === "alta" ? "alta" : a["prioridade"] === "baixa" ? "baixa" : "media", description: optStr(a["detalhes"], 2000),
      category: optStr(a["categoria"], 40),
    }),
  },
  {
    name: "agendar_compromisso",
    description: "Agenda um compromisso (reunião, visita, consulta...) na agenda do dono.",
    parameters: { type: "object", properties: {
      titulo: { type: "string" }, inicio: { type: "string", description: "YYYY-MM-DDTHH:mm" }, fim: { type: "string", description: "YYYY-MM-DDTHH:mm" },
      local: { type: "string" }, participantes: { type: "string" }, ambito: { type: "string", enum: ["pessoal", "empresa"] },
      loja: { type: "string" }, observacoes: { type: "string" }, avisar_minutos_antes: { type: "integer" },
    }, required: ["titulo", "inicio"] },
    run: async (a, ctx) => {
      const startsAt = parseSpLocal(str(a["inicio"], 20));
      if (!startsAt) return { text: "Não entendi a data do compromisso. Pode repetir com dia e hora?" };
      return createEvent(ctx.tenantId, {
        title: cleanTitle(str(a["titulo"], 200)), startsAt, endsAt: parseSpLocal(optStr(a["fim"], 20)), location: optStr(a["local"], 200),
        participants: optStr(a["participantes"], 300), scope: scopeArg(a["ambito"]), storeName: optStr(a["loja"], 60), notes: optStr(a["observacoes"], 1000),
        remindMinutesBefore: typeof a["avisar_minutos_antes"] === "number" ? a["avisar_minutos_antes"] : 30,
      });
    },
  },
  {
    name: "consultar",
    description: "Consulta o que o dono tem registrado: resumo do dia, agenda, lembretes, tarefas da equipe, contas, financeiro do mês.",
    parameters: { type: "object", properties: {
      o_que: { type: "string", enum: ["meu_dia", "equipe", "agenda", "lembretes", "tarefas", "contas", "financeiro"], description: "meu_dia = resumo do dia; equipe = como está cada pessoa (abertas, atrasadas, foto pendente)" },
      dias: { type: "integer", description: "Para agenda: quantos dias à frente (padrão 7)" },
      mes: { type: "string", description: "Para financeiro: YYYY-MM (padrão: mês atual)" },
    }, required: ["o_que"] },
    run: async (a, ctx) => ({ text: await runQuery(ctx.tenantId, str(a["o_que"], 20) as QueryKind, { days: typeof a["dias"] === "number" ? a["dias"] : 7, month: optStr(a["mes"], 7) }) }),
  },
  {
    name: "buscar_cliente",
    description: "Busca um cliente no CRM pelo nome e devolve histórico, anotações e última conversa ('o que combinei com fulano').",
    parameters: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
    run: async (a, ctx) => ({ text: await findClient(ctx.tenantId, str(a["nome"], 60)) }),
  },
  {
    name: "concluir_lembrete",
    description: "Marca como feito o último lembrete avisado.",
    parameters: { type: "object", properties: {} },
    run: async (_a, ctx) => ({ text: await completeLastReminder(ctx.tenantId) }),
  },
  {
    name: "adiar_lembrete",
    description: "Adia o último lembrete avisado para um novo horário.",
    parameters: { type: "object", properties: { quando: { type: "string", description: "YYYY-MM-DDTHH:mm" }, minutos: { type: "integer" } } },
    run: async (a, ctx) => ({ text: await snoozeLastReminder(ctx.tenantId, typeof a["minutos"] === "number" ? a["minutos"] : null, parseSpLocal(optStr(a["quando"], 20))) }),
  },
  {
    name: "mandar_para_equipe",
    description: "Manda um recado pelo WhatsApp para pessoas da equipe ou para todos de uma loja, e/ou ENCAMINHA o que o dono acabou de mandar (contato, foto, documento, áudio, texto anterior). Use para: 'manda pro Alan…', 'avisa a Lu que…', 'fala pros meninos de SC…', 'encaminha isso pra Gabi', 'manda esse contato pra loja SC', ou quando o áudio do dono é claramente falado PARA alguém da equipe ('…, viu, Lu?').",
    parameters: { type: "object", properties: {
      pessoas: { type: "array", items: { type: "string" }, description: "Nomes ou apelidos (Lu, Gabi, Cris…). 'todos' = equipe inteira" },
      loja: { type: "string", description: "Quando for para todos de uma loja: PP, SJ, SC, São Cristóvão…" },
      mensagem: { type: "string", description: "O recado, na voz do dono, claro e direto (ex.: 'Manda o DVR de 8 canais pra distribuidora hoje'). Vazio se for só encaminhar." },
      encaminhar_anterior: { type: "boolean", description: "true quando ele diz 'isso', 'esse contato', 'essa foto', 'esse número' — encaminha a mensagem/anexo anterior (ou o anexo desta mensagem)" },
    } },
    run: async (a, ctx) => {
      const { sendToTeam, ownerItem } = await import("./gerenteComms");
      const names = Array.isArray(a["pessoas"]) ? (a["pessoas"] as unknown[]).map((x) => str(x, 60)).filter(Boolean) : [];
      const item = a["encaminhar_anterior"] === true ? await ownerItem(ctx.tenantId, ctx.phone, ctx.inMessageId, true) : await ownerItem(ctx.tenantId, ctx.phone, ctx.inMessageId, true).then((i) => (i && i.id === ctx.inMessageId ? i : null));
      return { text: await sendToTeam(ctx.tenantId, { names, loja: optStr(a["loja"], 40), message: optStr(a["mensagem"], 1500), item }) };
    },
  },
  {
    name: "mandar_para_cliente",
    description: "Prepara uma mensagem para um CLIENTE da loja (cadastro do CRM) e pede confirmação ao dono antes de enviar pelo WhatsApp da loja. Use para 'avisa o cliente João que o aparelho ficou pronto', 'manda pro cliente 33 98888-7777 que…'. Nunca use para a equipe.",
    parameters: { type: "object", properties: {
      cliente: { type: "string", description: "Nome do cliente ou telefone" },
      mensagem: { type: "string", description: "Texto final pro cliente, educado, curto, em nome da Sheikcell (ex.: 'Olá João! Seu iPhone 11 já está pronto para retirada na loja PP. 😊')" },
    }, required: ["cliente", "mensagem"] },
    run: async (a, ctx) => ({ text: await prepareClientMessage(ctx.tenantId, ctx.phone, str(a["cliente"], 80), str(a["mensagem"], 1500)) }),
  },
  {
    name: "enviar_link",
    description: "Manda o link (abre no celular, sem login) do painel de tarefas/dia do dono, ou de uma tarefa específica. Use sempre que ele pedir link, painel, acessar/ver as tarefas.",
    parameters: { type: "object", properties: { tarefa: { type: "integer", description: "Número da tarefa (omitir = painel completo)" } } },
    run: async (a, ctx) => {
      const { createLink } = await import("./gerenteExtras");
      const settings = await getGerenteSettings(ctx.tenantId);
      const id = typeof a["tarefa"] === "number" ? a["tarefa"] : null;
      if (id) return { text: `🔗 Tarefa ${id}:\n${await createLink(settings, "task", id, 30)}` };
      return { text: `🔗 Seu painel de tarefas:\n${await createLink(settings, "dia", null, 7)}` };
    },
  },
  {
    name: "desfazer_ultimo",
    description: "Desfaz o último registro criado (lembrete, lançamento, conta, compromisso ou tarefa). Use também quando o dono corrigir algo: desfaça e crie de novo com os dados certos.",
    parameters: { type: "object", properties: {} },
    run: async (_a, ctx) => ({ text: await undoLast(ctx.tenantId, ctx.phone) }),
  },
];

type QueryKind = "meu_dia" | "equipe" | "agenda" | "lembretes" | "tarefas" | "contas" | "financeiro";

async function runQuery(tenantId: number, what: QueryKind, opts: { days?: number; month?: string | null } = {}): Promise<string> {
  if (isGestor() && (what === "contas" || what === "financeiro")) return FIN_BLOCK;
  switch (what) {
    case "meu_dia": return buildDigest(tenantId);
    case "equipe": { const { teamStatus } = await import("./gerenteComms"); return teamStatus(tenantId); }
    case "agenda": return listAgenda(tenantId, Math.max(1, Math.min(60, opts.days ?? 7)));
    case "lembretes": return listReminders(tenantId);
    case "tarefas": return listTasks(tenantId);
    case "contas": return listBills(tenantId);
    case "financeiro": return financeSummary(tenantId, opts.month);
    default: return HELP_TEXT;
  }
}

async function sectorsForPrompt(tenantId: number): Promise<string> {
  const { getSectors } = await import("./gerenteSectors");
  const sectors = await getSectors(tenantId);
  const users = await teamUsers(tenantId);
  return sectors.map((s) => `${s.name}${s.responsibleIds.length ? ` (resp.: ${users.filter((u) => s.responsibleIds.includes(u.id)).map((u) => u.name.split(" ")[0]).join(", ")})` : ""}`).join(", ");
}

async function buildSystemPrompt(tenantId: number, settings: GerenteSettings): Promise<string> {
  const users = await teamUsers(tenantId);
  const stores = await db.select({ name: storesTable.name }).from(storesTable)
    .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true)));
  return [
    `Você é ${settings.assistantName}, secretária executiva e gerente geral do dono de uma loja de celulares, falando com ele pelo WhatsApp.`,
    ...(isGestor() ? [`Quem está falando agora NÃO é o dono: é ${actorStore.getStore()!.name}, gestor(a) da equipe. Ele(a) organiza tarefas, equipe, recados e clientes igual ao dono, tem agenda e lembretes próprios, mas NÃO tem acesso a financeiro, contas, ERP nem à agenda do dono. "Eu/minha tarefa" = tarefa dele(a).`] : []),
    `Agora é ${describeNow()} (fuso de São Paulo). Toda data/hora que você mandar nas ferramentas deve ser nesse fuso, formato YYYY-MM-DDTHH:mm. "Amanhã às 9" = o dia seguinte às 09:00. Sem hora explícita: lembrete/compromisso às 09:00; tarefa às 18:00. Nunca agende no passado — se a hora de hoje já passou, use amanhã.`,
    `Regra central: tudo que ele pede vira um registro com destino, responsável, prazo e acompanhamento. Use as ferramentas para registrar; nunca diga que registrou sem chamar a ferramenta. Uma mensagem pode ter mais de um pedido — chame uma ferramenta por pedido.`,
    `Equipe (para responsável de tarefa): ${users.length ? users.map((u) => `${u.name} (${u.role})`).join(", ") : "ninguém cadastrado"}.`,
    `Tarefas: nunca crie a mesma tarefa duas vezes nem uma tarefa por pessoa — várias pessoas na mesma coisa = UMA tarefa com vários responsáveis. Lista de itens diferentes (ex.: "letreiro PP, uniforme, curso de IA") = uma tarefa por item. Coisa que o próprio dono vai fazer = sem responsável. Sempre escolha o SETOR (campo categoria): ${await sectorsForPrompt(tenantId)}. Tarefa de um setor sem pessoa citada vai pros responsáveis do setor (não invente responsável). Prioridade alta só se ele disser urgente/hoje/importante. Não invente prazo.`,
    `Lojas: ${stores.length ? stores.map((s) => s.name).join(", ") : "sem cadastro"}. Âmbito "pessoal" só quando ele deixar claro que é da vida pessoal; o padrão é "empresa".`,
    `Valores em reais (ex.: "1.250,50" = 1250.50). Quando algo essencial faltar (valor, horário de lembrete/compromisso), pergunte de forma curta em vez de chutar.`,
    `Você PODE mandar links (enviar_link) e PODE mandar recados/encaminhar coisas para a equipe pelo WhatsApp (mandar_para_equipe). Nunca diga que não consegue mandar links ou mensagens.`,
    `Responsável x assunto: a pessoa só é RESPONSÁVEL quando ele pede que ela faça ("pede pro Alan…", "Alan tem que…", "tarefa pra Gabi…"). Se a pessoa é só o ASSUNTO ("ver por que a Gabi não voltou", "conversar com o Christian sobre…", "cobrar a Marcela"), a tarefa é DO DONO (sem responsável).`,
    `Cliente x equipe: "avisa o CLIENTE X…", "manda pro cliente…", um telefone de cliente ou alguém que não é da equipe = mandar_para_cliente (escreva a mensagem final educada em nome da Sheikcell; ela só sai depois do "sim"). Equipe = mandar_para_equipe.`,
    `Recado x tarefa: "avisa/fala/manda pro X que…" = mandar_para_equipe (recado). "tarefa pro X…", "pede pro X fazer…", "X precisa…" = criar_tarefa_equipe com responsável X (ela já vai pro WhatsApp dele). Não faça as duas coisas pro mesmo pedido.`,
    `Dado solto sem instrução (só um telefone, endereço, nome, contato ou link): não faça perguntas longas — responda numa linha oferecendo: mandar pra alguém (diga quem), virar tarefa ou lembrete.`,
    `IMPORTANTE: as mensagens anteriores da conversa JÁ foram atendidas. Aja SOMENTE sobre a última mensagem do dono; use o histórico só para entender referências ("isso", "ele", "o mesmo").`,
    `Se ele corrigir algo recém-registrado ("era 60, não 50"), use desfazer_ultimo e registre de novo com o dado certo. Quando ele perguntar algo, use consultar ou buscar_cliente. Respostas curtas, em português do Brasil, sem formalidade excessiva. Não invente informações.`,
  ].join("\n");
}

export async function loadHistory(tenantId: number, phone: string, beforeMessageId: number): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  // Só o que veio ANTES da mensagem atual (por id) — duas mensagens rápidas
  // do dono ou um aviso do agendador no meio não podem entrar como "atual".
  // Avisos do sistema ficam de fora: não são fala da IA nesta conversa.
  // As respostas da IA entram mesmo com id maior (resposta da mensagem
  // anterior gravada depois que esta chegou) — senão a mensagem anterior
  // parece sem resposta e a IA faz de novo (tarefa duplicada, resposta
  // trocada).
  const rows = await db.select({ id: gerenteMessagesTable.id, direction: gerenteMessagesTable.direction, content: gerenteMessagesTable.content })
    .from(gerenteMessagesTable)
    .where(and(
      eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.phone, phone), ne(gerenteMessagesTable.source, "sistema"),
      or(lt(gerenteMessagesTable.id, beforeMessageId), eq(gerenteMessagesTable.direction, "out")),
    ))
    .orderBy(desc(gerenteMessagesTable.id)).limit(HISTORY_LIMIT);
  // Ordem: cada resposta logo depois da pergunta que ela respondeu (as
  // respostas atrasadas vão pra antes da mensagem atual, que não está aqui).
  return rows.reverse().map((r) => ({ role: r.direction === "in" ? "user" : "assistant", content: r.content.slice(0, 1500) }) as OpenAI.Chat.Completions.ChatCompletionMessageParam);
}

async function runAi(tenantId: number, phone: string, settings: GerenteSettings, text: string, inMessageId: number): Promise<{ replies: string[]; refs: MsgRef[]; intents: string[] } | null> {
  const { getOpenAiClientForTenant } = await import("./aiClient");
  const openai = await getOpenAiClientForTenant(tenantId);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: await buildSystemPrompt(tenantId, settings) },
    ...(await loadHistory(tenantId, phone, inMessageId)),
    { role: "user", content: text.slice(0, 2000) },
  ];
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 400, messages,
    tools: TOOLS.filter((t) => !isGestor() || !GESTOR_BLOCKED_TOOLS.has(t.name)).map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: "auto",
  });
  const choice = completion.choices[0];
  const calls = (choice?.message?.tool_calls ?? []).filter((c) => c.type === "function");
  if (calls.length === 0) {
    const content = choice?.message?.content?.trim();
    return content ? { replies: [content], refs: [], intents: ["conversa"] } : null;
  }
  const replies: string[] = [];
  const refs: MsgRef[] = [];
  const intents: string[] = [];
  const seenCalls = new Set<string>();
  for (const call of calls) {
    const tool = TOOLS.find((t) => t.name === call.function.name);
    if (!tool) continue;
    // A IA às vezes repete a mesma chamada na mesma resposta (tarefa duplicada).
    let callKey = `${call.function.name}:${call.function.arguments ?? ""}`;
    try { const pa = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; if (typeof pa["titulo"] === "string") callKey = `${call.function.name}:${canonTitle(pa["titulo"] as string)}`; } catch { /* usa o texto cru */ }
    if (seenCalls.has(callKey)) continue;
    seenCalls.add(callKey);
    intents.push(tool.name);
    let args: Record<string, unknown> = {};
    try { args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}; } catch { args = {}; }
    try {
      const r = await tool.run(args, { tenantId, phone, inMessageId });
      replies.push(r.text);
      if (r.ref) refs.push(r.ref);
    } catch (err) {
      logger.warn({ err, tool: tool.name, tenantId }, "Gerente IA: falha ao executar ferramenta");
      replies.push(`Não consegui registrar (${tool.name.replace(/_/g, " ")}). Tente de novo em instantes.`);
    }
  }
  return { replies, refs, intents };
}

// ─── Fluxo principal ─────────────────────────────────────────────────────────

const queues = new Map<string, Promise<unknown>>();

export type GerenteInput = {
  tenantId: number; phone: string; sessionKey: string | null; text: string;
  source: "whatsapp" | "painel" | "chat"; inMessageId: number;
};

async function applyRule(intent: RuleIntent, tenantId: number, phone: string): Promise<{ replies: string[]; refs: MsgRef[] }> {
  const one = (text: string, ref?: MsgRef) => ({ replies: [text], refs: ref ? [ref] : [] });
  switch (intent.kind) {
    case "ajuda": return one(HELP_TEXT);
    case "confirmar": { const r = await resolvePending(tenantId, phone, intent.yes); return { replies: [r.text], refs: r.refs }; }
    case "feito": return one(await completeLastReminder(tenantId));
    case "adiar": return one(await snoozeLastReminder(tenantId, intent.minutes, intent.when));
    case "desfazer": return one(await undoLast(tenantId, phone));
    case "consultar": return one(await runQuery(tenantId, intent.what, { days: intent.what === "agenda" ? 7 : 1 }));
    case "lembrete": { const r = await createReminder(tenantId, { title: intent.title, dueAt: intent.dueAt, urgent: intent.urgent }); return one(r.text, r.ref); }
    case "gasto":
    case "receita": {
      // "paguei 1500 aluguel" com uma conta "aluguel" em aberto: é a quitação
      // dela, não um gasto solto — oferece a baixa (confirmação) e, no "sim",
      // lança o gasto junto. Sem conta correspondente, lançamento normal.
      const bill = await findBill(tenantId, intent.description);
      if (bill && bill.kind === (intent.kind === "gasto" ? "pagar" : "receber") && Math.abs(bill.amountCents - intent.amountCents) <= Math.max(100, Math.round(bill.amountCents * 0.02))) {
        return one(await setPending(tenantId, phone, { type: "pay_bill", billId: bill.id, withEntry: true },
          `Isso quita a conta *${bill.description}* (${brl(bill.amountCents)}, vence ${fmtDateISO(bill.dueDate)}). Dou baixa e lanço o ${intent.kind}?`));
      }
      const r = await createEntry(tenantId, { kind: intent.kind, amountCents: intent.amountCents, description: intent.description, scope: intent.scope }); return one(r.text, r.ref);
    }
    case "conta": { const r = await createBill(tenantId, { kind: intent.billKind, description: intent.description, amountCents: intent.amountCents, dueDate: intent.dueDate }); return one(r.text, r.ref); }
    case "tarefa": { const r = await createTask(tenantId, { title: intent.title, assigneeName: intent.assignee, dueAt: intent.dueAt, priority: intent.priority }); return one(r.text, r.ref); }
    case "compromisso": { const r = await createEvent(tenantId, { title: intent.title, startsAt: intent.startsAt, scope: intent.scope }); return one(r.text, r.ref); }
    default: return one(HELP_TEXT);
  }
}

/**
 * Processa UMA mensagem do dono (já gravada em gerente_messages como "in") e
 * devolve as respostas. Mensagens do mesmo telefone são processadas em ordem.
 * Quando source = whatsapp, também envia as respostas pelo bridge.
 */
export async function resolveActor(tenantId: number, phone: string): Promise<GerenteActor> {
  const m = memberForPhone(await activeMembers(tenantId), phone);
  if (m) return { role: "gestor", phone: normalizePhone(m.phone) ?? m.phone, name: m.name, userId: m.userId };
  const [u] = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin"))).orderBy(asc(usersTable.id)).limit(1);
  return { role: "dono", phone, name: u?.name.trim() ?? "Dono", userId: u?.id ?? null };
}

export async function handleGerenteText(input: GerenteInput): Promise<string[]> {
  const key = `${input.tenantId}:${input.phone}`;
  const prev = queues.get(key) ?? Promise.resolve();
  const actor = input.source === "whatsapp" || input.source === "chat" ? await resolveActor(input.tenantId, input.phone) : await resolveActor(input.tenantId, "");
  const next = prev.then(() => actorStore.run(actor, () => processOne(input))).catch((err): string[] => {
    logger.warn({ err, tenantId: input.tenantId }, "Gerente IA: falha ao processar mensagem");
    return ["Tive um problema aqui. Pode repetir? Se continuar, mande *ajuda*."];
  });
  queues.set(key, next);
  const replies = await next;
  if (queues.get(key) === next) queues.delete(key);
  return replies;
}

async function processOne(input: GerenteInput): Promise<string[]> {
  const { tenantId, phone, sessionKey, source } = input;
  const text = input.text.replace(/\s+/g, " ").trim();
  const settings = await getGerenteSettings(tenantId);

  let replies: string[] = [];
  let refs: MsgRef[] = [];
  let intents: string[] = [];

  // Documento do ERP esperando dado que faltou (valor/vencimento): esta
  // mensagem completa o pedido.
  const erpFill = await tryFillErpDoc(settings, phone, text, input.inMessageId);
  if (erpFill) {
    await saveRepliesAndSend(input, erpFill, ["erp_completar"], []);
    return erpFill;
  }

  // "tarefa do financeiro: pagar o contador até sexta" → setor (vai pros responsáveis dele).
  {
    const sm = text.match(/^(?:nova\s+)?tarefa\s+(?:do|da|pro|pra|para\s+o|para\s+a|no|na)\s+(?:setor\s+(?:de\s+|do\s+|da\s+)?)?([^:]{2,30}?)\s*:\s*(.{3,})$/i);
    if (sm) {
      const { findSector } = await import("./gerenteSectors");
      const sector = await findSector(tenantId, sm[1]);
      const isPerson = matchUser(await teamUsers(tenantId), sm[1]!);
      if (sector && !isPerson) {
        const { when, rest } = extractWhen(` ${sm[2]} `, new Date(), 18);
        const r = await createTask(tenantId, { title: cleanTitle(rest) || sm[2]!.trim(), dueAt: when, category: sector.name });
        await saveRepliesAndSend(input, [r.text], ["tarefa_setor"], r.ref ? [r.ref] : []);
        return [r.text];
      }
    }
  }

  // Ciência/prazo de tarefa entre gerentes ("ok 201", "prazo 201 sexta 15h").
  const ack = await tryAckCommand(tenantId, text);
  if (ack) {
    await saveRepliesAndSend(input, [ack], ["ciencia_tarefa"], []);
    return [ack];
  }

  // "é boleto"/"lança no ERP" logo depois de uma foto/PDF: manda aquele arquivo pro ERP.
  if (/^(e |é |eh )?(um |uma )?(boleto|comprovante|lanca(r)? no erp|lança(r)? no erp|manda(r)? pro erp)\b/i.test(text) && text.length < 60) {
    if (isGestor()) { await saveRepliesAndSend(input, [FIN_BLOCK], ["bloqueado_gestor"], []); return [FIN_BLOCK]; }
    const { ownerItem } = await import("./gerenteComms");
    const it = await ownerItem(tenantId, phone, input.inMessageId, false);
    if (it?.mediaUrl) {
      const r = await handleOwnerDocument(settings, phone, it.mediaUrl, text, input.inMessageId);
      await saveRepliesAndSend(input, r, ["erp_documento"], []);
      return r;
    }
  }
  // Resumo e status da equipe, em qualquer jeito de pedir.
  const nt = norm(text);
  if (nt.length <= 60 && /\b(resumo|como (esta|ta|tá) (a equipe|o pessoal|tudo)|status( da equipe)?|equipe hoje|situacao da equipe)\b/.test(nt) && !/\b(pr[oa]|manda)\b/.test(nt)) {
    const { teamStatus } = await import("./gerenteComms");
    const { createLink } = await import("./gerenteExtras");
    const wantsTeam = /equipe|pessoal|status/.test(nt) && !/resumo/.test(nt);
    const body = wantsTeam ? await teamStatus(tenantId) : `${await buildDigest(tenantId)}\n\n${await teamStatus(tenantId)}`;
    const r = `${body}\n\n🔗 Painel: ${await createLink(settings, "dia", null, 7)}`;
    await saveRepliesAndSend(input, [r], ["resumo"], []);
    return [r];
  }

  // Recados e encaminhamentos diretos ("avisa a Lu que…", "manda isso pro Alan").
  {
    const { tryDirectCommand } = await import("./gerenteComms");
    const direct = await tryDirectCommand(tenantId, phone, input.inMessageId, text);
    if (direct) {
      await saveRepliesAndSend(input, [direct], ["recado_equipe"], []);
      return [direct];
    }
  }

  // "arrumar tarefas": junta duplicadas e propõe categoria + prazo novo.
  if (/^(arrumar|arruma|organizar|organiza|organize|arrume)( as| minhas| todas as)? tarefas$/.test(norm(text))) {
    const r = await organizeTasksCommand(tenantId, phone);
    await saveRepliesAndSend(input, [r], ["arrumar_tarefas"], []);
    return [r];
  }

  // Tarefas da equipe por mensagem: concluir/ativar/reabrir/comentar/avisar.
  const { tryTaskCommand } = await import("./gerenteTaskOps");
  const taskCmd = await tryTaskCommand(tenantId, text);
  if (taskCmd) {
    await saveRepliesAndSend(input, [taskCmd], ["tarefa_equipe"], []);
    return [taskCmd];
  }

  // Links, rotinas, "mover", fechamento e relatório.
  const { tryExtraCommand } = await import("./gerenteExtras");
  const extra = await tryExtraCommand(settings, text);
  if (extra) {
    await saveRepliesAndSend(input, [extra], ["extra"], []);
    return [extra];
  }

  // Confirmação pendente: "sim/não" resolve antes de qualquer outra coisa.
  const rule = parseByRules(text);
  if (isGestor() && rule && (rule.kind === "gasto" || rule.kind === "receita" || rule.kind === "conta" || (rule.kind === "consultar" && (rule.what === "contas" || rule.what === "financeiro")))) {
    await saveRepliesAndSend(input, [FIN_BLOCK], ["bloqueado_gestor"], []);
    return [FIN_BLOCK];
  }

  // Linha ADM: conta, "paguei" e "recebi" vão pra fila de aprovação do ERP
  // em vez do controle local do Gerente.
  if (rule && sessionKey && settings.admSessionKey === sessionKey && (rule.kind === "conta" || rule.kind === "gasto" || rule.kind === "receita")
    && await (await import("./gerenteErp")).erpAgentConfigured(settings)) {
    const r = await erpFromRule(settings, phone, rule, text, input.inMessageId);
    if (r) {
      await saveRepliesAndSend(input, [r], [`erp_${rule.kind}`], []);
      return [r];
    }
  }
  // Pedido de busca de cliente é frequente e barato — regra própria.
  const client = !rule && !/\b(manda|mandar|envia|encaminha|avisa|pr[oa])\b/i.test(text) ? text.match(/^(?:o que (?:eu )?combinei com|cliente|busca(?:r)? cliente|quem [eé])\s+(?:(?:o|a)\s+)?(.+?)\??$/i) : null;

  if (rule) {
    const r = await applyRule(rule, tenantId, phone);
    replies = r.replies; refs = r.refs; intents = [rule.kind];
  } else if (client) {
    replies = [await findClient(tenantId, client[1]!)]; intents = ["buscar_cliente"];
  } else {
    let ai: Awaited<ReturnType<typeof runAi>> = null;
    try {
      ai = await runAi(tenantId, phone, settings, text, input.inMessageId);
    } catch (err) {
      logger.warn({ err, tenantId }, "Gerente IA: falha na IA");
    }
    if (ai) { replies = ai.replies; refs = ai.refs; intents = ai.intents; }
    else {
      // Sem IA: tenta pelo menos extrair um lembrete com horário.
      const { when, rest } = extractWhen(` ${text} `);
      const title = cleanTitle(rest);
      if (when && title) {
        const r = await createReminder(tenantId, { title, dueAt: when });
        replies = [r.text]; refs = r.ref ? [r.ref] : []; intents = ["lembrete"];
      } else {
        replies = ["Não entendi. 🤔 Mande *ajuda* pra ver exemplos do que eu faço."]; intents = ["nao_entendi"];
      }
    }
  }

  await saveRepliesAndSend(input, replies, intents, refs);
  return replies;
}

async function saveRepliesAndSend(input: GerenteInput, replies: string[], intents: string[], refs: MsgRef[]): Promise<void> {
  const { tenantId, phone, sessionKey, source } = input;
  await db.update(gerenteMessagesTable).set({ intent: intents.join(",").slice(0, 200) || null, payload: sql`coalesce(${gerenteMessagesTable.payload}, '{}'::jsonb) || ${JSON.stringify({ refs })}::jsonb` })
    .where(eq(gerenteMessagesTable.id, input.inMessageId));
  for (const r of replies) {
    await saveOut(tenantId, phone, sessionKey, r, source);
    if (source === "whatsapp" && sessionKey) {
      const ok = await sendRawWhatsAppText(phone, sessionKey, r);
      if (!ok) logger.warn({ tenantId, sessionKey }, "Gerente IA: bridge não aceitou o envio");
    }
  }
}

// ─── ERP (linha ADM e documentos) ────────────────────────────────────────────

type ErpDocPending = { type: "erp_doc"; erpType: string; payload: Record<string, unknown>; summary: string; mediaUrl: string | null; caption: string; missing: string[] };

async function erpFromRule(settings: GerenteSettings, phone: string, rule: RuleIntent, text: string, inMessageId: number): Promise<string | null> {
  const { submitErpAction } = await import("./gerenteErp");
  if (rule.kind === "conta") {
    const type = rule.billKind === "pagar" ? "CREATE_PAYABLE" as const : "CREATE_RECEIVABLE" as const;
    return submitErpAction(settings, {
      type, senderPhone: phone, messageText: text, sourceMessageId: inMessageId,
      summary: `${rule.description} · ${brl(rule.amountCents)} · vence ${fmtDateISO(rule.dueDate)}`,
      payload: { description: rule.description, totalAmount: rule.amountCents / 100, dueDate: rule.dueDate, paymentKind: "BOLETO" },
    });
  }
  if (rule.kind === "gasto" || rule.kind === "receita") {
    const type = rule.kind === "gasto" ? "SETTLE_PAYABLE" as const : "SETTLE_RECEIVABLE" as const;
    return submitErpAction(settings, {
      type, senderPhone: phone, messageText: text, sourceMessageId: inMessageId,
      summary: `${rule.description} · ${brl(rule.amountCents)} · pago ${fmtDateISO(spDateISO())}`,
      payload: { description: rule.description, amount: rule.amountCents / 100, amountPaid: rule.amountCents / 100, paidAt: spDateISO() },
    });
  }
  return null;
}

/** Foto/PDF do dono: lê boleto ou comprovante e manda pra fila do ERP. */
export async function handleOwnerDocument(settings: GerenteSettings, phone: string, mediaUrl: string, caption: string, inMessageId: number): Promise<string[]> {
  const erp = await import("./gerenteErp");
  if (!(await erp.erpAgentConfigured(settings))) {
    return ["Recebi o arquivo, mas ainda não estou ligado ao ERP pra lançar. Cole a chave do agente em Gerente IA → Configurações → ERP."];
  }
  const media = await erp.loadMedia(mediaUrl);
  if (!media) return ["Não consegui abrir esse arquivo. Mande como foto (JPG/PNG) ou PDF."];
  let doc: Awaited<ReturnType<typeof erp.readFinancialDoc>> = null;
  try { doc = await erp.readFinancialDoc(settings.tenantId, media, caption); } catch (err) { logger.warn({ err }, "Gerente IA: falha ao ler documento"); }
  if (!doc) return ["Não consegui ler o documento. Pode mandar de novo, mais nítido?"];
  const action = erp.actionFromDoc(doc, caption);
  if (!action) return [`Li o arquivo, mas não parece boleto nem comprovante${doc.descricao ? ` (${doc.descricao})` : ""}. Se for, me diga: *boleto*, *comprovante* ou *conta a receber*.`];
  if (action.missing.length) {
    const pending: ErpDocPending = { type: "erp_doc", erpType: action.type, payload: action.payload, summary: action.summary, mediaUrl, caption, missing: action.missing };
    await db.insert(gerentePendingActionsTable)
      .values({ tenantId: settings.tenantId, phone, action: pending, summary: action.summary, expiresAt: new Date(Date.now() + 60 * 60_000) })
      .onConflictDoUpdate({ target: [gerentePendingActionsTable.tenantId, gerentePendingActionsTable.phone], set: { action: pending, summary: action.summary, expiresAt: new Date(Date.now() + 60 * 60_000), createdAt: new Date() } });
    return [`Li: ${action.summary}
Faltou: *${action.missing.join(" e ")}*. Me responde (ex.: *350,00 vence 25/10*).`];
  }
  return [await erp.submitErpAction(settings, { type: action.type, payload: action.payload, summary: action.summary, senderPhone: phone, messageText: caption || action.summary, attachment: media, sourceMessageId: inMessageId })];
}

async function tryFillErpDoc(settings: GerenteSettings, phone: string, text: string, inMessageId: number): Promise<string[] | null> {
  const [p] = await db.select().from(gerentePendingActionsTable)
    .where(and(eq(gerentePendingActionsTable.tenantId, settings.tenantId), eq(gerentePendingActionsTable.phone, phone))).limit(1);
  const a = p?.action as ErpDocPending | undefined;
  if (!p || a?.type !== "erp_doc") return null;
  if (p.expiresAt.getTime() < Date.now()) { await db.delete(gerentePendingActionsTable).where(eq(gerentePendingActionsTable.id, p.id)); return null; }
  if (/^(nao|não|cancela|esquece)\b/i.test(text)) {
    await db.delete(gerentePendingActionsTable).where(eq(gerentePendingActionsTable.id, p.id));
    return ["Ok, descartei esse documento."];
  }
  const payload = { ...a.payload };
  const money = text.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})|\d+(?:[.,]\d{1,2})?)/i);
  const { when } = extractWhen(` ${text} `);
  const isSettle = a.erpType.startsWith("SETTLE");
  if (a.missing.includes("valor") && money) {
    const cents = parseBRLText(money[1]!);
    if (cents) { if (isSettle) { payload["amount"] = cents / 100; payload["amountPaid"] = cents / 100; } else payload["totalAmount"] = cents / 100; }
  }
  if (a.missing.includes("vencimento") && when) payload["dueDate"] = spDateISO(when);
  const still = a.missing.filter((m) => (m === "valor" ? !(payload["totalAmount"] ?? payload["amountPaid"]) : m === "vencimento" ? !payload["dueDate"] : true));
  if (still.length) return [`Ainda falta: *${still.join(" e ")}*. Ex.: *350,00 vence 25/10* (ou *não* pra descartar).`];
  await db.delete(gerentePendingActionsTable).where(eq(gerentePendingActionsTable.id, p.id));
  const erp = await import("./gerenteErp");
  const media = a.mediaUrl ? await erp.loadMedia(a.mediaUrl) : null;
  const summary = `${a.summary}${payload["totalAmount"] ? ` · ${brl(Math.round(Number(payload["totalAmount"]) * 100))}` : ""}${payload["dueDate"] ? ` · vence ${fmtDateISO(String(payload["dueDate"]))}` : ""}`;
  return [await erp.submitErpAction(settings, { type: a.erpType as never, payload, summary, senderPhone: phone, messageText: a.caption || summary, attachment: media, sourceMessageId: inMessageId })];
}

// ─── Entrada pelo WhatsApp (chamada pelo webhook) ────────────────────────────

/**
 * Se a mensagem vier de um número autorizado do Gerente IA, consome aqui e
 * devolve true — ela NÃO deve virar conversa/ticket de atendimento. Barato
 * pra todo mundo que não é o dono: uma leitura cacheada por loja.
 */
export async function tryConsumeGerenteInbound(input: {
  tenantId: number; sessionKey: string; phone: string; text: string; msgType: string;
  mediaUrl: string | null; externalId: string | null;
}): Promise<boolean> {
  // Reconhecimento (barato, cacheado): qualquer erro aqui = não é o dono,
  // segue o fluxo normal.
  let authorized = false;
  let isMemberMsg = false;
  try {
    const { settings, moduleOn, members } = await cachedContext(input.tenantId);
    // Cadastrado como gestor = regras de gestor, mesmo se o número também estiver
    // na lista do dono (senão teria acesso ao financeiro/ERP do dono).
    isMemberMsg = !!memberForPhone(members, input.phone);
    authorized = moduleOn && settings.enabled && (isAuthorizedPhone(settings, input.phone) || isMemberMsg);
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "Gerente IA: falha ao avaliar mensagem recebida");
    return false;
  }
  if (!authorized) return false;

  // Gestor que também é vendedor (ex.: Lucelia): "1 149", "feito" + foto da
  // tarefa DELE continuam valendo como resposta de tarefa.
  if (isMemberMsg) {
    try {
      const { tryConsumeTaskProof } = await import("./gerenteDispatch");
      if (await tryConsumeTaskProof({ tenantId: input.tenantId, sessionKey: input.sessionKey, phone: input.phone, text: input.text, msgType: input.msgType, mediaUrl: input.mediaUrl })) return true;
    } catch { /* segue pro Gerente */ }
  }

  // Só a linha do Gerente (ADM) atende o dono. Nas outras linhas a mensagem
  // dele segue o fluxo normal (atendimento) e ele recebe, no máx. 1x a cada
  // 6h, um aviso pela linha ADM dizendo onde falar com o Gerente.
  try {
    const { settings } = await cachedContext(input.tenantId);
    const line = await gerenteLine(settings);
    if (line && input.sessionKey !== line) {
      const key = `${input.tenantId}`;
      const last = otherLineTips.get(key) ?? 0;
      if (Date.now() - last > 6 * 3_600_000) {
        otherLineTips.set(key, Date.now());
        const phone = normalizePhone(input.phone);
        if (phone) void sendRawWhatsAppText(phone, line, "📌 O Gerente IA agora atende só por *este número (ADM)*. A mensagem que você mandou na outra linha foi pro atendimento normal — pra tarefas, recados e resumo, fale comigo aqui.");
      }
      return false;
    }
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "Gerente IA: falha ao checar a linha do Gerente");
  }

  // Daqui pra frente a mensagem É do dono: erro = descarta e loga, NUNCA
  // devolve false — senão a mensagem pessoal dele vira atendimento e a
  // equipe vê.
  try {
    const phone = normalizePhone(input.phone);
    const isAudio = input.msgType === "audio" && !!input.mediaUrl;
    const text = input.text.trim();
    const content = text || (isAudio ? "🎵 Áudio" : `(${input.msgType})`);

    const [saved] = await db.insert(gerenteMessagesTable).values({
      tenantId: input.tenantId, phone, sessionKey: input.sessionKey, direction: "in", source: "whatsapp",
      content, externalId: input.externalId,
      payload: input.mediaUrl || input.msgType === "contact" || input.msgType === "location" ? { mediaUrl: input.mediaUrl, msgType: input.msgType } : null,
    }).onConflictDoNothing().returning();
    if (!saved) return true; // reentrega da mesma mensagem — já tratada
    void import("./gerenteInternal").then((m) => m.mirrorToGerenteRoom(input.tenantId, "in", content, isMemberMsg ? phone : null)).catch(() => undefined);

    // Só o dono define por onde os avisos DELE saem (o gestor não muda isso).
    if (!isMemberMsg) {
      await db.update(gerenteSettingsTable).set({ lastSessionKey: input.sessionKey, lastPhone: phone, updatedAt: new Date() })
        .where(eq(gerenteSettingsTable.tenantId, input.tenantId));
      invalidateGerenteCache(input.tenantId);
    }

    void (async () => {
      const say = async (msg: string) => { await saveOut(input.tenantId, phone, input.sessionKey, msg, "whatsapp"); await sendRawWhatsAppText(phone, input.sessionKey, msg); };
      // Contato/localização compartilhado sem pedido: guarda e pergunta pra quem vai.
      if ((input.msgType === "contact" || input.msgType === "location") && !/\b(pr[oa]|para|manda|avisa|encaminha)\b/i.test(text.replace(/^👤.*$|^📍.*$/gm, ""))) {
        await db.update(gerenteMessagesTable).set({ intent: "anexo_recebido" }).where(eq(gerenteMessagesTable.id, saved.id));
        await say(`${input.msgType === "contact" ? "📇 Recebi o contato" : "📍 Recebi a localização"}. Pra quem eu mando? Ex.: *manda pro Alan* ou *manda pra loja SC*.`);
        return;
      }
      // Foto/PDF: boleto/comprovante vai pro ERP; com pedido na legenda
      // ("manda pro Alan") é encaminhado; sem nada, pergunta o que fazer.
      if ((input.msgType === "image" || input.msgType === "doc") && input.mediaUrl) {
        const settingsNow = await getGerenteSettings(input.tenantId);
        const erpOn = await (await import("./gerenteErp")).erpAgentConfigured(settingsNow);
        const financial = !isMemberMsg && /\b(boleto|comprovante|pagar|paguei|pago|conta|nota|fatura|pix|recibo)\b/i.test(text);
        const isAdm = !isMemberMsg && erpOn && !!settingsNow.admSessionKey && settingsNow.admSessionKey === input.sessionKey;
        if (!(isAdm || financial || (erpOn && !text && !isMemberMsg))) {
          if (!text) {
            await db.update(gerenteMessagesTable).set({ intent: "anexo_recebido" }).where(eq(gerenteMessagesTable.id, saved.id));
            await say(`📎 Recebi ${input.msgType === "image" ? "a foto" : "o arquivo"}. O que eu faço?\n• *manda pro Alan* / *manda pra loja SC*\n• *tarefa pro …* com isso\n• *é boleto* (lança no ERP)`);
            return;
          }
          await handleGerenteText({ tenantId: input.tenantId, phone, sessionKey: input.sessionKey, text: `${text}\n[o dono anexou ${input.msgType === "image" ? "uma foto" : "um arquivo"} nesta mensagem]`, source: "whatsapp", inMessageId: saved.id });
          return;
        }
        const replies = await handleOwnerDocument(settingsNow, phone, input.mediaUrl, text, saved.id);
        await db.update(gerenteMessagesTable).set({ intent: "erp_documento" }).where(eq(gerenteMessagesTable.id, saved.id));
        for (const r of replies) { await saveOut(input.tenantId, phone, input.sessionKey, r, "whatsapp"); await sendRawWhatsAppText(phone, input.sessionKey, r); }
        return;
      }
      let body = text;
      if (!body && isAudio) {
        try {
          const { transcribeAudioFile } = await import("./transcribe");
          body = await transcribeAudioFile(input.mediaUrl!, input.tenantId);
          await db.update(gerenteMessagesTable).set({ content: `🎵 ${body}` }).where(eq(gerenteMessagesTable.id, saved.id));
        } catch (err) {
          logger.warn({ err }, "Gerente IA: falha ao transcrever áudio");
          const msg = "Não consegui entender o áudio. Pode mandar em texto?";
          await saveOut(input.tenantId, phone, input.sessionKey, msg, "whatsapp");
          await sendRawWhatsAppText(phone, input.sessionKey, msg);
          return;
        }
      }
      if (!body) {
        const msg = "Por enquanto só entendo texto e áudio. 🙂";
        await saveOut(input.tenantId, phone, input.sessionKey, msg, "whatsapp");
        await sendRawWhatsAppText(phone, input.sessionKey, msg);
        return;
      }
      await handleGerenteText({ tenantId: input.tenantId, phone, sessionKey: input.sessionKey, text: body, source: "whatsapp", inMessageId: saved.id });
    })().catch((err) => logger.warn({ err }, "Gerente IA: falha no processamento assíncrono"));

    return true;
  } catch (err) {
    logger.error({ err, tenantId: input.tenantId }, "Gerente IA: falha ao tratar mensagem do dono (descartada, não vira atendimento)");
    return true;
  }
}

/** Sala "🤖 Gerente IA" do chat interno: mesma interpretação; a resposta volta no chat. */
export async function handleChatMessage(tenantId: number, text: string, gestorPhone: string | null = null): Promise<string[]> {
  const settings = await getGerenteSettings(tenantId);
  const phone = gestorPhone ?? settings.lastPhone ?? settings.authorizedPhones[0] ?? "chat";
  const [saved] = await db.insert(gerenteMessagesTable).values({
    tenantId, phone, sessionKey: null, direction: "in", source: "chat", content: text.trim().slice(0, 2000),
  }).returning();
  return handleGerenteText({ tenantId, phone, sessionKey: null, text, source: "chat", inMessageId: saved!.id });
}

/** Caixa de conversa do painel: mesma interpretação, sem passar pelo WhatsApp. */
export async function handlePanelMessage(tenantId: number, text: string): Promise<{ replies: string[] }> {
  const settings = await getGerenteSettings(tenantId);
  const phone = settings.lastPhone ?? settings.authorizedPhones[0] ?? "painel";
  const [saved] = await db.insert(gerenteMessagesTable).values({
    tenantId, phone, sessionKey: null, direction: "in", source: "painel", content: text.trim().slice(0, 2000),
  }).returning();
  const replies = await handleGerenteText({ tenantId, phone, sessionKey: null, text, source: "painel", inMessageId: saved!.id });
  return { replies };
}

// ─── Avisos proativos (job periódico) ────────────────────────────────────────

/**
 * Manda um aviso pro dono: primeiro pela última linha por onde ele falou;
 * se o bridge recusar (linha caiu), tenta as outras linhas conectadas da
 * loja. Só grava no histórico quando o envio foi aceito — senão a aba
 * Conversar vira uma parede de avisos que nunca chegaram.
 */
/**
 * Linha do Gerente: com a linha ADM escolhida E conectada, o Gerente só
 * atende e só envia por ela. Sem ADM (ou ADM caída) = comportamento antigo
 * (qualquer linha), pra nenhum aviso se perder.
 */
export async function gerenteLine(settings: Pick<GerenteSettings, "tenantId" | "admSessionKey">): Promise<string | null> {
  if (!settings.admSessionKey) return null;
  const [s] = await db.select({ status: whatsappSessionsTable.status }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, settings.tenantId), eq(whatsappSessionsTable.sessionKey, settings.admSessionKey))).limit(1);
  return s?.status === "connected" ? settings.admSessionKey : null;
}

export async function notifyOwner(settings: GerenteSettings, text: string): Promise<boolean> {
  const phone = settings.lastPhone ?? settings.authorizedPhones[0];
  const preferred = (await gerenteLine(settings)) ?? settings.lastSessionKey;
  if (!phone || !preferred) return false;
  const others = await db.select({ sessionKey: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, settings.tenantId), eq(whatsappSessionsTable.status, "connected")));
  const candidates = [preferred, ...others.map((o) => o.sessionKey).filter((k) => k !== preferred)];
  for (const sessionKey of candidates) {
    if (await sendRawWhatsAppText(phone, sessionKey, text)) {
      await saveOut(settings.tenantId, phone, sessionKey, text, "sistema");
      return true;
    }
  }
  logger.warn({ tenantId: settings.tenantId }, "Gerente IA: nenhuma linha aceitou o aviso");
  return false;
}

/** Link do painel do gestor (sem contas/agenda do dono) + texto pronto pra mandar. */
export async function gestorLinkMessage(settings: GerenteSettings, m: GerenteMember, days = 30): Promise<{ url: string; text: string }> {
  const { createLink } = await import("./gerenteExtras");
  const url = await createLink(settings, "dia", null, days, true, m.userId ?? -1);
  const first = m.name.trim().split(" ")[0];
  return { url, text: `🔗 *${first}, seu painel de tarefas do Gerente IA:*\n${url}\n\nAbre no celular sem login: Kanban, tarefas da equipe, criar e distribuir tarefas, comentar e concluir.\nAqui neste número você também fala com o Gerente — mande *ajuda* pra ver tudo. Pra um link novo: *link*.` };
}

/** Bom dia dos gestores (1x/dia): o dia dele, a equipe e o link do painel. */
async function sendGestorDigests(settings: GerenteSettings, today: string): Promise<number> {
  const { gerenteTeamDigestsTable } = await import("@workspace/db");
  const { teamStatus } = await import("./gerenteComms");
  const { createLink } = await import("./gerenteExtras");
  let n = 0;
  for (const m of await activeMembers(settings.tenantId)) {
    if (!m.userId) continue;
    const ins = await db.insert(gerenteTeamDigestsTable).values({ tenantId: settings.tenantId, userId: m.userId, kind: "gestor", day: today }).onConflictDoNothing().returning();
    if (!ins.length) continue;
    const phone = normalizePhone(m.phone) ?? m.phone;
    const actor: GerenteActor = { role: "gestor", phone, name: m.name, userId: m.userId };
    const body = await actorStore.run(actor, async () => `${await buildDigest(settings.tenantId)}\n\n${await teamStatus(settings.tenantId)}`);
    const url = await createLink(settings, "dia", null, 2, true, m.userId);
    if (await notifyPhone(settings, phone, `${body}\n\n🔗 Seu painel: ${url}`)) n++;
  }
  return n;
}

/** Aviso pra outro número com acesso (gestor), pela linha do Gerente. */
export async function notifyPhone(settings: GerenteSettings, phone: string, text: string): Promise<boolean> {
  const preferred = (await gerenteLine(settings)) ?? settings.lastSessionKey;
  const others = await db.select({ sessionKey: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, settings.tenantId), eq(whatsappSessionsTable.status, "connected")));
  const candidates = [preferred, ...others.map((o) => o.sessionKey).filter((k) => k !== preferred)].filter((k): k is string => !!k);
  for (const sessionKey of candidates) {
    if (await sendRawWhatsAppText(phone, sessionKey, text)) {
      await saveOut(settings.tenantId, phone, sessionKey, text, "sistema");
      return true;
    }
  }
  return false;
}

/**
 * Avisos da EQUIPE (concluiu, adiou, dúvida, cobrança, mensagem no chat):
 * vão pro dono e pra todos os gestores — os dois organizam as tarefas.
 */
export async function notifyTeamLeads(tenantId: number, text: string, opts: { skipUserId?: number | null } = {}): Promise<boolean> {
  const settings = await getGerenteSettings(tenantId);
  if (!settings.enabled) return false;
  let ok = await notifyOwner(settings, text);
  // Não avisa o próprio gestor sobre o que ele mesmo fez/escreveu.
  for (const m of await activeMembers(tenantId)) {
    if (opts.skipUserId && m.userId === opts.skipUserId) continue;
    ok = (await notifyPhone(settings, normalizePhone(m.phone) ?? m.phone, text)) || ok;
  }
  return ok;
}

/** Aviso ao dono a partir só do tenant (usado pelas tarefas da equipe). */
export async function notifyOwnerByTenant(tenantId: number, text: string): Promise<boolean> {
  const settings = await getGerenteSettings(tenantId);
  if (!settings.enabled) return false;
  return notifyOwner(settings, text);
}

const otherLineTips = new Map<string, number>();

// Uma rodada por vez: com o bridge lento (timeout de 60 s por envio) a rodada
// pode passar de 1 min, e a seguinte reenviaria os mesmos lembretes.
let notificationsRunning = false;

/**
 * Roda a cada minuto: lembretes vencidos, compromissos chegando e o resumo
 * do dia. Horário de descanso segura o que não é urgente. Cada loja isolada
 * em try/catch — uma falha nunca trava as outras.
 */
export async function runGerenteNotifications(): Promise<{ sent: number }> {
  if (notificationsRunning) return { sent: 0 };
  notificationsRunning = true;
  try {
    return await runNotificationsOnce();
  } finally {
    notificationsRunning = false;
  }
}

async function runNotificationsOnce(): Promise<{ sent: number }> {
  let sent = 0;
  const now = new Date();
  const hm = spTimeHM(now);
  const today = spDateISO(now);
  const all = await db.select().from(gerenteSettingsTable).where(eq(gerenteSettingsTable.enabled, true));
  for (const settings of all) {
    try {
      if (!settings.lastSessionKey || settings.authorizedPhones.length === 0) continue;
      const { moduleOn } = await cachedContext(settings.tenantId);
      if (!moduleOn) continue;
      const quiet = withinRange(hm, settings.quietStart, settings.quietEnd);

      const due = await db.select().from(gerenteRemindersTable).where(and(
        eq(gerenteRemindersTable.tenantId, settings.tenantId), eq(gerenteRemindersTable.status, "pendente"),
        isNull(gerenteRemindersTable.sentAt), lte(gerenteRemindersTable.dueAt, now),
      )).orderBy(asc(gerenteRemindersTable.dueAt)).limit(10);
      for (const r of due) {
        if (quiet && !r.urgent) continue;
        const msg = `⏰ *Lembrete${r.urgent ? " urgente" : ""}:* ${r.title}\nResponda *feito* ou *adia 1h*.`;
        const ok = r.memberPhone ? await notifyPhone(settings, r.memberPhone, msg) : await notifyOwner(settings, msg);
        if (ok) { await db.update(gerenteRemindersTable).set({ sentAt: now, updatedAt: now }).where(eq(gerenteRemindersTable.id, r.id)); sent++; }
      }

      const soon = await db.select().from(gerenteEventsTable).where(and(
        eq(gerenteEventsTable.tenantId, settings.tenantId), eq(gerenteEventsTable.status, "agendado"),
        isNull(gerenteEventsTable.remindedAt),
        lte(sql`${gerenteEventsTable.startsAt} - make_interval(mins => ${gerenteEventsTable.remindMinutesBefore})`, now),
        gte(gerenteEventsTable.startsAt, new Date(now.getTime() - 60 * 60_000)),
      )).limit(10);
      for (const e of soon) {
        const mins = Math.max(0, Math.round((e.startsAt.getTime() - now.getTime()) / 60_000));
        const msg = `📅 *${mins > 0 ? `Em ${mins} min` : "Agora"}:* ${e.title}${e.location ? ` — ${e.location}` : ""}${e.participants ? ` (com ${e.participants})` : ""}`;
        const ok = e.memberPhone ? await notifyPhone(settings, e.memberPhone, msg) : await notifyOwner(settings, msg);
        if (ok) { await db.update(gerenteEventsTable).set({ remindedAt: now, updatedAt: now }).where(eq(gerenteEventsTable.id, e.id)); sent++; }
      }

      try {
        const ex = await import("./gerenteExtras");
        sent += await ex.runRecurrences(settings);
        if (!quiet) sent += await ex.runSummaries(settings, (t) => notifyOwner(settings, t));
      } catch (err) {
        logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: falha nas rotinas/resumos");
      }

      try {
        const { pollErpActions } = await import("./gerenteErp");
        sent += await pollErpActions(settings, (t) => notifyOwner(settings, t));
      } catch (err) {
        logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: falha ao acompanhar pedidos do ERP");
      }

      try {
        const { runTaskOverdueChecks, runTeamDigests } = await import("./gerenteDispatch");
        sent += await runTaskOverdueChecks(settings.tenantId);
        if (!quiet) sent += await runTeamDigests(settings, now);
        if (!quiet) { const { runChatFollowups } = await import("./gerenteInternal"); sent += await runChatFollowups(settings.tenantId, now); }
        if (!quiet) sent += await runAckReminders(settings.tenantId, now);
      } catch (err) {
        logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: falha ao checar tarefas atrasadas");
      }

      if (settings.dailyDigestTime && settings.dailyDigestSentOn !== today && hm >= settings.dailyDigestTime && !quiet) {
        const { createLink } = await import("./gerenteExtras");
        const ok = await notifyOwner(settings, `${await buildDigest(settings.tenantId)}\n\n🔗 Abrir no celular: ${await createLink(settings, "dia", null, 2)}`);
        if (ok) { await db.update(gerenteSettingsTable).set({ dailyDigestSentOn: today, updatedAt: now }).where(eq(gerenteSettingsTable.id, settings.id)); sent++; }
      }
      // Gestores: resumo do dia DELES + equipe + link novo do painel (sem contas do dono).
      if (settings.dailyDigestTime && hm >= settings.dailyDigestTime && !quiet) sent += await sendGestorDigests(settings, today);
    } catch (err) {
      logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: falha nos avisos");
    }
  }
  return { sent };
}
