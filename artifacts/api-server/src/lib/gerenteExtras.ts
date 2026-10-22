// Gerente IA — extras de automação e de interação pelo WhatsApp:
//   • links seguros (sem login, só leitura, expiram): "link", "link da tarefa 12";
//   • rotinas recorrentes: "todo dia 10 pagar aluguel", "toda segunda 9h tarefa pro Alan: …";
//   • fechamento do dia (noite): o que foi feito, o que ficou, "mover" pra amanhã;
//   • relatório semanal da equipe (segunda de manhã).
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gte, lt, lte, inArray, asc, ne } from "drizzle-orm";
import {
  db, gerenteLinksTable, gerenteRecurrencesTable, gerenteSettingsTable, gerenteRemindersTable,
  gerenteTaskDispatchesTable, tasksTable, type GerenteSettings,
} from "@workspace/db";
import {
  parseRecurrence, nextOccurrence, describeRule, parseByRules, spDateISO, spTimeHM, spParts, parseSpLocal, fmtWhen, brl, norm,
} from "./gerenteRules";
import { logger } from "./logger";

const DEFAULT_BASE = "https://crm.sheikcell.com.br";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomAlnum(n: number): string {
  // Rejeita bytes >= 248 pra não enviesar (248 = 62 * 4).
  let out = "";
  while (out.length < n) for (const b of randomBytes(n * 2)) { if (b < 248 && out.length < n) out += ALNUM[b % 62]; }
  return out;
}

// ─── Links ───────────────────────────────────────────────────────────────────

export async function createLink(settings: GerenteSettings, scope: "dia" | "task", refId: number | null, days: number, canEdit = true): Promise<string> {
  // Só letras e números: "_" e "~" viram formatação no WhatsApp (itálico,
  // tachado) e quebravam o link quando o código tinha dois deles.
  const token = randomAlnum(32);
  await db.insert(gerenteLinksTable).values({ tenantId: settings.tenantId, tokenHash: hash(token), scope, refId, canEdit, expiresAt: new Date(Date.now() + days * 86_400_000) });
  const base = (settings.publicBaseUrl ?? process.env["PUBLIC_WEB_URL"] ?? DEFAULT_BASE).replace(/\/+$/, "");
  return `${base}/g/${token}`;
}

export async function resolveLink(token: string): Promise<typeof gerenteLinksTable.$inferSelect | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db.select().from(gerenteLinksTable).where(eq(gerenteLinksTable.tokenHash, hash(token))).limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// ─── Rotinas ─────────────────────────────────────────────────────────────────

/** "todo dia …" / "toda segunda …" → cria a rotina. null = não é rotina. */
export async function tryCreateRecurrence(settings: GerenteSettings, text: string): Promise<string | null> {
  const r = parseRecurrence(text);
  if (!r) return null;
  // Interpreta "o que fazer" com as mesmas regras (sem data — a data vem da rotina).
  const rest = r.rest;
  const intent = parseByRules(`${rest}${/(\d{1,2}[:h]\d{0,2}|amanh|hoje|\d{1,2}\/\d{1,2})/i.test(rest) ? "" : " hoje"}`);
  let kind: "lembrete" | "tarefa" | "conta";
  let title: string;
  let assigneeName: string | null = null;
  let amountCents: number | null = null;
  let billKind: string | null = null;
  if (intent?.kind === "tarefa") { kind = "tarefa"; title = intent.title; assigneeName = intent.assignee; }
  else if (intent?.kind === "conta") { kind = "conta"; title = intent.description; amountCents = intent.amountCents; billKind = intent.billKind; }
  else {
    kind = "lembrete";
    title = (intent?.kind === "lembrete" ? intent.title : rest.replace(/^(me\s+)?(lembra|lembre|lembrar|lembrete)(\s+de)?\s*:?\s*/i, "")).trim();
  }
  if (!title) return null;
  const nextAt = nextOccurrence(r.rule);
  const [row] = await db.insert(gerenteRecurrencesTable).values({
    tenantId: settings.tenantId, kind, title: title.slice(0, 200), rule: r.rule, assigneeName, amountCents, billKind, nextAt,
  }).returning();
  const what = kind === "tarefa" ? `tarefa${assigneeName ? ` pro ${assigneeName}` : ""}: *${title}*` : kind === "conta" ? `conta a ${billKind}: *${title}* ${amountCents ? brl(amountCents) : ""}` : `lembrete: *${title}*`;
  return `🔁 Rotina *${row!.id}* criada — ${describeRule(r.rule)}, ${what}.\nPróxima: ${fmtWhen(nextAt)}. Mande *rotinas* pra ver todas ou *cancelar rotina ${row!.id}*.`;
}

