import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  appSettingsTable,
  crmContactsTable,
  sectorsTable,
  taskAssigneesTable,
  taskCommentsTable,
  taskSubtasksTable,
  tasksTable,
  tenantErpIntegrationsTable,
  usersTable,
} from "@workspace/db";
import { decryptErpSecret } from "./erpCrypto";
import { erpUrl } from "./erpOsMessages";
import { MEDIA_DIR } from "./whatsappInbound";
import { appSetting, saveAppSetting } from "./tradeInMoved";

// Quadro de tarefas unificado (19/10/2026): as tarefas MORAM no ERP Prumo e
// aparecem aqui. Depois de "Mudar tarefas para o ERP" (Configurações ›
// Integrações › ERP), o quadro do CRM lê e grava no ERP pela chave de
// integração (acesso "Quadro de tarefas") — as tabelas locais ficam guardadas,
// sem uso. Pessoas do CRM e do ERP se encontram pelo e-mail; quem não tem par
// no ERP aparece pelo nome. Cada ação manda "quem fez" (nome + e-mail).

export const TASKS_MOVED_KEY = "tasks_moved_to_erp";
export const TASKS_MOVED_AT_KEY = "tasks_moved_at";
export const TASKS_IMPORT_KEY = "tasks_erp_import";

const TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_BATCH_BYTES = 10 * 1024 * 1024;

export class ErpTasksError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ErpConn {
  baseUrl: string;
  apiKey: string;
  webUrl: string | null;
}

// ─── Ligado ou não ──────────────────────────────────────────────────────────

const movedCache = new Map<number, { at: number; moved: boolean }>();
const TTL_MS = 15_000;

export async function tasksMoved(tenantId: number): Promise<boolean> {
  const hit = movedCache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.moved;
  const moved = (await appSetting(tenantId, TASKS_MOVED_KEY)) === "true";
  movedCache.set(tenantId, { at: Date.now(), moved });
  return moved;
}

export function forgetTasksMoved(tenantId: number): void {
  movedCache.delete(tenantId);
}

/** Lojas cujas tarefas estão no ERP (os lembretes daqui não disparam para elas). */
export async function movedTenantIds(): Promise<Set<number>> {
  const rows = await db.select({ tenantId: appSettingsTable.tenantId }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.key, TASKS_MOVED_KEY), eq(appSettingsTable.value, "true")));
  return new Set(rows.map((r) => r.tenantId));
}

export async function erpTasksConn(tenantId: number): Promise<ErpConn | null> {
  const [row] = await db.select().from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  if (!row) return null;
  try {
    const apiKey = decryptErpSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
    return { baseUrl: row.baseUrl, apiKey, webUrl: row.erpWebUrl ?? null };
  } catch {
    return null;
  }
}

/** Liga/desliga (o import é feito antes de ligar). */
export async function setTasksMoved(tenantId: number, moved: boolean): Promise<void> {
  await saveAppSetting(tenantId, TASKS_MOVED_KEY, moved ? "true" : "false");
  if (moved) await saveAppSetting(tenantId, TASKS_MOVED_AT_KEY, new Date().toISOString());
  forgetTasksMoved(tenantId);
}

// ─── Chamada ao ERP ─────────────────────────────────────────────────────────

async function errorFrom(res: Response): Promise<ErpTasksError> {
  const text = await res.text().catch(() => "");
  let message = "";
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = body.message ?? body.error;
    message = Array.isArray(m) ? m.join(" ") : typeof m === "string" ? m : "";
  } catch { /* corpo não é JSON */ }
  if (!message) message = res.status >= 500 ? "O ERP não respondeu. Tente de novo em instantes." : `ERP respondeu ${res.status}`;
  if (res.status === 403 && /chave/i.test(message)) {
    message = `${message} (gere no ERP uma chave com o acesso "Quadro de tarefas").`;
  }
  return new ErpTasksError(res.status, message.slice(0, 300));
}

