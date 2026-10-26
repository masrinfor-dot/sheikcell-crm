// Gerente IA — operações em tarefas do quadro, usadas pelo link do celular e
// pelos comandos do WhatsApp do dono:
//   "tarefa estorno concluída" / "concluir tarefa 126"  → fecha e avisa o responsável
//   "ativar tarefa 126" / "reabrir tarefa extornos"     → muda a situação
//   "comentar tarefa 126: já liguei pro cliente"        → comentário + aviso
//   "avisa o Alan: passa no banco antes das 15h"        → mensagem pro colaborador
import { and, eq, ne, inArray, asc } from "drizzle-orm";
import {
  db, tasksTable, taskAssigneesTable, taskCommentsTable, usersTable, gerenteTaskDispatchesTable,
} from "@workspace/db";
import { norm } from "./gerenteRules";
import { logger } from "./logger";

export type TaskStatus = "todo" | "doing" | "done";
const STATUS_LABEL: Record<TaskStatus, string> = { todo: "a fazer", doing: "em andamento", done: "concluída" };

async function ownerUser(tenantId: number): Promise<{ id: number; name: string } | null> {
  const [u] = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin")))
    .orderBy(asc(usersTable.id)).limit(1);
  return u ? { id: u.id, name: u.name.trim() } : null;
}

async function assigneesOf(taskId: number): Promise<{ id: number; name: string }[]> {
  return (await db.select({ id: usersTable.id, name: usersTable.name }).from(taskAssigneesTable)
    .innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId)).where(eq(taskAssigneesTable.taskId, taskId)))
    .map((u) => ({ id: u.id, name: u.name.trim() }));
}

/** Palavra canônica: sem acento, x→s, sem plural ("extornos" ≈ "estorno"). */
function canon(w: string): string {
  return norm(w).replace(/x/g, "s").replace(/ç/g, "c").replace(/s$/, "");
}
const STOP = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "pra", "para", "com", "no", "na", "em", "um", "uma"]);

/**
 * Acha a tarefa por número ou pelo título (aproximado). Só tarefas não
 * arquivadas; prefere as abertas. Devolve a tarefa, ou a lista de candidatas
 * quando ficou ambíguo.
 */
export async function findTask(tenantId: number, ref: string, opts: { includeDone?: boolean } = {}): Promise<{ task: { id: number; title: string; status: string } | null; candidates: { id: number; title: string }[] }> {
  const r = ref.trim().replace(/^#/, "");
  if (/^\d+$/.test(r)) {
    const [t] = await db.select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status }).from(tasksTable)
      .where(and(eq(tasksTable.id, Number(r)), eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false))).limit(1);
    return { task: t ?? null, candidates: [] };
  }
  const words = r.split(/[^\p{L}\p{N}]+/u).map(canon).filter((w) => w.length >= 3 && !STOP.has(w) && w !== "tarefa");
  if (!words.length) return { task: null, candidates: [] };
  const rows = await db.select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status }).from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ...(opts.includeDone ? [] : [ne(tasksTable.status, "done")])))
    .limit(500);
  const scored = rows.map((t) => {
    const tw = t.title.split(/[^\p{L}\p{N}]+/u).map(canon).filter(Boolean);
    // Igual, ou prefixo quando a parte menor cobre ≥ 75% da maior ("estoq" ≈ "estoque").
    const close = (x: string, w: string) => x === w || (Math.min(x.length, w.length) >= 4 && (x.startsWith(w) || w.startsWith(x)) && Math.min(x.length, w.length) / Math.max(x.length, w.length) >= 0.75);
    const hits = words.filter((w) => tw.some((x) => close(x, w))).length;
    return { t, score: hits / words.length };
  }).filter((x) => x.score >= 0.99 || (words.length > 2 && x.score >= 0.66)).sort((a, b) => b.score - a.score || b.t.id - a.t.id);
  if (scored.length === 1) return { task: scored[0]!.t, candidates: [] };
  if (scored.length > 1 && scored[0]!.score > scored[1]!.score) return { task: scored[0]!.t, candidates: [] };
  return { task: null, candidates: scored.slice(0, 6).map((x) => ({ id: x.t.id, title: x.t.title })) };
}

