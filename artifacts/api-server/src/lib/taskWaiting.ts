import { and, eq, inArray } from "drizzle-orm";
import { db, taskWaitingTable } from "@workspace/db";

// Tela "Equipe" (29/10/2026): pedido "Esperando alguém". O quadro de tarefas
// só tem a fazer / fazendo / feito (aqui e no ERP), então quem o pedido está
// esperando fica numa tabela do CRM ligada ao número da tarefa. As duas rotas
// do quadro (routes/tasks.ts e routes/tasksErp.ts) usam estas funções:
//  - GET /tasks devolve waitingFor/waitingSince em cada tarefa;
//  - PATCH /tasks/:id aceita waitingFor (texto = esperando; null = voltou).
//    Mudar o status sem mandar waitingFor tira o "esperando".

export type Waiting = { waitingFor: string | null; waitingSince: string | null };

const NONE: Waiting = { waitingFor: null, waitingSince: null };

/** Texto de "esperando quem" limpo (vazio = "alguém"); undefined = não mexer; null = tirar. */
export function cleanWaitingFor(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === false) return null;
  const s = String(raw).replace(/\s+/g, " ").trim().slice(0, 80);
  return s || "alguém";
}

/**
 * O que fazer com o "esperando" num PATCH: valor novo, tirar (null) ou não
 * mexer (undefined). Mudou o status sem dizer nada do "esperando" = tirou.
 */
export function waitingChange(
  body: { waitingFor?: unknown; status?: unknown },
  currentStatus: string,
): string | null | undefined {
  const w = cleanWaitingFor(body.waitingFor);
  if (w !== undefined) return w;
  if (typeof body.status === "string" && body.status !== currentStatus) return null;
  return undefined;
}

export async function waitingMap(tenantId: number, taskIds: number[]): Promise<Map<number, Waiting>> {
  const ids = [...new Set(taskIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(taskWaitingTable)
    .where(and(eq(taskWaitingTable.tenantId, tenantId), inArray(taskWaitingTable.taskId, ids)));
  return new Map(rows.map((r) => [r.taskId, { waitingFor: r.waitingFor, waitingSince: r.since.toISOString() }]));
}

/** Junta waitingFor/waitingSince em cada tarefa (feitas nunca aparecem esperando). */
export async function withWaiting<T extends { id: number; status: string }>(tenantId: number, tasks: T[]): Promise<(T & Waiting)[]> {
  const map = await waitingMap(tenantId, tasks.map((t) => t.id));
  return tasks.map((t) => ({ ...t, ...(t.status === "done" ? NONE : (map.get(t.id) ?? NONE)) }));
}

export async function setWaiting(tenantId: number, taskId: number, waitingFor: string | null, userId: number | null): Promise<void> {
  if (waitingFor == null) {
    await db.delete(taskWaitingTable).where(and(eq(taskWaitingTable.tenantId, tenantId), eq(taskWaitingTable.taskId, taskId)));
    return;
  }
  await db.insert(taskWaitingTable)
    .values({ tenantId, taskId, waitingFor, setById: userId, since: new Date() })
    .onConflictDoUpdate({
      target: [taskWaitingTable.tenantId, taskWaitingTable.taskId],
      set: { waitingFor, setById: userId, since: new Date() },
    });
}
