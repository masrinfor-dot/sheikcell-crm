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
import { and, eq, desc, asc, gte, lte, lt, isNull, isNotNull, inArray, ilike, ne, sql } from "drizzle-orm";
import {
  db,
  gerenteSettingsTable, gerenteMessagesTable, gerenteEventsTable, gerenteRemindersTable,
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

type SettingsCacheEntry = { at: number; settings: GerenteSettings; moduleOn: boolean };
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
  const entry = { at: now, settings, moduleOn };
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
    .values({ tenantId, title: p.title.slice(0, 200), dueAt: p.dueAt, urgent: !!p.urgent }).returning();
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
  // Sem responsável = tarefa do dono ("Minhas"), nunca solta no quadro.
  const assignees = matched.length ? matched : owner ? [{ id: owner, name: users.find((u) => u.id === owner)?.name ?? "Você" }] : [];
  const category = p.category && p.category.trim() ? p.category.trim().slice(0, 40) : null;
  const [t] = await db.insert(tasksTable).values({
    tenantId, title: p.title.slice(0, 200), description: p.description?.slice(0, 2000) ?? null,
    priority: p.priority ?? "media", dueDate: p.dueAt ?? null, createdById: owner,
  }).returning();
  for (const a of assignees) await db.insert(taskAssigneesTable).values({ tenantId, taskId: t!.id, userId: a.id });
  if (category) await db.insert(gerenteTaskMetaTable).values({ taskId: t!.id, tenantId, category }).onConflictDoNothing();

  const team = assignees.filter((a) => a.id !== owner);
  const who = team.length ? `para *${team.map((a) => a.name.trim().split(" ")[0]).join(", ")}*` : "nas *suas* tarefas";
  let dispatchLine = "";
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
    text: `📋 Tarefa *${t!.id}* criada ${who}: *${t!.title}*${category ? ` · ${category}` : ""}${p.dueAt ? ` — prazo ${fmtWhen(p.dueAt)}` : ""}${p.priority === "alta" ? " · 🔴 prioridade alta" : ""}.${nf}${dispatchLine}`,
    ref: { table: "task", id: t!.id },
  };
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
    gte(gerenteEventsTable.startsAt, windowStart), lte(gerenteEventsTable.startsAt, windowEnd),
  )).limit(1);
  const [e] = await db.insert(gerenteEventsTable).values({
    tenantId, title: p.title.slice(0, 200), startsAt: p.startsAt, endsAt: p.endsAt ?? null,
    location: p.location?.slice(0, 200) ?? null, participants: p.participants?.slice(0, 300) ?? null,
    scope: p.scope ?? "empresa", storeName: p.storeName?.slice(0, 60) ?? null, notes: p.notes?.slice(0, 1000) ?? null,
    remindMinutesBefore: Math.max(0, Math.min(1440, Math.floor(p.remindMinutesBefore ?? 30))),
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
    isNotNull(gerenteRemindersTable.sentAt),
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
  | { type: "organize_tasks"; items: import("./gerenteOrganize").OrganizeItem[] };

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
    gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, end),
  )).orderBy(asc(gerenteEventsTable.startsAt)).limit(30);
  if (rows.length === 0) return days === 1 ? "📅 Nenhum compromisso hoje." : `📅 Nenhum compromisso nos próximos ${days} dias.`;
  return `📅 *Agenda${days === 1 ? " de hoje" : ` (${days} dias)`}:*\n` + rows.map((e) =>
    `• ${fmtWhen(e.startsAt)} — ${e.title}${e.location ? ` (${e.location})` : ""}${e.participants ? ` com ${e.participants}` : ""}`).join("\n");
}

async function listReminders(tenantId: number): Promise<string> {
  const rows = await db.select().from(gerenteRemindersTable).where(and(
    eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"),
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
    gte(gerenteEventsTable.startsAt, start), lt(gerenteEventsTable.startsAt, end),
  )).orderBy(asc(gerenteEventsTable.startsAt)).limit(20);
  const reminders = await db.select().from(gerenteRemindersTable).where(and(
    eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end),
  )).orderBy(asc(gerenteRemindersTable.dueAt)).limit(20);
  const tasks = await db.select({ id: tasksTable.id, title: tasksTable.title, dueDate: tasksTable.dueDate }).from(tasksTable).where(and(
    eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"), lt(tasksTable.dueDate, end),
  )).orderBy(asc(tasksTable.dueDate)).limit(20);
  const bills = await db.select().from(gerenteBillsTable).where(and(
    eq(gerenteBillsTable.tenantId, tenantId), eq(gerenteBillsTable.status, "aberta"), lte(gerenteBillsTable.dueDate, today),
  )).orderBy(asc(gerenteBillsTable.dueDate)).limit(20);

  const sections: string[] = [`☀️ *Meu dia — ${describeNow().split(",").slice(0, 2).join(",")}*`];
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
  run: (args: Record<string, unknown>, ctx: { tenantId: number; phone: string }) => Promise<ActionResult>;
};

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const optStr = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const scopeArg = (v: unknown): "pessoal" | "empresa" => (v === "pessoal" ? "pessoal" : "empresa");

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
      categoria: { type: "string", enum: [...TASK_CATEGORIES] },
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
      o_que: { type: "string", enum: ["meu_dia", "agenda", "lembretes", "tarefas", "contas", "financeiro"] },
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
    name: "desfazer_ultimo",
    description: "Desfaz o último registro criado (lembrete, lançamento, conta, compromisso ou tarefa). Use também quando o dono corrigir algo: desfaça e crie de novo com os dados certos.",
    parameters: { type: "object", properties: {} },
    run: async (_a, ctx) => ({ text: await undoLast(ctx.tenantId, ctx.phone) }),
  },
];