export async function erpTasksRaw(conn: ErpConn, pathName: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(erpUrl(conn.baseUrl, `/integrations/tasks${pathName}`), {
      ...init,
      headers: { "Content-Type": "application/json", "X-Api-Key": conn.apiKey, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ErpTasksError(502, "Não deu para falar com o ERP agora. Tente de novo em instantes.");
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

export async function erpTasks<T>(conn: ErpConn, pathName: string, init?: RequestInit): Promise<T> {
  const res = await erpTasksRaw(conn, pathName, init);
  return (await res.json()) as T;
}

export const erpPost = <T>(conn: ErpConn, pathName: string, body: unknown, method = "POST") =>
  erpTasks<T>(conn, pathName, { method, body: JSON.stringify(body) });

// ─── Formatos do ERP ────────────────────────────────────────────────────────

export interface ErpTaskPerson { id: string; userId: string | null; name: string; email: string | null }

export interface ErpTask {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: "todo" | "doing" | "done";
  priority: "baixa" | "media" | "alta";
  dueDate: string | null;
  durationMinutes: number | null;
  alertMinutesBefore: number | null;
  position: number;
  sectorName: string | null;
  crmSectorId: number | null;
  contactName: string | null;
  contactPhone: string | null;
  crmContactId: number | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { userId: string | null; name: string; email: string | null } | null;
  assignees: ErpTaskPerson[];
  subtaskTotal: number;
  subtaskDone: number;
  commentCount: number;
}

export interface ErpTaskComment {
  id: string;
  authorName: string | null;
  authorEmail: string | null;
  origin: string;
  content: string;
  fileName: string | null;
  mimeType: string | null;
  hasFile: boolean;
  createdAt: string;
}

export interface ErpTaskDetail extends ErpTask {
  subtasks: { id: string; title: string; isDone: boolean; position: number; createdAt: string }[];
  comments: ErpTaskComment[];
}

export interface ErpTaskNotice {
  id: string;
  kind: "comment" | "reminder" | "daily" | "assigned";
  title: string;
  taskNumber: number;
  dueDate: string | null;
  createdAt: string;
}

// ─── Tradução ERP ↔ CRM (puras, testadas) ──────────────────────────────────

export interface CrmCtx {
  tenantId: number;
  users: { id: number; name: string; email: string }[];
  sectors: { id: number; name: string; color: string; icon?: string }[];
  contacts: Map<number, { id: number; name: string; contact: string | null }>;
}

const low = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

function userByEmail(ctx: CrmCtx, email: string | null | undefined) {
  const e = low(email);
  return e ? ctx.users.find((u) => low(u.email) === e) ?? null : null;
}

/**
 * Tarefa do ERP no formato que o quadro do CRM já usa. O id é o NÚMERO da
 * tarefa no ERP (as que vieram daqui mantêm o mesmo número). Responsável sem
 * usuário aqui recebe id negativo (posição na lista do ERP), para o quadro
 * mostrar o nome e o CRM conseguir mantê-lo ao editar.
 */
export function toCrmTask(t: ErpTask, ctx: CrmCtx) {
  const creator = t.createdBy ? userByEmail(ctx, t.createdBy.email) : null;
  const sector = t.crmSectorId != null ? ctx.sectors.find((s) => s.id === t.crmSectorId) ?? null : null;
  const contact = t.crmContactId != null ? ctx.contacts.get(t.crmContactId) ?? null : null;
  return {
    id: t.number,
    erpId: t.id,
    tenantId: ctx.tenantId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    createdById: creator?.id ?? null,
    sectorId: sector?.id ?? null,
    dueDate: t.dueDate,
    contactId: t.crmContactId,
    durationMinutes: t.durationMinutes,
    alertMinutesBefore: t.alertMinutesBefore,
    position: t.position,
    isArchived: false,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    sector: sector ?? (t.sectorName ? { id: 0, name: t.sectorName, color: "#64748b", icon: "smartphone" } : null),
    assignees: t.assignees.map((a, i) => {
      const u = userByEmail(ctx, a.email);
      return u ? { id: u.id, name: u.name } : { id: -(i + 1), name: a.name };
    }),
    createdBy: t.createdBy ? { id: creator?.id ?? 0, name: creator?.name ?? t.createdBy.name } : null,
    contact: contact ?? (t.contactName ? { id: t.crmContactId ?? 0, name: t.contactName, contact: t.contactPhone } : null),
    subtaskTotal: t.subtaskTotal,
    subtaskDone: t.subtaskDone,
    commentCount: t.commentCount,
  };
}

export type CrmTaskView = ReturnType<typeof toCrmTask>;

/** Mesma regra do quadro daqui: admin vê todas; os outros, as que criaram ou em que são responsáveis. */
export function canSeeErpTask(t: ErpTask, viewer: { email: string | null; isAdmin: boolean }): boolean {
  if (viewer.isAdmin) return true;
  const e = low(viewer.email);
  if (!e) return false;
  return low(t.createdBy?.email) === e || t.assignees.some((a) => low(a.email) === e);
}

/** ids de responsáveis do quadro (usuários daqui; negativos = os que só existem no ERP). */
export function assigneesForErp(
  ids: number[],
  ctx: CrmCtx,
  current?: Pick<ErpTask, "assignees"> | null,
): { displayName: string; email?: string }[] | { error: string } {
  const out: { displayName: string; email?: string }[] = [];
  for (const id of [...new Set(ids)]) {
    if (id < 0) {
      const a = current?.assignees[-id - 1];
      if (a) out.push({ displayName: a.name, ...(a.email ? { email: a.email } : {}) });
      continue;
    }
    const u = ctx.users.find((x) => x.id === id);
    if (!u) return { error: "Responsável inválido" };
    out.push({ displayName: u.name, ...(u.email ? { email: low(u.email) } : {}) });
  }
  return out;
}

export function commentToCrm(c: ErpTaskComment, taskNumber: number, ctx: CrmCtx) {
  const u = userByEmail(ctx, c.authorEmail);
  return {
    id: c.id,
    taskId: taskNumber,
    authorId: u?.id ?? null,
    authorName: u?.name ?? c.authorName,
    content: c.content,
    createdAt: c.createdAt,
    mediaUrl: c.hasFile ? `/api/tasks/${taskNumber}/comments/${c.id}/file` : null,
    mediaType: c.hasFile ? ((c.mimeType ?? "").startsWith("image/") ? "image" : "doc") : null,
  };
}

/** Relatório por setor e por vendedor — mesma conta do quadro daqui. */
export function buildCrmReport(tasks: CrmTaskView[], now = new Date()) {
  type Bucket = { name: string; total: number; todo: number; doing: number; done: number; overdue: number };
  const mk = (name: string): Bucket => ({ name, total: 0, todo: 0, doing: 0, done: 0, overdue: 0 });
  const bySector: Record<string, Bucket> = {};
  const byUser: Record<string, Bucket> = {};
  for (const t of tasks) {
    const bump = (b: Bucket) => {
      b.total++;
      if (t.status === "todo") b.todo++;
      else if (t.status === "doing") b.doing++;
      else if (t.status === "done") b.done++;
      if (t.status !== "done" && t.dueDate && new Date(t.dueDate) < now) b.overdue++;
    };
    const sKey = t.sector ? `s:${t.sector.name.toUpperCase()}` : "none";
    bySector[sKey] ??= mk(t.sector?.name ?? "Sem setor");
    bump(bySector[sKey]!);
    if (t.assignees.length === 0) {
      byUser.none ??= mk("Sem responsável");
      bump(byUser.none);
    }
    for (const a of t.assignees) {
      const key = a.id > 0 ? `u:${a.id}` : `n:${a.name.toUpperCase()}`;
      byUser[key] ??= mk(a.name);
      bump(byUser[key]!);
    }
  }
  const sort = (r: Record<string, Bucket>) => Object.values(r).sort((a, b) => b.total - a.total);
  return { bySector: sort(bySector), byUser: sort(byUser) };
}

export async function loadCrmCtx(tenantId: number, contactIds: number[] = []): Promise<CrmCtx> {
  const users = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const sectors = await db.select({ id: sectorsTable.id, name: sectorsTable.name, color: sectorsTable.color, icon: sectorsTable.icon })
    .from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  const ids = [...new Set(contactIds.filter((n) => Number.isInteger(n) && n > 0))];
  const contacts = ids.length
    ? await db.select({ id: crmContactsTable.id, name: crmContactsTable.name, contact: crmContactsTable.contact })
        .from(crmContactsTable).where(and(eq(crmContactsTable.tenantId, tenantId), inArray(crmContactsTable.id, ids)))
    : [];
  return { tenantId, users, sectors, contacts: new Map(contacts.map((c) => [c.id, c])) };
}

// ─── Importação das tarefas daqui para o ERP ────────────────────────────────

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function fileFor(mediaUrl: string | null): Promise<{ fileName: string; mimeType: string; dataBase64: string } | null> {
  if (!mediaUrl) return null;
  const name = path.basename(mediaUrl.split("?")[0] ?? "");
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = EXT_MIME[ext];
  if (!name || !mimeType) return null;
  try {
    const buf = await readFile(path.join(MEDIA_DIR, name));
    if (buf.length === 0 || buf.length > MAX_FILE_BYTES) return null;
    return { fileName: name, mimeType, dataBase64: buf.toString("base64") };
  } catch {
    return null; // arquivo sumiu do disco: vai só o texto
  }
}

/** Monta as tarefas daqui (abertas e concluídas, não excluídas) no formato de importação do ERP. */
export async function buildImportItems(tenantId: number) {
  const tasks = await db.select().from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false)));
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);
  const ctx = await loadCrmCtx(tenantId, tasks.map((t) => t.contactId ?? 0));
  const contactsFull = await db.select({ id: crmContactsTable.id, phone: crmContactsTable.phone, contact: crmContactsTable.contact })
    .from(crmContactsTable).where(and(eq(crmContactsTable.tenantId, tenantId), inArray(crmContactsTable.id, [...ctx.contacts.keys(), 0])));
  const phoneOf = new Map(contactsFull.map((c) => [c.id, c.contact ?? c.phone ?? null]));
  const assignees = await db.select().from(taskAssigneesTable).where(inArray(taskAssigneesTable.taskId, ids));
  const comments = await db.select().from(taskCommentsTable).where(inArray(taskCommentsTable.taskId, ids));
  const subtasks = await db.select().from(taskSubtasksTable).where(inArray(taskSubtasksTable.taskId, ids));
  const person = (userId: number | null) => {
    const u = userId != null ? ctx.users.find((x) => x.id === userId) : null;
    return u ? { displayName: u.name, ...(u.email ? { email: low(u.email) } : {}) } : undefined;
  };
  const items = [];
  for (const t of tasks) {
    const sector = t.sectorId != null ? ctx.sectors.find((s) => s.id === t.sectorId) : null;
    const contact = t.contactId != null ? ctx.contacts.get(t.contactId) : null;
    const taskComments = [];
    for (const c of comments.filter((x) => x.taskId === t.id)) {
      const file = await fileFor(c.mediaUrl);
      taskComments.push({
        crmCommentId: c.id,
        ...(person(c.authorId) ? { author: person(c.authorId) } : {}),
        content: c.content ?? "",
        createdAt: c.createdAt.toISOString(),
        ...(file ?? {}),
      });
    }
    items.push({
      crmTaskId: t.id,
      title: t.title.slice(0, 200),
      ...(t.description ? { details: t.description.slice(0, 5000) } : {}),
      status: t.status,
      priority: t.priority,
      ...(t.dueDate ? { dueDate: t.dueDate.toISOString() } : {}),
      ...(t.durationMinutes != null ? { durationMinutes: t.durationMinutes } : {}),
      ...(t.alertMinutesBefore != null ? { alertMinutesBefore: t.alertMinutesBefore } : {}),
      position: t.position,
      ...(sector ? { sectorName: sector.name, crmSectorId: sector.id } : {}),
      ...(contact ? { contactLabel: contact.name.slice(0, 160), crmContactId: contact.id } : {}),
      ...(contact && phoneOf.get(contact.id) ? { contactPhone: String(phoneOf.get(contact.id)).slice(0, 40) } : {}),
      ...(person(t.createdById) ? { createdBy: person(t.createdById) } : {}),
      assignees: assignees.filter((a) => a.taskId === t.id).map((a) => person(a.userId)).filter((p) => p != null),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      comments: taskComments,
      subtasks: subtasks.filter((s) => s.taskId === t.id).map((s) => ({
        crmSubtaskId: s.id, title: s.title.slice(0, 300), isDone: s.isDone, position: s.position,
      })),
    });
  }
  return items;
}

