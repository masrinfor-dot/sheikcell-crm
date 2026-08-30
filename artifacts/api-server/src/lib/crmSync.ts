import { db, crmContactsTable, usersTable, sectorsTable } from "@workspace/db";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { broadcast } from "./sseEmitter";
import { normalizePhone, phoneVariants } from "./phone";

// Coluna do quadro CRM correspondente ao estado da conversa no atendimento.
// Espelha as categorias do ChatCenter: sem responsável e aberta = Potencial;
// sem responsável em "pending" = Pendente; com responsável (ainda em
// atendimento) = Ativo; conversa resolvida/arquivada = Finalizado (coluna
// própria — antes ficava misturada em "Ativos", inflando essa métrica com
// gente que já não está mais em atendimento).
export function crmStageForConversation(conv: {
  assigneeId: number | null;
  status: string;
  isArchived?: boolean | null;
}): "potential" | "pending" | "active" | "finalized" {
  if (conv.status === "resolved" || conv.status === "archived" || conv.isArchived) {
    return "finalized";
  }
  if (conv.assigneeId != null) return "active";
  return conv.status === "pending" ? "pending" : "potential";
}

/**
 * Keeps the CRM card in sync with the chat: whenever a conversation changes
 * assignee OR status, mirror the attendant and the board column (stage) into
 * the matching CRM contact (same normalized phone + sector) and broadcast a
 * crm_contact_updated event so the board updates live. Best-effort: never
 * throws (a CRM desync must not break claim/transfer flows).
 */
