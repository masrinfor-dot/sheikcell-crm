import { db, crmContactsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Links a conversation to a CRM contact at attendance START (find-or-create by
 * normalized phone, scoped to the conversation's sector). This keeps the CRM in
 * sync with active atendimentos so a customer shows up in the CRM as soon as the
 * conversation begins — not only when it is resolved.
 *
 * Unlike the resolution sync, this does NOT write an attendance_log (the log is
 * an end-of-service record) and never throws: CRM linkage must not break inbound
 * message ingestion or manual conversation creation.
 */
export async function ensureCrmContactForConversation(conv: {
  phone: string | null;
  name: string;
  sectorId: number | null;
  assigneeId?: number | null;
  channel?: string | null;
}): Promise<void> {
  try {
    // Grupos/comunidades do WhatsApp não são clientes — não entram no CRM.
    if ((conv.phone ?? "").includes("@g.us")) return;
    const normalizedPhone = (conv.phone ?? "").replace(/\D/g, "");
    if (!normalizedPhone) return;

    const sectorCondition = conv.sectorId != null
      ? eq(crmContactsTable.sectorId, conv.sectorId)
      : isNull(crmContactsTable.sectorId);

    const [existing] = await db.select().from(crmContactsTable)
      .where(and(
        eq(crmContactsTable.isArchived, false),
        eq(crmContactsTable.phone, normalizedPhone),
        sectorCondition,
      ))
      .limit(1);

    if (existing) {
      await db.update(crmContactsTable)
        .set({ updatedAt: new Date() })
        .where(eq(crmContactsTable.id, existing.id));
    } else {
      await db.insert(crmContactsTable).values({
        name: conv.name,
        contact: conv.phone,
        phone: normalizedPhone,
        sectorId: conv.sectorId,
        attendantId: conv.assigneeId ?? null,
        status: "active",
        profile: "Novo",
        attendanceSource: conv.channel === "whatsapp" ? "WhatsApp" : null,
      });
    }
  } catch (err) {
    // Linkage is best-effort; never block message ingestion or chat creation,
    // but log so a CRM desync is detectable instead of silent.
    logger.warn({ err, phone: conv.phone, sectorId: conv.sectorId }, "CRM sync at conversation start failed");
  }
}
