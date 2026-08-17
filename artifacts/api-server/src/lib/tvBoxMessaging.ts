import { and, eq, inArray, isNull, lte, sql, desc } from "drizzle-orm";
import { db, sectorsTable, conversationsTable, tvBoxClientsTable, tvBoxInvoicesTable } from "@workspace/db";
import { normalizePhone, phoneVariants } from "./phone";
import { sendOutboundText } from "./outbound";
import { logger } from "./logger";
import { getTvBoxSettings, renderTvBoxMessage } from "./tvBoxSettings";

const TV_BOX_SECTOR_NAME = "TV Box";

// Garante que a loja tem um setor "TV Box" (cria na primeira vez) e devolve o
// id. Índice único parcial (tenant_id) WHERE name = 'TV Box' garante uma
// linha só por loja mesmo sob acesso concorrente (mesmo padrão de
// ensureGeneralRoom() no chat interno).
export async function ensureTvBoxSector(tenantId: number): Promise<number> {
  const [existing] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
    .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.name, TV_BOX_SECTOR_NAME))).limit(1);
  if (existing) return existing.id;

  // "shopping-bag": ícone válido em SectorIcon.tsx (não há um de TV no mapa
  // hoje, e expandi-lo por uma única loja não vale a pena).
  await db.insert(sectorsTable)
    .values({ tenantId, name: TV_BOX_SECTOR_NAME, icon: "shopping-bag", color: "#7c3aed" })
    .onConflictDoNothing();
  const [row] = await db.select({ id: sectorsTable.id }).from(sectorsTable)
    .where(and(eq(sectorsTable.tenantId, tenantId), eq(sectorsTable.name, TV_BOX_SECTOR_NAME))).limit(1);
  return row!.id;
}

// Acha (ou cria) a conversa de WhatsApp deste cliente DENTRO do setor da TV
// Box — escopado ao setor de propósito, pra nunca herdar/misturar com uma
// conversa antiga de vendas do mesmo telefone em outro setor.
async function findOrCreateTvBoxConversation(tenantId: number, phone: string, name: string, sectorId: number): Promise<number> {
  const matchCandidates = phoneVariants(phone);
  const [existing] = await db.select({ id: conversationsTable.id }).from(conversationsTable)
    .where(and(
      eq(conversationsTable.tenantId, tenantId),
      inArray(conversationsTable.phone, matchCandidates),
      eq(conversationsTable.sectorId, sectorId),
      eq(conversationsTable.isArchived, false),
    ))
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db.insert(conversationsTable).values({
    tenantId,
    phone: normalizePhone(phone) || phone,
    name,
    channel: "whatsapp",
    sectorId,
    status: "open",
  }).returning({ id: conversationsTable.id });
  return created!.id;
}

async function sendTvBoxMessage(
  client: { id: number; tenantId: number; name: string; phone: string },
  template: string,
  vars: { valorCents: number; vencimento: string; dias: number },
): Promise<boolean> {
  const sectorId = await ensureTvBoxSector(client.tenantId);
  const conversationId = await findOrCreateTvBoxConversation(client.tenantId, client.phone, client.name, sectorId);
  const text = renderTvBoxMessage(template, { nome: client.name, ...vars });
  return sendOutboundText(conversationId, text, "Cobrança TV Box");
}

// Um lote pequeno por tick — mesmo espírito do limite das mensagens agendadas
// (20) e dos lembretes de pesquisa (50): mesmo com uma base grande de
// clientes, os envios se espalham por vários ticks em vez de estourar tudo
// de uma vez (a fila anti-ban do bridge já espaça CADA envio, mas isso aqui
// evita abrir uma rajada de conversas novas no mesmo minuto).
const BATCH_LIMIT = 30;