export async function syncCrmAttendant(conv: {
  tenantId: number;
  phone: string | null;
  sectorId: number | null;
  assigneeId: number | null;
  status: string;
  isArchived?: boolean | null;
}, resolutionReason?: string | null): Promise<void> {
  try {
    const isGroup = (conv.phone ?? "").includes("@g.us");
    const sectorCondition = conv.sectorId != null
      ? eq(crmContactsTable.sectorId, conv.sectorId)
      : isNull(crmContactsTable.sectorId);
    // Grupo/comunidade: não tem telefone de verdade pra comparar por
    // variações — casa pelo JID cru guardado em "contact" (ver
    // ensureCrmContactForConversation, que é quem cria essa ficha).
    const identityCondition = isGroup
      ? eq(crmContactsTable.contact, conv.phone ?? "")
      : (() => {
          const variants = phoneVariants(conv.phone);
          return variants.length > 0 ? inArray(crmContactsTable.phone, variants) : null;
        })();
    if (!identityCondition) return;

    // Multi-loja: só sincroniza com o contato do CRM da MESMA loja. Compara
    // por todas as variações plausíveis do número (com/sem DDI, com/sem o 9º
    // dígito) pra não perder o contato salvo num formato antigo.
    const [existing] = await db.select().from(crmContactsTable)
      .where(and(
        eq(crmContactsTable.tenantId, conv.tenantId),
        eq(crmContactsTable.isArchived, false),
        identityCondition,
        sectorCondition,
      ))
      .limit(1);
    if (!existing) return;
    const stage = crmStageForConversation(conv);
    const reasonChanged = stage === "finalized" && resolutionReason !== undefined && resolutionReason !== existing.lastResolutionReason;
    if (existing.attendantId === conv.assigneeId && existing.status === stage && !reasonChanged) return;

    const [updated] = await db.update(crmContactsTable)
      .set({
        attendantId: conv.assigneeId,
        status: stage,
        updatedAt: new Date(),
        // Motivo de finalização: grava quando a conversa acabou de ser resolvida
        // (resolutionReason informado); some ao reabrir (voltou a não ser "finalized").
        ...(stage === "finalized"
          ? { ...(resolutionReason !== undefined ? { lastResolutionReason: resolutionReason } : {}), ...(existing.status !== "finalized" ? { finalizedAt: new Date() } : {}) }
          : { lastResolutionReason: null, finalizedAt: null }),
      })
      .where(eq(crmContactsTable.id, existing.id))
      .returning();

    // Enriquecimento mínimo igual ao do CRM (attendant/sector) p/ o board.
    const attendant = updated.attendantId
      ? (await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
          .where(eq(usersTable.id, updated.attendantId)).limit(1))[0] ?? null
      : null;
    const sector = updated.sectorId
      ? (await db.select().from(sectorsTable).where(eq(sectorsTable.id, updated.sectorId)).limit(1))[0] ?? null
      : null;
    broadcast("crm_contact_updated", { ...updated, attendant, sector }, { tenantId: updated.tenantId, sectorId: updated.sectorId, isPotential: false });
  } catch (err) {
    logger.warn({ err, phone: conv.phone, sectorId: conv.sectorId }, "CRM attendant sync failed");
  }
}

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
  tenantId: number;
  phone: string | null;
  name: string;
  sectorId: number | null;
  assigneeId?: number | null;
  channel?: string | null;
  status?: string;
  isArchived?: boolean | null;
}): Promise<void> {
  try {
    const isGroup = (conv.phone ?? "").includes("@g.us");
    // Grupo/comunidade do WhatsApp: não tem telefone de cliente único pra
    // normalizar, mas o pedido é ter ficha mesmo assim (ex.: acompanhar o
    // grupo de revenda de uma loja parceira). Identifica pelo JID cru
    // ("...@g.us") guardado em "contact" -- "phone" fica sempre null pra não
    // gerar número falso a partir dos dígitos do JID.
    const normalizedPhone = isGroup ? null : normalizePhone(conv.phone);
    const variants = isGroup ? [] : phoneVariants(conv.phone);
    if (!isGroup && (!normalizedPhone || variants.length === 0)) return;

    const sectorCondition = conv.sectorId != null
      ? eq(crmContactsTable.sectorId, conv.sectorId)
      : isNull(crmContactsTable.sectorId);
    const identityCondition = isGroup
      ? eq(crmContactsTable.contact, conv.phone ?? "")
      : inArray(crmContactsTable.phone, variants);

    // Multi-loja: busca/cria o contato do CRM sempre dentro da loja da conversa.
    // Compara por todas as variações plausíveis (com/sem DDI, com/sem o 9º
    // dígito) — sem isso, o mesmo cliente ganha um contato de CRM novo toda
    // vez que o número chega formatado diferente do que já está salvo.
    const [existing] = await db.select().from(crmContactsTable)
      .where(and(
        eq(crmContactsTable.tenantId, conv.tenantId),
        eq(crmContactsTable.isArchived, false),
        identityCondition,
        sectorCondition,
      ))
      .limit(1);

    // Coluna do quadro espelhando o estado da conversa (Potencial/Pendente/Ativo).
    const stage = conv.status !== undefined
      ? crmStageForConversation({ assigneeId: conv.assigneeId ?? null, status: conv.status, isArchived: conv.isArchived })
      : null;

    if (existing) {
      await db.update(crmContactsTable)
        .set({
          updatedAt: new Date(),
          // Nome do grupo pode mudar no WhatsApp (renomear o grupo) — acompanha.
          ...(isGroup && existing.name !== conv.name ? { name: conv.name } : {}),
          // Conversa já nasce com responsável (ex.: criada por vendedor):
          // reflete no cartão do CRM sem apagar um atendente já definido.
          ...(conv.assigneeId != null ? { attendantId: conv.assigneeId } : {}),
          ...(stage != null ? { status: stage } : {}),
          // Convergência gradual pra forma canônica (ver comentário acima).
          ...(!isGroup && existing.phone !== normalizedPhone ? { phone: normalizedPhone } : {}),
        })
        .where(eq(crmContactsTable.id, existing.id));
    } else {
      await db.insert(crmContactsTable).values({
        tenantId: conv.tenantId,
        name: conv.name,
        contact: conv.phone,
        phone: normalizedPhone,
        sectorId: conv.sectorId,
        attendantId: conv.assigneeId ?? null,
        status: stage ?? "active",
        profile: "Novo",
        attendanceSource: conv.channel === "whatsapp" ? (isGroup ? "WhatsApp (grupo)" : "WhatsApp") : null,
      });
    }
  } catch (err) {
    // Linkage is best-effort; never block message ingestion or chat creation,
    // but log so a CRM desync is detectable instead of silent.
    logger.warn({ err, phone: conv.phone, sectorId: conv.sectorId }, "CRM sync at conversation start failed");
  }
}