type QueryKind = "meu_dia" | "agenda" | "lembretes" | "tarefas" | "contas" | "financeiro";

async function runQuery(tenantId: number, what: QueryKind, opts: { days?: number; month?: string | null } = {}): Promise<string> {
  switch (what) {
    case "meu_dia": return buildDigest(tenantId);
    case "agenda": return listAgenda(tenantId, Math.max(1, Math.min(60, opts.days ?? 7)));
    case "lembretes": return listReminders(tenantId);
    case "tarefas": return listTasks(tenantId);
    case "contas": return listBills(tenantId);
    case "financeiro": return financeSummary(tenantId, opts.month);
    default: return HELP_TEXT;
  }
}

async function buildSystemPrompt(tenantId: number, settings: GerenteSettings): Promise<string> {
  const users = await teamUsers(tenantId);
  const stores = await db.select({ name: storesTable.name }).from(storesTable)
    .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true)));
  return [
    `Você é ${settings.assistantName}, secretária executiva e gerente geral do dono de uma loja de celulares, falando com ele pelo WhatsApp.`,
    `Agora é ${describeNow()} (fuso de São Paulo). Toda data/hora que você mandar nas ferramentas deve ser nesse fuso, formato YYYY-MM-DDTHH:mm. "Amanhã às 9" = o dia seguinte às 09:00. Sem hora explícita: lembrete/compromisso às 09:00; tarefa às 18:00. Nunca agende no passado — se a hora de hoje já passou, use amanhã.`,
    `Regra central: tudo que ele pede vira um registro com destino, responsável, prazo e acompanhamento. Use as ferramentas para registrar; nunca diga que registrou sem chamar a ferramenta. Uma mensagem pode ter mais de um pedido — chame uma ferramenta por pedido.`,
    `Equipe (para responsável de tarefa): ${users.length ? users.map((u) => `${u.name} (${u.role})`).join(", ") : "ninguém cadastrado"}.`,
    `Tarefas: nunca crie a mesma tarefa duas vezes nem uma tarefa por pessoa — várias pessoas na mesma coisa = UMA tarefa com vários responsáveis. Lista de itens diferentes (ex.: "letreiro PP, uniforme, curso de IA") = uma tarefa por item. Coisa que o próprio dono vai fazer = sem responsável. Sempre escolha a categoria (${TASK_CATEGORIES.join(", ")}). Prioridade alta só se ele disser urgente/hoje/importante. Não invente prazo.`,
    `Lojas: ${stores.length ? stores.map((s) => s.name).join(", ") : "sem cadastro"}. Âmbito "pessoal" só quando ele deixar claro que é da vida pessoal; o padrão é "empresa".`,
    `Valores em reais (ex.: "1.250,50" = 1250.50). Quando algo essencial faltar (valor, horário de lembrete/compromisso), pergunte de forma curta em vez de chutar.`,
    `Se ele corrigir algo recém-registrado ("era 60, não 50"), use desfazer_ultimo e registre de novo com o dado certo. Quando ele perguntar algo, use consultar ou buscar_cliente. Respostas curtas, em português do Brasil, sem formalidade excessiva. Não invente informações.`,
  ].join("\n");
}