export async function listRecurrences(tenantId: number): Promise<string> {
  const rows = await db.select().from(gerenteRecurrencesTable)
    .where(and(eq(gerenteRecurrencesTable.tenantId, tenantId), eq(gerenteRecurrencesTable.active, true))).orderBy(asc(gerenteRecurrencesTable.nextAt));
  if (!rows.length) return "🔁 Nenhuma rotina ativa. Ex.: *todo dia 10 pagar 1.500 aluguel* ou *toda segunda 9h tarefa pro Alan: limpar a vitrine*.";
  return "🔁 *Rotinas ativas:*\n" + rows.map((r) => `• ${r.id} — ${describeRule(r.rule)}: ${r.kind === "tarefa" ? `tarefa${r.assigneeName ? ` (${r.assigneeName})` : ""} ` : r.kind === "conta" ? `conta ${r.amountCents ? brl(r.amountCents) : ""} ` : ""}${r.title} · próxima ${fmtWhen(r.nextAt)}`).join("\n");
}

export async function cancelRecurrence(tenantId: number, id: number): Promise<string> {
  const [r] = await db.update(gerenteRecurrencesTable).set({ active: false })
    .where(and(eq(gerenteRecurrencesTable.id, id), eq(gerenteRecurrencesTable.tenantId, tenantId))).returning();
  return r ? `🛑 Rotina ${id} cancelada (${r.title}).` : `Não achei a rotina ${id}.`;
}

/** Job: dispara as rotinas vencidas e agenda a próxima. */
export async function runRecurrences(settings: GerenteSettings): Promise<number> {
  const now = new Date();
  const due = await db.select().from(gerenteRecurrencesTable).where(and(
    eq(gerenteRecurrencesTable.tenantId, settings.tenantId), eq(gerenteRecurrencesTable.active, true), lte(gerenteRecurrencesTable.nextAt, now),
  )).limit(20);
  const g = await import("./gerente");
  let n = 0;
  for (const r of due) {
    // Reserva a ocorrência antes de criar (evita duplicar se o job rodar em paralelo).
    const next = nextOccurrence(r.rule, now);
    const [claimed] = await db.update(gerenteRecurrencesTable).set({ nextAt: next, lastRunAt: now })
      .where(and(eq(gerenteRecurrencesTable.id, r.id), eq(gerenteRecurrencesTable.nextAt, r.nextAt))).returning();
    if (!claimed) continue;
    try {
      if (r.kind === "tarefa") {
        const dueAt = parseSpLocal(`${spDateISO(r.nextAt)}T18:00`);
        await g.createTask(settings.tenantId, { title: r.title, assigneeName: r.assigneeName, dueAt: dueAt && dueAt > r.nextAt ? dueAt : new Date(r.nextAt.getTime() + 8 * 3_600_000), priority: "media" });
      } else if (r.kind === "conta" && r.amountCents) {
        if (settings.admSessionKey) {
          const { submitErpAction } = await import("./gerenteErp");
          await submitErpAction(settings, {
            type: r.billKind === "receber" ? "CREATE_RECEIVABLE" : "CREATE_PAYABLE", senderPhone: settings.lastPhone ?? "", messageText: `Rotina ${r.id}: ${r.title}`,
            summary: `${r.title} · ${brl(r.amountCents)} · vence ${spDateISO(r.nextAt)} (rotina ${r.id})`,
            payload: { description: r.title, totalAmount: r.amountCents / 100, dueDate: spDateISO(r.nextAt) },
          });
        } else {
          await g.createBill(settings.tenantId, { kind: r.billKind === "receber" ? "receber" : "pagar", description: r.title, amountCents: r.amountCents, dueDate: spDateISO(r.nextAt) });
        }
      } else {
        await g.createReminder(settings.tenantId, { title: r.title, dueAt: r.nextAt });
      }
      n++;
    } catch (err) {
      logger.warn({ err, recurrenceId: r.id }, "Gerente IA: falha ao disparar rotina");
    }
  }
  return n;
}