/** Avisa os responsáveis da tarefa no WhatsApp. Devolve os nomes que receberam. */
export async function notifyAssignees(tenantId: number, taskId: number, text: string): Promise<{ sent: string[]; missing: string[] }> {
  const { sendToTeamMember } = await import("./gerenteDispatch");
  const owner = await ownerUser(tenantId);
  const who = (await assigneesOf(taskId)).filter((u) => u.id !== owner?.id);
  const sent: string[] = []; const missing: string[] = [];
  for (const u of who) {
    try { (await sendToTeamMember(tenantId, u.id, text) ? sent : missing).push(u.name.split(" ")[0]!); }
    catch (err) { logger.warn({ err, taskId }, "Gerente IA: falha ao avisar responsável"); missing.push(u.name.split(" ")[0]!); }
  }
  return { sent, missing };
}

function notifiedLine(r: { sent: string[]; missing: string[] }): string {
  const parts: string[] = [];
  if (r.sent.length) parts.push(`📲 Avisei: ${r.sent.join(", ")}`);
  if (r.missing.length) parts.push(`⚠️ Sem WhatsApp cadastrado: ${r.missing.join(", ")}`);
  return parts.join(" · ");
}

export async function setTaskStatus(tenantId: number, taskId: number, status: TaskStatus, notify: boolean): Promise<string> {
  const [t] = await db.update(tasksTable).set({ status, updatedAt: new Date() })
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId))).returning();
  if (!t) return "Não achei essa tarefa.";
  const owner = await ownerUser(tenantId);
  if (status === "done") {
    await db.update(gerenteTaskDispatchesTable).set({ status: "concluida", doneAt: new Date(), proofNote: "Concluída pelo dono" })
      .where(and(eq(gerenteTaskDispatchesTable.taskId, taskId), inArray(gerenteTaskDispatchesTable.status, ["enviada", "aguardando_prova"])));
  }
  await db.insert(taskCommentsTable).values({ tenantId, taskId, authorId: owner?.id ?? null, content: `🔄 Situação: ${STATUS_LABEL[status]} (pelo Gerente IA)` });
  let line = "";
  if (notify) {
    const msg = status === "done"
      ? `✅ A tarefa *${t.id} — ${t.title}* foi marcada como *concluída* por ${owner?.name.split(" ")[0] ?? "o gestor"}.`
      : status === "doing"
        ? `▶️ A tarefa *${t.id} — ${t.title}* está *ativa* (em andamento). Bora! Quando terminar, responda *feito ${t.id}* com a foto.`
        : `↩️ A tarefa *${t.id} — ${t.title}* foi *reaberta*. Responda *feito ${t.id}* com a foto quando concluir.`;
    line = notifiedLine(await notifyAssignees(tenantId, taskId, msg));
  }
  const icon = status === "done" ? "✅" : status === "doing" ? "▶️" : "↩️";
  return `${icon} Tarefa *${t.id} — ${t.title}*: ${STATUS_LABEL[status]}.${line ? `\n${line}` : ""}`;
}

export async function addTaskComment(tenantId: number, taskId: number, text: string, notify: boolean): Promise<string> {
  const [t] = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable)
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId))).limit(1);
  if (!t) return "Não achei essa tarefa.";
  const owner = await ownerUser(tenantId);
  await db.insert(taskCommentsTable).values({ tenantId, taskId, authorId: owner?.id ?? null, content: text.slice(0, 2000) });
  let line = "";
  if (notify) line = notifiedLine(await notifyAssignees(tenantId, taskId, `💬 *${owner?.name.split(" ")[0] ?? "Gestor"}* na tarefa *${t.id} — ${t.title}*:\n${text}`));
  return `💬 Comentário na tarefa *${t.id}* salvo.${line ? `\n${line}` : ""}`;
}

/** Mensagem direta pra uma pessoa da equipe, pelo nome. */
export async function messageTeamMember(tenantId: number, name: string, text: string): Promise<string> {
  const users = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)));
  const q = norm(name);
  const exact = users.filter((u) => norm(u.name.trim()).split(" ")[0] === q || norm(u.name.trim()) === q);
  const match = exact.length ? exact : users.filter((u) => norm(u.name).includes(q));
  if (match.length !== 1) return match.length ? `Tem mais de uma pessoa com "${name}": ${match.map((u) => u.name.trim()).join(", ")}. Use o nome completo.` : `Não achei "${name}" na equipe.`;
  const u = match[0]!;
  const owner = await ownerUser(tenantId);
  const { sendToTeamMember } = await import("./gerenteDispatch");
  const ok = await sendToTeamMember(tenantId, u.id, `📣 *${owner?.name.split(" ")[0] ?? "Gestor"}:* ${text}`);
  return ok ? `📲 Mandei pro ${u.name.trim().split(" ")[0]}.` : `⚠️ ${u.name.trim().split(" ")[0]} não tem WhatsApp cadastrado (Gerente IA → Configurações → Equipe no WhatsApp).`;
}