export interface ImportReport {
  tasks: number; created: number; existing: number; comments: number; subtasks: number;
  files: number; fileErrors: number; assigneesLinked: number; peopleWithoutErpUser: string[];
  at?: string;
}

/** Manda tudo para o ERP em lotes (até 100 tarefas e ~10 MB por vez). Repetir não duplica. */
export async function importTasksToErp(tenantId: number, conn: ErpConn): Promise<ImportReport> {
  const items = await buildImportItems(tenantId);
  const total: ImportReport = {
    tasks: 0, created: 0, existing: 0, comments: 0, subtasks: 0, files: 0, fileErrors: 0, assigneesLinked: 0, peopleWithoutErpUser: [],
  };
  const people = new Set<string>();
  let batch: typeof items = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await erpPost<ImportReport>(conn, "/import", { items: batch });
    for (const k of ["tasks", "created", "existing", "comments", "subtasks", "files", "fileErrors", "assigneesLinked"] as const) {
      total[k] += r[k] ?? 0;
    }
    (r.peopleWithoutErpUser ?? []).forEach((p) => people.add(p));
    batch = [];
    size = 0;
  };
  for (const item of items) {
    const s = JSON.stringify(item).length;
    if (batch.length && (batch.length >= 100 || size + s > MAX_BATCH_BYTES)) await flush();
    batch.push(item);
    size += s;
  }
  await flush();
  total.peopleWithoutErpUser = [...people].sort();
  total.at = new Date().toISOString();
  await saveAppSetting(tenantId, TASKS_IMPORT_KEY, JSON.stringify(total));
  return total;
}