// ─── Fechamento do dia e relatório semanal ───────────────────────────────────

function dayRange(dateISO: string): { start: Date; end: Date } {
  const start = parseSpLocal(`${dateISO}T00:00`)!;
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export async function buildEveningSummary(settings: GerenteSettings): Promise<string> {
  const tenantId = settings.tenantId;
  const { start, end } = dayRange(spDateISO());
  const [doneRem, openRem, doneTasks, proofs, pendingDispatch] = await Promise.all([
    db.select({ title: gerenteRemindersTable.title }).from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "concluido"), gte(gerenteRemindersTable.updatedAt, start))),
    db.select({ title: gerenteRemindersTable.title }).from(gerenteRemindersTable).where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end))),
    db.select({ title: tasksTable.title }).from(tasksTable).where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.status, "done"), gte(tasksTable.updatedAt, start))),
    db.select({ title: tasksTable.title, who: gerenteTaskDispatchesTable.assigneeName }).from(gerenteTaskDispatchesTable).innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
      .where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), eq(gerenteTaskDispatchesTable.status, "concluida"), gte(gerenteTaskDispatchesTable.doneAt, start))),
    db.select({ title: tasksTable.title, who: gerenteTaskDispatchesTable.assigneeName }).from(gerenteTaskDispatchesTable).innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
      .where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), inArray(gerenteTaskDispatchesTable.status, ["enviada", "aguardando_prova"]), lt(tasksTable.dueDate, end))),
  ]);
  const lines = ["🌙 *Fechamento do dia*"];
  const done = doneRem.length + doneTasks.length;
  lines.push(`✅ Feito hoje: ${done} (${doneRem.length} lembrete${doneRem.length === 1 ? "" : "s"}, ${doneTasks.length} tarefa${doneTasks.length === 1 ? "" : "s"})`);
  if (proofs.length) lines.push(`📸 Com prova: ${proofs.map((p) => `${p.who.split(" ")[0]} — ${p.title}`).join("; ")}`);
  if (pendingDispatch.length) lines.push(`⏳ Equipe sem prova: ${pendingDispatch.map((p) => `${p.who.split(" ")[0]} — ${p.title}`).join("; ")}`);
  if (openRem.length) {
    lines.push(`📌 Ficou pendente: ${openRem.map((r) => r.title).join("; ")}`);
    lines.push("Responda *mover* pra passar o que ficou pra amanhã às 9h.");
  } else lines.push("Nada pendente seu pra hoje. 👏");
  return lines.join("\n");
}

/** "mover": lembretes pendentes de hoje/atrasados → amanhã 9h. */
export async function moveLeftoversToTomorrow(tenantId: number): Promise<string> {
  const { end } = dayRange(spDateISO());
  const tomorrow = spDateISO(new Date(end.getTime() + 12 * 3_600_000));
  const nine = parseSpLocal(`${tomorrow}T09:00`)!;
  const moved = await db.update(gerenteRemindersTable).set({ dueAt: nine, sentAt: null, updatedAt: new Date() })
    .where(and(eq(gerenteRemindersTable.tenantId, tenantId), eq(gerenteRemindersTable.status, "pendente"), lt(gerenteRemindersTable.dueAt, end))).returning({ id: gerenteRemindersTable.id });
  return moved.length ? `➡️ ${moved.length} lembrete(s) movido(s) pra amanhã às 9h.` : "Nada pra mover. 👍";
}