// ─── Comandos do WhatsApp ────────────────────────────────────────────────────

function ambiguous(cands: { id: number; title: string }[], verb: string): string {
  if (!cands.length) return "Não achei essa tarefa entre as abertas. Mande o número (ex.: *concluir tarefa 126*) ou *link* pra ver a lista.";
  return `Qual delas? Responda *${verb} tarefa N*:\n${cands.map((c) => `• ${c.id} — ${c.title}`).join("\n")}`;
}

export async function tryTaskCommand(tenantId: number, text: string): Promise<string | null> {
  const t = text.replace(/\s+/g, " ").trim();
  const n = norm(t);

  // "concluir tarefa 126", "finalizar a tarefa estorno"
  let m = n.match(/^(?:concluir|conclui|finalizar|finaliza|fechar|fecha|encerrar|encerra|marcar como (?:feita|concluida)) (?:a )?tarefa (.+)$/);
  // "tarefa estorno concluída", "tarefa 126 feita"
  if (!m) m = n.match(/^tarefa (.+?) (?:concluida|finalizada|feita|pronta|resolvida|ok)$/);
  if (m) {
    const { task, candidates } = await findTask(tenantId, m[1]!);
    if (!task) return ambiguous(candidates, "concluir");
    return setTaskStatus(tenantId, task.id, "done", true);
  }
  m = n.match(/^(?:ativar|ativa|iniciar|inicia|comecar|começar) (?:a )?tarefa (.+)$/);
  if (m) {
    const { task, candidates } = await findTask(tenantId, m[1]!);
    if (!task) return ambiguous(candidates, "ativar");
    return setTaskStatus(tenantId, task.id, "doing", true);
  }
  m = n.match(/^(?:reabrir|reabre|voltar|volta) (?:a )?tarefa (.+)$/);
  if (m) {
    const { task, candidates } = await findTask(tenantId, m[1]!, { includeDone: true });
    if (!task) return ambiguous(candidates, "reabrir");
    return setTaskStatus(tenantId, task.id, "todo", true);
  }
  // "comentar tarefa 126: texto" (o texto mantém maiúsculas/acentos)
  const c = t.match(/^comentar?(?:\s+na)?\s+tarefa\s+(.+?)\s*:\s*(.+)$/i);
  if (c) {
    const { task, candidates } = await findTask(tenantId, c[1]!);
    if (!task) return ambiguous(candidates, "comentar");
    return addTaskComment(tenantId, task.id, c[2]!.trim(), true);
  }
  if (/^(limpar duplicadas|juntar duplicadas|juntar tarefas duplicadas)$/.test(n)) {
    const r = await mergeDuplicateTasks(tenantId);
    if (!r.length) return "👌 Nenhuma tarefa duplicada.";
    return `🧹 Juntei ${r.reduce((s, g) => s + g.archived.length, 0)} duplicada(s):\n${r.map((g) => `• ficou a ${g.kept}; arquivei ${g.archived.map((a) => a.id).join(", ")} (${g.archived[0]!.title})`).join("\n")}`;
  }
  // "avisa o Alan: texto", "avisar Davi que …", "manda pro Christian: …"
  const a = t.match(/^(?:avisa|avisar|informa|informar|manda pr[oa]|mandar pr[oa]|fala pr[oa]|fala com)\s+(?:(?:o|a)\s+)?([A-Za-zÀ-ÿ]+)\s*(?::|,|\s+que\s+)\s*(.+)$/i);
  if (a && !/^(me|mim|eu)$/i.test(a[1]!)) return messageTeamMember(tenantId, a[1]!, a[2]!.trim());
  return null;
}

// ─── Edição completa (link e painel) ─────────────────────────────────────────

export type TaskPatch = {
  title?: string; dueDate?: Date | null; priority?: "baixa" | "media" | "alta";
  assigneeIds?: number[]; category?: string | null; description?: string | null;
};