export async function lastImport(tenantId: number): Promise<ImportReport | null> {
  const raw = await appSetting(tenantId, TASKS_IMPORT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as ImportReport; } catch { return null; }
}

// ─── Tarefa espelho do atendimento (Agendar mensagem/retorno) ───────────────

async function crmActorFor(userId: number | null) {
  const [u] = userId != null
    ? await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1)
    : [];
  return u
    ? { actorName: u.name.slice(0, 120), ...(u.email ? { actorEmail: low(u.email) } : {}) }
    : { actorName: "CRM" };
}

/**
 * Com as tarefas no ERP, o "Agendar" do atendimento cria a tarefa espelho lá
 * (responsável = quem agendou). Devolve o número da tarefa no ERP, ou null
 * se o ERP não respondeu (o agendamento segue valendo mesmo assim).
 */
export async function createErpMirrorTask(
  tenantId: number,
  userId: number | null,
  data: { title: string; details: string; dueDate: Date; sectorId: number | null; contactId: number | null },
): Promise<number | null> {
  const c = await erpTasksConn(tenantId);
  if (!c) return null;
  const actor = await crmActorFor(userId);
  const ctx = await loadCrmCtx(tenantId, data.contactId ? [data.contactId] : []);
  const sector = data.sectorId != null ? ctx.sectors.find((s) => s.id === data.sectorId) : null;
  const contact = data.contactId != null ? ctx.contacts.get(data.contactId) : null;
  const t = await erpPost<ErpTask>(c, "", {
    actor,
    title: data.title.slice(0, 200),
    details: data.details.slice(0, 5000),
    status: "todo",
    priority: "media",
    dueDate: data.dueDate.toISOString(),
    ...(sector ? { sectorName: sector.name.slice(0, 80), crmSectorId: sector.id } : {}),
    ...(contact ? { contactLabel: contact.name.slice(0, 160), crmContactId: contact.id, ...(contact.contact ? { contactPhone: contact.contact.slice(0, 40) } : {}) } : {}),
    assignees: "actorEmail" in actor ? [{ displayName: actor.actorName, email: actor.actorEmail }] : [],
  });
  return t.number;
}

/** Conclui (mensagem enviada) ou exclui (agendamento cancelado) a tarefa espelho no ERP. */
export async function finishErpMirrorTask(
  tenantId: number,
  number: number,
  userId: number | null,
  how: "done" | "archive",
): Promise<void> {
  const c = await erpTasksConn(tenantId);
  if (!c) return;
  const actor = await crmActorFor(userId);
  if (how === "archive") await erpPost(c, `/${number}/archive`, { actor });
  else await erpPost(c, `/${number}`, { actor, status: "done" }, "PATCH");
}