export async function buildWeeklyReport(settings: GerenteSettings): Promise<string> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db.select({ who: gerenteTaskDispatchesTable.assigneeName, status: gerenteTaskDispatchesTable.status, dueDate: tasksTable.dueDate, doneAt: gerenteTaskDispatchesTable.doneAt })
    .from(gerenteTaskDispatchesTable).innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
    .where(and(eq(gerenteTaskDispatchesTable.tenantId, settings.tenantId), gte(gerenteTaskDispatchesTable.createdAt, since), ne(gerenteTaskDispatchesTable.status, "cancelada")));
  if (!rows.length) return "📊 *Semana da equipe:* nenhuma tarefa enviada pelo WhatsApp nos últimos 7 dias.";
  const by = new Map<string, { total: number; done: number; onTime: number; late: number; open: number }>();
  const now = Date.now();
  for (const r of rows) {
    const k = r.who.split(" ")[0]!;
    const s = by.get(k) ?? { total: 0, done: 0, onTime: 0, late: 0, open: 0 };
    s.total++;
    if (r.status === "concluida") { s.done++; if (!r.dueDate || (r.doneAt && r.doneAt <= r.dueDate)) s.onTime++; }
    else if (r.dueDate && r.dueDate.getTime() < now) s.late++;
    else s.open++;
    by.set(k, s);
  }
  const ranked = [...by.entries()].sort((a, b) => b[1].done / b[1].total - a[1].done / a[1].total);
  return "📊 *Semana da equipe (tarefas pelo WhatsApp):*\n" + ranked.map(([k, s]) =>
    `• ${k}: ${s.done}/${s.total} concluídas com prova${s.onTime < s.done ? ` (${s.done - s.onTime} fora do prazo)` : ""}${s.late ? ` · ⚠️ ${s.late} atrasada(s)` : ""}${s.open ? ` · ${s.open} em aberto` : ""}`).join("\n");
}

/** Job: fechamento à noite e relatório na segunda de manhã. */
export async function runSummaries(settings: GerenteSettings, notify: (t: string) => Promise<boolean>): Promise<number> {
  const today = spDateISO();
  const hm = spTimeHM();
  let n = 0;
  if (settings.eveningSummaryTime && settings.eveningSentOn !== today && hm >= settings.eveningSummaryTime) {
    if (await notify(await buildEveningSummary(settings))) {
      await db.update(gerenteSettingsTable).set({ eveningSentOn: today }).where(eq(gerenteSettingsTable.id, settings.id)); n++;
    }
  }
  if (spParts().weekday === 1 && settings.weeklyReportSentOn !== today && hm >= "08:00" && hm < "12:00") {
    if (await notify(await buildWeeklyReport(settings))) {
      await db.update(gerenteSettingsTable).set({ weeklyReportSentOn: today }).where(eq(gerenteSettingsTable.id, settings.id)); n++;
    }
  }
  return n;
}

// ─── Comandos de texto ───────────────────────────────────────────────────────

/** Comandos novos (link, rotinas, mover, relatório). null = não é um deles. */
export async function tryExtraCommand(settings: GerenteSettings, text: string): Promise<string | null> {
  const t = norm(text);
  const linkTask = t.match(/^(?:link|abrir|abre|ver)(?: d[ao])? tarefa\s*#?\s*(\d+)\??$/);
  if (linkTask) {
    const id = Number(linkTask[1]);
    const [task] = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable)
      .where(and(eq(tasksTable.id, id), eq(tasksTable.tenantId, settings.tenantId))).limit(1);
    if (!task) return `Não achei a tarefa ${id}.`;
    return `🔗 Tarefa *${task.id} — ${task.title}*:\n${await createLink(settings, "task", task.id, 30)}\n(abre sem login, vale 30 dias — dá pra comentar, ativar, concluir e avisar o responsável)`;
  }
  if (/^(link|links|link do (meu )?dia|abrir (meu )?dia|painel|meu painel|link do painel|link das tarefas)\??$/.test(t)) {
    return `🔗 Seu dia, tarefas da equipe e provas:\n${await createLink(settings, "dia", null, 7)}\n(abre sem login, vale 7 dias — toque na tarefa pra comentar, concluir ou avisar a equipe)`;
  }
  if (/^(rotinas|minhas rotinas|recorrentes|lembretes fixos)\??$/.test(t)) return listRecurrences(settings.tenantId);
  const cancel = t.match(/^(?:cancelar|cancela|parar|para|apagar) rotina\s*#?\s*(\d+)$/);
  if (cancel) return cancelRecurrence(settings.tenantId, Number(cancel[1]));
  if (/^(mover|move|passa pra amanha|passar pra amanha|joga pra amanha)$/.test(t)) return moveLeftoversToTomorrow(settings.tenantId);
  if (/^(fechamento|fechar o dia|resumo da noite)$/.test(t)) return buildEveningSummary(settings);
  if (/^(relatorio|relatorio da semana|semana da equipe|equipe na semana)$/.test(t)) return buildWeeklyReport(settings);
  const rec = await tryCreateRecurrence(settings, text);
  if (rec) return rec;
  return null;
}
