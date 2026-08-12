import { Router, type IRouter } from "express";
import type { PoolClient } from "pg";
import { pool, db, usersTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/auth";

/**
 * ROTA TEMPORÁRIA — dor de cabeça de origem: o console SQL do EasyPanel corta
 * colagens grandes no meio (erro de sintaxe), então rodar a mesclagem de
 * duplicatas por lá não funcionava. Isto expõe a MESMA lógica de
 * scripts/src/mergeDuplicates.ts por HTTP, atrás de requireSuperadmin,
 * usando o pool de conexão que a própria API já tem (sem precisar de túnel
 * SSH nem de DATABASE_URL separada).
 *
 * É uma cópia intencional da lógica do script (mesmo padrão de duplicação
 * já usado para normalizePhone em phone.ts) — se um dos dois for corrigido,
 * revisar o outro. Remover esta rota depois que a mesclagem for aplicada e
 * conferida em produção.
 */

const router: IRouter = Router();
router.use("/superadmin", requireSuperadmin);

// ---------------------------------------------------------------------------
// Normalização de telefone — mesma cópia usada em scripts/src/mergeDuplicates.ts
const DDI_BR = "55";

function digitsOnly(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

function normalizePhone(raw: string | null | undefined): string {
  let d = digitsOnly(raw);
  if (!d) return d;
  if (d.startsWith("0") && d.length > 10) d = d.slice(1);
  if (d.length === 10 || d.length === 11) d = DDI_BR + d;
  if (d.startsWith(DDI_BR) && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(DDI_BR.length, DDI_BR.length + 2);
    const local = d.slice(DDI_BR.length + 2);
    if (local.length === 8 && /^[6-9]/.test(local)) {
      d = DDI_BR + ddd + "9" + local;
    }
  }
  return d;
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string | null | undefined): T[][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return [...map.values()].filter((group) => group.length > 1);
}

interface GroupDetail {
  tenantId: number;
  phone: string;
  canonicalId: number;
  archivedIds: number[];
}

interface Report {
  conversations: { groups: number; archived: number; detail: GroupDetail[] };
  contacts: { groups: number; archived: number; detail: GroupDetail[] };
}

async function mergeConversations(client: PoolClient, report: Report, apply: boolean): Promise<void> {
  const { rows: conversations } = await client.query(
    `SELECT id, tenant_id, phone, created_at FROM conversations`,
  );
  const { rows: msgStats } = await client.query(
    `SELECT conversation_id, COUNT(*)::int AS cnt, MAX(created_at) AS last_at
     FROM messages GROUP BY conversation_id`,
  );
  const statsByConv = new Map(msgStats.map((r) => [r.conversation_id, r]));

  const groups = groupBy(conversations, (c) => `${c.tenant_id}:${normalizePhone(c.phone)}`);

  for (const group of groups) {
    const scored = group.map((c) => ({
      ...c,
      msgCount: statsByConv.get(c.id)?.cnt ?? 0,
      lastAt: statsByConv.get(c.id)?.last_at ?? null,
    }));
    scored.sort((a, b) => {
      if (b.msgCount !== a.msgCount) return b.msgCount - a.msgCount;
      const aLast = a.lastAt ? new Date(a.lastAt).getTime() : 0;
      const bLast = b.lastAt ? new Date(b.lastAt).getTime() : 0;
      if (bLast !== aLast) return bLast - aLast;
      return a.id - b.id;
    });
    const canonical = scored[0];
    const dups = scored.slice(1);

    report.conversations.groups++;
    report.conversations.archived += dups.length;
    report.conversations.detail.push({
      tenantId: canonical.tenant_id,
      phone: normalizePhone(canonical.phone),
      canonicalId: canonical.id,
      archivedIds: dups.map((d) => d.id),
    });

    if (!apply) continue;

    for (const dup of dups) {
      await client.query(`UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);
      await client.query(`UPDATE message_pins SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);

      await client.query(
        `DELETE FROM conversation_participants
         WHERE conversation_id = $2
           AND user_id IN (SELECT user_id FROM conversation_participants WHERE conversation_id = $1)`,
        [canonical.id, dup.id],
      );
      await client.query(`UPDATE conversation_participants SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);

      await client.query(
        `DELETE FROM conversation_pins
         WHERE conversation_id = $2
           AND user_id IN (SELECT user_id FROM conversation_pins WHERE conversation_id = $1)`,
        [canonical.id, dup.id],
      );
      await client.query(`UPDATE conversation_pins SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);

      await client.query(`UPDATE chat_notifications SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);
      await client.query(`UPDATE scheduled_messages SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);

      const { rows: canonHasBotState } = await client.query(`SELECT 1 FROM bot_states WHERE conversation_id = $1`, [canonical.id]);
      if (canonHasBotState.length === 0) {
        await client.query(`UPDATE bot_states SET conversation_id = $1 WHERE conversation_id = $2`, [canonical.id, dup.id]);
      } else {
        await client.query(`DELETE FROM bot_states WHERE conversation_id = $1`, [dup.id]);
      }

      await client.query(
        `UPDATE conversations SET is_archived = true, status = 'archived', updated_at = now() WHERE id = $1`,
        [dup.id],
      );
    }

    await client.query(
      `UPDATE conversations c SET
         last_message = m.content,
         last_message_direction = m.direction,
         last_message_at = m.created_at,
         phone = $2,
         updated_at = now()
       FROM (
         SELECT content, direction, created_at FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1
       ) m
       WHERE c.id = $1`,
      [canonical.id, normalizePhone(canonical.phone)],
    );
  }
}

async function mergeCrmContacts(client: PoolClient, report: Report, apply: boolean): Promise<void> {
  const { rows: contacts } = await client.query(
    `SELECT id, tenant_id, phone, contact, created_at, is_new, email, city,
            service_store, attendance_source, notes, tags, custom_fields
     FROM crm_contacts`,
  );
  const { rows: purchaseStats } = await client.query(
    `SELECT contact_id, COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0) AS total
     FROM crm_purchases GROUP BY contact_id`,
  );
  const statsByContact = new Map(purchaseStats.map((r) => [r.contact_id, r]));

  const groups = groupBy(contacts, (c) => `${c.tenant_id}:${normalizePhone(c.phone || c.contact)}`);

  for (const group of groups) {
    const filledFieldCount = (c: (typeof group)[number]): number =>
      [c.email, c.city, c.service_store, c.attendance_source, c.notes, c.tags].filter((v) => v != null && v !== "").length;

    const scored = group.map((c) => ({ ...c, purchaseCount: statsByContact.get(c.id)?.cnt ?? 0 }));
    scored.sort((a, b) => {
      if (b.purchaseCount !== a.purchaseCount) return b.purchaseCount - a.purchaseCount;
      const fc = filledFieldCount(b) - filledFieldCount(a);
      if (fc !== 0) return fc;
      return a.id - b.id;
    });
    const canonical = scored[0];
    const dups = scored.slice(1);

    report.contacts.groups++;
    report.contacts.archived += dups.length;
    report.contacts.detail.push({
      tenantId: canonical.tenant_id,
      phone: normalizePhone(canonical.phone || canonical.contact),
      canonicalId: canonical.id,
      archivedIds: dups.map((d) => d.id),
    });

    if (!apply) continue;

    const mergedFields = {
      email: canonical.email,
      city: canonical.city,
      service_store: canonical.service_store,
      attendance_source: canonical.attendance_source,
      notes: canonical.notes,
      tags: canonical.tags,
      is_new: canonical.is_new,
      custom_fields: canonical.custom_fields ?? {},
    };

    for (const dup of dups) {
      await client.query(`UPDATE crm_purchases SET contact_id = $1 WHERE contact_id = $2`, [canonical.id, dup.id]);
      await client.query(`UPDATE crm_internal_notes SET contact_id = $1 WHERE contact_id = $2`, [canonical.id, dup.id]);

      if (!mergedFields.email && dup.email) mergedFields.email = dup.email;
      if (!mergedFields.city && dup.city) mergedFields.city = dup.city;
      if (!mergedFields.service_store && dup.service_store) mergedFields.service_store = dup.service_store;
      if (!mergedFields.attendance_source && dup.attendance_source) mergedFields.attendance_source = dup.attendance_source;
      if (!mergedFields.notes && dup.notes) mergedFields.notes = dup.notes;
      if (!mergedFields.tags && dup.tags) mergedFields.tags = dup.tags;
      if (dup.is_new === false) mergedFields.is_new = false;
      mergedFields.custom_fields = { ...(dup.custom_fields ?? {}), ...mergedFields.custom_fields };

      await client.query(`UPDATE crm_contacts SET is_archived = true, updated_at = now() WHERE id = $1`, [dup.id]);
    }

    await client.query(
      `UPDATE crm_contacts SET
         email = $2, city = $3, service_store = $4, attendance_source = $5,
         notes = $6, tags = $7, is_new = $8, custom_fields = $9,
         phone = $10,
         total_purchases = COALESCE((SELECT SUM(amount) FROM crm_purchases WHERE contact_id = $1), 0),
         updated_at = now()
       WHERE id = $1`,
      [
        canonical.id,
        mergedFields.email,
        mergedFields.city,
        mergedFields.service_store,
        mergedFields.attendance_source,
        mergedFields.notes,
        mergedFields.tags,
        mergedFields.is_new,
        JSON.stringify(mergedFields.custom_fields),
        normalizePhone(canonical.phone || canonical.contact),
      ],
    );
  }
}

async function verify(client: PoolClient): Promise<string[]> {
  const problems: string[] = [];

  const { rows: orphanMsgs } = await client.query(
    `SELECT COUNT(*)::int AS n FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL`,
  );
  if (orphanMsgs[0].n > 0) problems.push(`${orphanMsgs[0].n} mensagens órfãs (sem conversa)`);

  const { rows: orphanPurchases } = await client.query(
    `SELECT COUNT(*)::int AS n FROM crm_purchases p LEFT JOIN crm_contacts c ON c.id = p.contact_id WHERE c.id IS NULL`,
  );
  if (orphanPurchases[0].n > 0) problems.push(`${orphanPurchases[0].n} compras órfãs (sem contato)`);

  const { rows: dupParticipants } = await client.query(
    `SELECT conversation_id, user_id, COUNT(*)::int AS n FROM conversation_participants
     GROUP BY conversation_id, user_id HAVING COUNT(*) > 1`,
  );
  if (dupParticipants.length > 0) problems.push(`${dupParticipants.length} PKs duplicadas em conversation_participants`);

  return problems;
}

async function runMerge(apply: boolean): Promise<{ committed: boolean; report: Report; problems: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report: Report = {
      conversations: { groups: 0, archived: 0, detail: [] },
      contacts: { groups: 0, archived: 0, detail: [] },
    };
    await mergeConversations(client, report, apply);
    await mergeCrmContacts(client, report, apply);
    const problems = await verify(client);

    const committed = apply && problems.length === 0;
    await client.query(committed ? "COMMIT" : "ROLLBACK");
    return { committed, report, problems };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Dry-run: mostra o plano (o que seria mesclado/arquivado), nunca grava.
router.get("/superadmin/data-cleanup/merge-duplicates/plan", async (req, res): Promise<void> => {
  try {
    const { report, problems } = await runMerge(false);
    res.json({ mode: "dry-run", report, problems });
  } catch (err) {
    req.log.error({ err }, "Falha ao gerar plano de mesclagem de duplicatas");
    res.status(500).json({ error: "Falha ao gerar plano" });
  }
});

// Aplica de verdade — dentro de uma transação com verificação automática
// antes do COMMIT (mesma garantia do script: se algo parecer errado, ROLLBACK
// e nada é gravado). Exige confirmação explícita no corpo pra evitar clique
// acidental num botão/atalho.
router.post("/superadmin/data-cleanup/merge-duplicates/apply", async (req, res): Promise<void> => {
  const { confirm } = req.body as { confirm?: string };
  if (confirm !== "APLICAR") {
    res.status(400).json({ error: 'Envie { "confirm": "APLICAR" } no corpo da requisição para confirmar.' });
    return;
  }
  try {
    const { committed, report, problems } = await runMerge(true);
    req.log.info(
      { superadminUserId: req.session.userId, committed, groups: report.conversations.groups + report.contacts.groups },
      "Mesclagem de duplicatas executada via painel superadmin",
    );
    if (!committed) {
      res.status(422).json({ error: "Verificação falhou — nada foi gravado (ROLLBACK).", report, problems });
      return;
    }
    res.json({ mode: "applied", report, problems });
  } catch (err) {
    req.log.error({ err }, "Falha ao aplicar mesclagem de duplicatas");
    res.status(500).json({ error: "Falha ao aplicar mesclagem" });
  }
});

// Contagem de usuários com o role legado "attendant" (ver migrations/0022 e
// .agents/memory/roles.md) — pra decidir com dados se vale a pena aplicar a
// migration de normalização (ou se já não há nenhuma linha afetada).
router.get("/superadmin/data-cleanup/attendant-role-count", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ tenantId: usersTable.tenantId, n: count() })
    .from(usersTable)
    .where(eq(usersTable.role, "attendant"))
    .groupBy(usersTable.tenantId);
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  res.json({ total, byTenant: rows.map((r) => ({ tenantId: r.tenantId, count: Number(r.n) })) });
});

export default router;
