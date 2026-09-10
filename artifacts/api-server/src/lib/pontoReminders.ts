import { and, eq, gte, lte } from "drizzle-orm";
import { db, employeesTable, workShiftsTable, timeClockEntriesTable, tenantsTable, pontoRemindersTable } from "@workspace/db";
import { todayInfo, isOnLeaveToday } from "./routinesShared";
import { employeeNeedsClockInToday } from "./timeBank";
import { sendRawWhatsAppText } from "./outbound";
import { normalizePhone } from "./phone";
import { logger } from "./logger";

// Lembrete de ponto por WhatsApp (pedido 10/09, análise Tangerino): avisa
// quem tem escala fixa (workShiftsTable.type === "fixed") e ainda não bateu
// a entrada (passados alguns minutos do horário) ou esqueceu de bater a
// saída (turno em aberto, passados alguns minutos do fim do horário).
// Usa a MESMA linha de WhatsApp já configurada pro check-in por foto
// (tenants.pontoCheckInSessionKey) — sem WhatsApp configurado, não manda
// nada (não é obrigatório pra usar o resto do RH).
// Idempotente via ponto_reminders (um por colaborador/dia/tipo) — seguro
// rodar de novo a cada tick.
const GRACE_MINUTES = 15;

function parseHHMMToMinutes(v: string | null): number | null {
  if (!v || !/^\d{2}:\d{2}$/.test(v)) return null;
  const [h, m] = v.split(":").map(Number);
  return h! * 60 + m!;
}

async function sendReminder(
  tenantId: number, employeeId: number, dateKey: string, kind: "entrada" | "saida",
  phone: string, sessionKey: string, text: string,
): Promise<void> {
  const [claimed] = await db.insert(pontoRemindersTable)
    .values({ tenantId, employeeId, dateKey, kind })
    .onConflictDoNothing({ target: [pontoRemindersTable.employeeId, pontoRemindersTable.dateKey, pontoRemindersTable.kind] })
    .returning({ id: pontoRemindersTable.id });
  if (!claimed) return; // já mandou esse lembrete hoje
  const delivered = await sendRawWhatsAppText(phone, sessionKey, text);
  if (!delivered) logger.warn({ employeeId, kind }, "Lembrete de ponto não entregue pelo bridge");
}

let running = false;
export async function sendPontoReminders(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const tenants = await db.select({ id: tenantsTable.id, pontoCheckInSessionKey: tenantsTable.pontoCheckInSessionKey }).from(tenantsTable);
    const info = todayInfo();
    for (const tenant of tenants) {
      const sessionKey = tenant.pontoCheckInSessionKey;
      if (!sessionKey) continue;
      const employees = await db.select().from(employeesTable)
        .where(and(eq(employeesTable.tenantId, tenant.id), eq(employeesTable.isActive, true)));
      for (const emp of employees) {
        try {
          if (!emp.phone || !emp.shiftId) continue;
          const phone = normalizePhone(emp.phone);
          if (!phone) continue;
          const [shift] = await db.select().from(workShiftsTable).where(eq(workShiftsTable.id, emp.shiftId));
          if (!shift || shift.type !== "fixed") continue;
          if (!shift.weekdays.includes(info.weekday)) continue;
          if (await isOnLeaveToday(tenant.id, emp.id, info.dateKey)) continue;
          const firstName = emp.name.split(" ")[0] ?? emp.name;

          const startMin = parseHHMMToMinutes(shift.startTime);
          if (startMin != null && info.nowMinutes >= startMin + GRACE_MINUTES) {
            const needsIn = await employeeNeedsClockInToday(emp.id, tenant.id, shift);
            if (needsIn) {
              await sendReminder(tenant.id, emp.id, info.dateKey, "entrada", phone, sessionKey,
                `Oi, ${firstName}! 👋 Notei que você ainda não bateu o ponto de entrada hoje. Não esqueça de registrar, combinado?`);
            }
          }

          const endMin = parseHHMMToMinutes(shift.endTime);
          if (endMin != null && info.nowMinutes >= endMin + GRACE_MINUTES) {
            const dayStart = new Date(`${info.dateKey}T00:00:00-03:00`);
            const dayEnd = new Date(`${info.dateKey}T23:59:59-03:00`);
            const entriesToday = await db.select().from(timeClockEntriesTable)
              .where(and(
                eq(timeClockEntriesTable.employeeId, emp.id), eq(timeClockEntriesTable.tenantId, tenant.id),
                gte(timeClockEntriesTable.at, dayStart), lte(timeClockEntriesTable.at, dayEnd),
              ));
            const hasIn = entriesToday.some((e) => e.kind === "in");
            const hasOut = entriesToday.some((e) => e.kind === "out");
            if (hasIn && !hasOut) {
              await sendReminder(tenant.id, emp.id, info.dateKey, "saida", phone, sessionKey,
                `Oi, ${firstName}! 👋 Vi que seu ponto de hoje ainda está aberto — não esqueça de bater a saída antes de ir, combinado?`);
            }
          }
        } catch (err) {
          logger.warn({ err, employeeId: emp.id }, "Falha ao processar lembrete de ponto de um colaborador");
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de lembretes de ponto falhou");
  } finally {
    running = false;
  }
}