// ── Lembrete pré-vencimento (um por fatura) ──────────────────────────────────
let remindersRunning = false;
export async function sendTvBoxReminders(now: Date = new Date()): Promise<void> {
  if (remindersRunning) return;
  remindersRunning = true;
  try {
    // Candidatas: pendente, sem lembrete ainda, com vencimento dentro da
    // janela configurada por loja — o filtro fino (reminderDaysBefore exato
    // por loja) acontece abaixo, esta query só reduz o universo.
    const candidates = await db
      .select({
        invoiceId: tvBoxInvoicesTable.id, dueDate: tvBoxInvoicesTable.dueDate, amountCents: tvBoxInvoicesTable.amountCents,
        clientId: tvBoxClientsTable.id, tenantId: tvBoxClientsTable.tenantId, name: tvBoxClientsTable.name, phone: tvBoxClientsTable.phone,
      })
      .from(tvBoxInvoicesTable)
      .innerJoin(tvBoxClientsTable, eq(tvBoxClientsTable.id, tvBoxInvoicesTable.clientId))
      .where(and(
        eq(tvBoxInvoicesTable.status, "pendente"),
        isNull(tvBoxInvoicesTable.reminderSentAt),
        eq(tvBoxClientsTable.status, "ativo"),
        lte(tvBoxInvoicesTable.dueDate, sql`(current_date + interval '27 days')::date`),
      ))
      .limit(BATCH_LIMIT * 3); // filtro fino por loja reduz mais abaixo

    const settingsByTenant = new Map<number, Awaited<ReturnType<typeof getTvBoxSettings>>>();
    let sent = 0;
    for (const c of candidates) {
      if (sent >= BATCH_LIMIT) break;
      try {
        let cfg = settingsByTenant.get(c.tenantId);
        if (!cfg) {
          cfg = await getTvBoxSettings(c.tenantId);
          settingsByTenant.set(c.tenantId, cfg);
        }
        if (!cfg.enabled) continue;
        const dueMs = new Date(`${c.dueDate}T00:00:00`).getTime();
        const daysUntilDue = Math.ceil((dueMs - now.getTime()) / 86_400_000);
        if (daysUntilDue < 0 || daysUntilDue > cfg.reminderDaysBefore) continue;

        // Reivindica ANTES de enviar: se outro tick já pegou essa fatura, o
        // UPDATE não acha a linha e nada é enviado de novo.
        const claimed = await db.update(tvBoxInvoicesTable)
          .set({ reminderSentAt: now })
          .where(and(eq(tvBoxInvoicesTable.id, c.invoiceId), isNull(tvBoxInvoicesTable.reminderSentAt)))
          .returning({ id: tvBoxInvoicesTable.id });
        if (claimed.length === 0) continue;

        const delivered = await sendTvBoxMessage(
          { id: c.clientId, tenantId: c.tenantId, name: c.name, phone: c.phone },
          cfg.reminderMessageTemplate,
          { valorCents: c.amountCents, vencimento: c.dueDate, dias: daysUntilDue },
        );
        if (!delivered) logger.warn({ invoiceId: c.invoiceId }, "Lembrete de TV Box não entregue pelo bridge");
        sent++;
      } catch (err) {
        logger.warn({ err, invoiceId: c.invoiceId }, "Falha ao processar lembrete de TV Box");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de lembretes de TV Box falhou");
  } finally {
    remindersRunning = false;
  }
}

// ── Cobrança recorrente pós-vencimento ───────────────────────────────────────
let chargesRunning = false;
export async function sendTvBoxCharges(now: Date = new Date()): Promise<void> {
  if (chargesRunning) return;
  chargesRunning = true;
  try {
    const today = now.toISOString().slice(0, 10);
    const candidates = await db
      .select({
        invoiceId: tvBoxInvoicesTable.id, dueDate: tvBoxInvoicesTable.dueDate, amountCents: tvBoxInvoicesTable.amountCents,
        lastChargeSentAt: tvBoxInvoicesTable.lastChargeSentAt,
        clientId: tvBoxClientsTable.id, tenantId: tvBoxClientsTable.tenantId, name: tvBoxClientsTable.name, phone: tvBoxClientsTable.phone,
      })
      .from(tvBoxInvoicesTable)
      .innerJoin(tvBoxClientsTable, eq(tvBoxClientsTable.id, tvBoxInvoicesTable.clientId))
      .where(and(
        eq(tvBoxInvoicesTable.status, "pendente"),
        eq(tvBoxClientsTable.status, "ativo"),
        sql`${tvBoxInvoicesTable.dueDate} < ${today}::date`,
      ))
      .limit(BATCH_LIMIT * 3);

    const settingsByTenant = new Map<number, Awaited<ReturnType<typeof getTvBoxSettings>>>();
    let sent = 0;
    for (const c of candidates) {
      if (sent >= BATCH_LIMIT) break;
      try {
        let cfg = settingsByTenant.get(c.tenantId);
        if (!cfg) {
          cfg = await getTvBoxSettings(c.tenantId);
          settingsByTenant.set(c.tenantId, cfg);
        }
        if (!cfg.enabled) continue;
        const daysOverdue = Math.floor((now.getTime() - new Date(`${c.dueDate}T00:00:00`).getTime()) / 86_400_000);
        const dueForCharge = c.lastChargeSentAt == null
          || (now.getTime() - c.lastChargeSentAt.getTime()) >= cfg.overdueMessageIntervalDays * 86_400_000;
        if (!dueForCharge) continue;

        // Reivindica ANTES de enviar, condicionado ao mesmo last_charge_sent_at
        // já lido: se outro tick reivindicou primeiro, o UPDATE não acha a
        // linha e nada é enviado de novo.
        const claimed = await db.update(tvBoxInvoicesTable)
          .set({ lastChargeSentAt: now })
          .where(and(
            eq(tvBoxInvoicesTable.id, c.invoiceId),
            c.lastChargeSentAt == null ? isNull(tvBoxInvoicesTable.lastChargeSentAt) : eq(tvBoxInvoicesTable.lastChargeSentAt, c.lastChargeSentAt),
          ))
          .returning({ id: tvBoxInvoicesTable.id });
        if (claimed.length === 0) continue;

        const delivered = await sendTvBoxMessage(
          { id: c.clientId, tenantId: c.tenantId, name: c.name, phone: c.phone },
          cfg.chargeMessageTemplate,
          { valorCents: c.amountCents, vencimento: c.dueDate, dias: daysOverdue },
        );
        if (!delivered) logger.warn({ invoiceId: c.invoiceId }, "Cobrança de TV Box não entregue pelo bridge");
        sent++;
      } catch (err) {
        logger.warn({ err, invoiceId: c.invoiceId }, "Falha ao processar cobrança de TV Box");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de cobrança de TV Box falhou");
  } finally {
    chargesRunning = false;
  }
}