async function loadHistory(tenantId: number, phone: string, beforeMessageId: number): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  // Só o que veio ANTES da mensagem atual (por id) — duas mensagens rápidas
  // do dono ou um aviso do agendador no meio não podem entrar como "atual".
  // Avisos do sistema ficam de fora: não são fala da IA nesta conversa.
  const rows = await db.select({ direction: gerenteMessagesTable.direction, content: gerenteMessagesTable.content })
    .from(gerenteMessagesTable)
    .where(and(
      eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.phone, phone),
      lt(gerenteMessagesTable.id, beforeMessageId), ne(gerenteMessagesTable.source, "sistema"),
    ))
    .orderBy(desc(gerenteMessagesTable.id)).limit(HISTORY_LIMIT);
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
    tools: TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
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
      const r = await tool.run(args, { tenantId, phone });
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
  source: "whatsapp" | "painel"; inMessageId: number;
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
export async function handleGerenteText(input: GerenteInput): Promise<string[]> {
  const key = `${input.tenantId}:${input.phone}`;
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(() => processOne(input)).catch((err): string[] => {
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

  // Linha ADM: conta, "paguei" e "recebi" vão pra fila de aprovação do ERP
  // em vez do controle local do Gerente.
  if (rule && sessionKey && settings.admSessionKey === sessionKey && (rule.kind === "conta" || rule.kind === "gasto" || rule.kind === "receita")) {
    const r = await erpFromRule(settings, phone, rule, text, input.inMessageId);
    if (r) {
      await saveRepliesAndSend(input, [r], [`erp_${rule.kind}`], []);
      return [r];
    }
  }
  // Pedido de busca de cliente é frequente e barato — regra própria.
  const client = !rule ? text.match(/^(?:o que (?:eu )?combinei com|cliente|busca(?:r)? cliente|quem [eé])\s+(?:(?:o|a)\s+)?(.+?)\??$/i) : null;

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
  await db.update(gerenteMessagesTable).set({ intent: intents.join(",").slice(0, 200) || null, payload: { refs } })
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
  try {
    const { settings, moduleOn } = await cachedContext(input.tenantId);
    authorized = moduleOn && settings.enabled && isAuthorizedPhone(settings, input.phone);
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "Gerente IA: falha ao avaliar mensagem recebida");
    return false;
  }
  if (!authorized) return false;

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
    }).onConflictDoNothing().returning();
    if (!saved) return true; // reentrega da mesma mensagem — já tratada

    await db.update(gerenteSettingsTable).set({ lastSessionKey: input.sessionKey, lastPhone: phone, updatedAt: new Date() })
      .where(eq(gerenteSettingsTable.tenantId, input.tenantId));
    invalidateGerenteCache(input.tenantId);

    void (async () => {
      // Foto/PDF (boleto, comprovante): vai pra fila do ERP, legenda como contexto.
      if ((input.msgType === "image" || input.msgType === "doc") && input.mediaUrl) {
        const settingsNow = await getGerenteSettings(input.tenantId);
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
export async function notifyOwner(settings: GerenteSettings, text: string): Promise<boolean> {
  const phone = settings.lastPhone ?? settings.authorizedPhones[0];
  if (!phone || !settings.lastSessionKey) return false;
  const others = await db.select({ sessionKey: whatsappSessionsTable.sessionKey }).from(whatsappSessionsTable)
    .where(and(eq(whatsappSessionsTable.tenantId, settings.tenantId), eq(whatsappSessionsTable.status, "connected")));
  const candidates = [settings.lastSessionKey, ...others.map((o) => o.sessionKey).filter((k) => k !== settings.lastSessionKey)];
  for (const sessionKey of candidates) {
    if (await sendRawWhatsAppText(phone, sessionKey, text)) {
      await saveOut(settings.tenantId, phone, sessionKey, text, "sistema");
      return true;
    }
  }
  logger.warn({ tenantId: settings.tenantId }, "Gerente IA: nenhuma linha aceitou o aviso");
  return false;
}

/** Aviso ao dono a partir só do tenant (usado pelas tarefas da equipe). */
export async function notifyOwnerByTenant(tenantId: number, text: string): Promise<boolean> {
  const settings = await getGerenteSettings(tenantId);
  if (!settings.enabled) return false;
  return notifyOwner(settings, text);
}

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
        const ok = await notifyOwner(settings, `⏰ *Lembrete${r.urgent ? " urgente" : ""}:* ${r.title}\nResponda *feito* ou *adia 1h*.`);
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
        const ok = await notifyOwner(settings, `📅 *${mins > 0 ? `Em ${mins} min` : "Agora"}:* ${e.title}${e.location ? ` — ${e.location}` : ""}${e.participants ? ` (com ${e.participants})` : ""}`);
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
      } catch (err) {
        logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: falha ao checar tarefas atrasadas");
      }

      if (settings.dailyDigestTime && settings.dailyDigestSentOn !== today && hm >= settings.dailyDigestTime && !quiet) {
        const { createLink } = await import("./gerenteExtras");
        const ok = await notifyOwner(settings, `${await buildDigest(settings.tenantId)}\n\n🔗 Abrir no celular: ${await createLink(settings, "dia", null, 2)}`);
        if (ok) { await db.update(gerenteSettingsTable).set({ dailyDigestSentOn: today, updatedAt: now }).where(eq(gerenteSettingsTable.id, settings.id)); sent++; }
      }
    } catch (err) {
      logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: falha nos avisos");
    }
  }
  return { sent };
}