/** Edita a tarefa. Responsável novo recebe a tarefa no WhatsApp. */
export async function updateTask(tenantId: number, taskId: number, patch: TaskPatch): Promise<string> {
  const { gerenteTaskMetaTable } = await import("@workspace/db");
  const [t] = await db.select().from(tasksTable).where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId))).limit(1);
  if (!t) return "Não achei essa tarefa.";
  const set: Partial<typeof tasksTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined && patch.title.trim()) set.title = patch.title.trim().slice(0, 200);
  if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
  if (patch.priority) set.priority = patch.priority;
  if (patch.description !== undefined) set.description = patch.description?.slice(0, 2000) || null;
  await db.update(tasksTable).set(set).where(eq(tasksTable.id, taskId));
  const msgs: string[] = [];
  if (patch.category !== undefined) {
    const category = patch.category?.trim().slice(0, 40) || null;
    await db.insert(gerenteTaskMetaTable).values({ taskId, tenantId, category })
      .onConflictDoUpdate({ target: gerenteTaskMetaTable.taskId, set: { category, updatedAt: new Date() } });
  }
  if (patch.assigneeIds) {
    const valid = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), inArray(usersTable.id, patch.assigneeIds.length ? patch.assigneeIds : [-1])));
    const before = await assigneesOf(taskId);
    const added = valid.filter((v) => !before.some((b) => b.id === v.id));
    await db.delete(taskAssigneesTable).where(eq(taskAssigneesTable.taskId, taskId));
    for (const v of valid) await db.insert(taskAssigneesTable).values({ tenantId, taskId, userId: v.id });
    const owner = await ownerUser(tenantId);
    const toSend = added.filter((a) => a.id !== owner?.id);
    if (toSend.length) {
      const { dispatchTaskToSeller } = await import("./gerenteDispatch");
      const { getGerenteSettings } = await import("./gerente");
      const settings = await getGerenteSettings(tenantId);
      const [fresh] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
      for (const a of toSend) msgs.push(await dispatchTaskToSeller(tenantId, {
        taskId, userId: a.id, assigneeName: a.name.trim(), title: fresh!.title, dueAt: fresh!.dueDate, priority: fresh!.priority, ownerSessionKey: settings.lastSessionKey,
      }));
    }
  }
  return ["✅ Tarefa atualizada.", ...msgs].join("\n");
}

export async function addSubtask(tenantId: number, taskId: number, title: string): Promise<void> {
  const { taskSubtasksTable } = await import("@workspace/db");
  const [t] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId))).limit(1);
  if (!t) return;
  await db.insert(taskSubtasksTable).values({ tenantId, taskId, title: title.trim().slice(0, 200) });
}

export async function toggleSubtask(tenantId: number, taskId: number, subtaskId: number, done: boolean): Promise<void> {
  const { taskSubtasksTable } = await import("@workspace/db");
  await db.update(taskSubtasksTable).set({ isDone: done })
    .where(and(eq(taskSubtasksTable.id, subtaskId), eq(taskSubtasksTable.taskId, taskId), eq(taskSubtasksTable.tenantId, tenantId)));
}

export async function archiveTask(tenantId: number, taskId: number): Promise<string> {
  const [t] = await db.update(tasksTable).set({ isArchived: true, updatedAt: new Date() })
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.tenantId, tenantId))).returning();
  if (!t) return "Não achei essa tarefa.";
  await db.update(gerenteTaskDispatchesTable).set({ status: "cancelada" })
    .where(and(eq(gerenteTaskDispatchesTable.taskId, taskId), inArray(gerenteTaskDispatchesTable.status, ["enviada", "aguardando_prova"])));
  return `🗑️ Tarefa ${t.id} arquivada.`;
}

/**
 * Junta tarefas abertas com o mesmo título (duplicadas pela IA): fica a mais
 * antiga, com todos os responsáveis; as outras são arquivadas (dá pra
 * recuperar no quadro). Devolve o que foi arquivado.
 */
export async function mergeDuplicateTasks(tenantId: number): Promise<{ kept: number; archived: { id: number; title: string }[] }[]> {
  const { canonTitle } = await import("./gerente");
  const open = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done")))
    .orderBy(asc(tasksTable.id)).limit(2000);
  const groups = new Map<string, { id: number; title: string }[]>();
  for (const t of open) { const k = canonTitle(t.title); if (!k) continue; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const out: { kept: number; archived: { id: number; title: string }[] }[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [keep, ...rest] = g;
    const keepWho = await assigneesOf(keep!.id);
    for (const r of rest) {
      for (const a of await assigneesOf(r.id)) {
        if (!keepWho.some((k) => k.id === a.id)) { await db.insert(taskAssigneesTable).values({ tenantId, taskId: keep!.id, userId: a.id }); keepWho.push(a); }
      }
      await db.update(tasksTable).set({ isArchived: true, updatedAt: new Date() }).where(eq(tasksTable.id, r.id));
      await db.update(gerenteTaskDispatchesTable).set({ status: "cancelada" })
        .where(and(eq(gerenteTaskDispatchesTable.taskId, r.id), inArray(gerenteTaskDispatchesTable.status, ["enviada", "aguardando_prova"])));
    }
    out.push({ kept: keep!.id, archived: rest });
  }
  return out;
}
