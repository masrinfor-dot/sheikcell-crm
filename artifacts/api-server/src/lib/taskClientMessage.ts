import { and, desc, eq, inArray } from "drizzle-orm";
import { db, conversationsTable, crmContactsTable, scheduledMessagesTable } from "@workspace/db";
import { phoneVariants } from "./phone";

// Mensagem automática pro cliente ao criar/editar uma tarefa com Cliente +
// prazo (pedido 10/09: "cadastra msg automática para cliente retornar") —
// mesmo mecanismo de scheduled_messages já usado pelo "Agendar" dentro de
// uma conversa (ver /chat/conversations/:id/schedules), só disparado a
// partir do quadro de Tarefas em vez de dentro do chat. Reaproveita a
// conversa mais recente do cliente (qualquer status — o job de envio só
// precisa do telefone/linha, não importa se está resolvida/arquivada);
// nunca cria uma conversa nova aqui (isso tem regras próprias de
// anti-spam/linha de WhatsApp em POST /chat/conversations que não fazem
// sentido reaplicar por trás de uma tarefa). Falha aqui NUNCA impede a
// tarefa de ser criada/salva — só volta um aviso pro usuário resolver.
export async function scheduleClientMessageForTask(
  tenantId: number,
  // Tarefas no ERP (19/10/2026): `id` nulo e `erpTaskNumber` = número lá.
  task: { id: number | null; contactId: number | null; dueDate: Date | null; erpTaskNumber?: number | null },
  content: string,
  userId: number | null,
): Promise<string | null> {
  if (!task.contactId) return "Selecione um cliente na tarefa para agendar a mensagem automática.";
  if (!task.dueDate) return "Defina um prazo na tarefa para agendar a mensagem automática.";
  if (task.dueDate.getTime() < Date.now() - 60_000) return "O prazo já passou — mensagem automática não agendada.";
  const [contact] = await db.select({ phone: crmContactsTable.phone }).from(crmContactsTable)
    .where(and(eq(crmContactsTable.id, task.contactId), eq(crmContactsTable.tenantId, tenantId))).limit(1);
  const variants = phoneVariants(contact?.phone);
  if (variants.length === 0) return "Esse cliente não tem telefone cadastrado — mensagem automática não agendada.";
  const [conv] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(eq(conversationsTable.tenantId, tenantId), inArray(conversationsTable.phone, variants)))
    .orderBy(desc(conversationsTable.lastMessageAt)).limit(1);
  if (!conv) return "Esse cliente ainda não tem nenhum atendimento registrado — inicie uma conversa com ele antes de agendar a mensagem automática.";
  await db.insert(scheduledMessagesTable).values({
    tenantId, conversationId: conv.id, kind: "mensagem",
    content: content.trim().slice(0, 2000), sendAt: task.dueDate, createdById: userId, taskId: task.id,
    erpTaskNumber: task.erpTaskNumber ?? null,
  });
  return null;
}
