/**
 * Mesclagem de conversas e contatos CRM duplicados.
 *
 * Causa raiz já corrigida em produção (commit 3d257c0 — normalização de
 * telefone). Este script é a migração ÚNICA que limpa o histórico que já
 * havia duplicado ANTES daquela correção: mesmo cliente salvo com o número
 * em formatos diferentes (com/sem DDI 55, com/sem o 9º dígito) virava uma
 * conversa e um contato de CRM novos a cada formato.
 *
 * Roda fora do console web do EasyPanel de propósito — aquele console corta
 * colagens grandes no meio, causando erro de sintaxe. Rodando como script
 * (pnpm/tsx) contra DATABASE_URL isso não acontece.
 *
 * MODO DE USO
 *   1) Dry-run (padrão, NÃO grava nada — só mostra o plano):
 *        pnpm --filter @workspace/scripts run merge-duplicates
 *   2) Aplicar de verdade (grava, dentro de uma transação com verificação
 *      automática antes do COMMIT — se qualquer checagem falhar, dá ROLLBACK
 *      e nada é gravado):
 *        pnpm --filter @workspace/scripts run merge-duplicates -- --apply
 *
 * O QUE FAZ, POR GRUPO DE DUPLICATAS (mesmo tenant + mesmo telefone
 * normalizado):
 *   - Escolhe 1 registro "canônico" (o mais completo) e migra tudo que
 *     referencia os outros (duplicatas) para ele.
 *   - Duplicatas são ARQUIVADAS (is_archived = true), nunca apagadas —
 *     dá pra reverter manualmente se algo parecer errado.
 *   - Conversas: messages, conversation_participants, conversation_pins,
 *     message_pins, chat_notifications, scheduled_messages, bot_states.
 *   - Contatos CRM: crm_purchases, crm_internal_notes, e faz backfill de
 *     campos vazios do canônico a partir da duplicata (email, cidade, notas
 *     etc.), sem sobrescrever o que o canônico já tinha preenchido.
 *
 * LIMITAÇÃO CONHECIDA (não resolvida automaticamente, decisão de negócio):
 *   - unread_count da conversa canônica NÃO é recalculado a partir da fusão
 *     (a regra de "o que conta como não lido" depende de attendance_started_at
 *     e não estava clara o suficiente pra automatizar com segurança). Se
 *     depois da mesclagem algum contador de não lidos parecer errado nas
 *     conversas envolvidas, é só abrir a conversa (zera o contador) ou
 *     ajustar manualmente.
 *   - raffles.participants (jsonb) pode conter um conversationId antigo de
 *     uma duplicata já arquivada. É só um registro histórico de sorteio
 *     passado — não afeta funcionamento, não foi migrado.
 */

import pg from "pg";
import type { PoolClient } from "pg";

const { Pool } = pg;

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

const APPLY = process.argv.includes("--apply");

if (!process.env.DATABASE_URL) {
  console.error("ERRO: variável de ambiente DATABASE_URL não definida.");
  console.error("Defina apontando para o Postgres de produção antes de rodar.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Normalização de telefone — cópia de artifacts/api-server/src/lib/phone.ts
// (script standalone, não importa de dentro do pacote da app). Se aquele
// arquivo mudar, revisar aqui também.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------

function groupBy<T>(rows: T[], keyFn: (row: T) => string | null | undefined): T[][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue; // sem telefone utilizável — não entra em nenhum grupo
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return [...map.values()].filter((group) => group.length > 1);
}

async function mergeConversations(client: PoolClient, report: Report): Promise<void> {
  console.log("\n=== CONVERSAS ===");

  const { rows: conversations } = await client.query(
    `SELECT id, tenant_id, phone, created_at FROM conversations`,
  );
  const { rows: msgStats } = await client.query(
    `SELECT conversation_id, COUNT(*)::int AS cnt, MAX(created_at) AS last_at
     FROM messages GROUP BY conversation_id`,
  );
  const statsByConv = new Map(msgStats.map((r) => [r.conversation_id, r]));

  const groups = groupBy(
    conversations,
    (c) => `${c.tenant_id}:${normalizePhone(c.phone)}`,
  );

  console.log(`Encontrados ${groups.length} grupos de conversas duplicadas.`);

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

    console.log(
      `  tenant=${canonical.tenant_id} telefone=${normalizePhone(canonical.phone)} -> ` +
        `mantém #${canonical.id} (${canonical.msgCount} msgs), arquiva [${dups.map((d) => d.id).join(", ")}]`,
    );

    report.conversations.groups++;
    report.conversations.archived += dups.length;
    report.conversations.detail.push({
      tenantId: canonical.tenant_id,
      phone: normalizePhone(canonical.phone),
      canonicalId: canonical.id,
      archivedIds: dups.map((d) => d.id),
    });

    if (!APPLY) continue;

    for (const dup of dups) {
      await client.query(
        `UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2`,
        [canonical.id, dup.id],
      );
      await client.query(
        `UPDATE message_pins SET conversation_id = $1 WHERE conversation_id = $2`,
        [canonical.id, dup.id],
      );

      // conversation_participants: PK (conversation_id, user_id) — evita
      // conflito removendo primeiro quem já está no canônico.
      await client.query(
        `DELETE FROM conversation_participants
         WHERE conversation_id = $2
           AND user_id IN (SELECT user_id FROM conversation_participants WHERE conversation_id = $1)`,
        [canonical.id, dup.id],
      );
      await client.query(
        `UPDATE conversation_participants SET conversation_id = $1 WHERE conversation_id = $2`,
        [canonical.id, dup.id],
      );

      // conversation_pins: mesma lógica de PK composta.
      await client.query(
        `DELETE FROM conversation_pins
         WHERE conversation_id = $2
           AND user_id IN (SELECT user_id FROM conversation_pins WHERE conversation_id = $1)`,
        [canonical.id, dup.id],
      );
      await client.query(
        `UPDATE conversation_pins SET conversation_id = $1 WHERE conversation_id = $2`,
        [canonical.id, dup.id],
      );

      await client.query(
        `UPDATE chat_notifications SET conversation_id = $1 WHERE conversation_id = $2`,
        [canonical.id, dup.id],
      );
      await client.query(
        `UPDATE scheduled_messages SET conversation_id = $1 WHERE conversation_id = $2`,
        [canonical.id, dup.id],
      );

      // bot_states: conversation_id é UNIQUE — só migra se o canônico ainda
      // não tiver um estado próprio; senão descarta o da duplicata.
      const { rows: canonHasBotState } = await client.query(
        `SELECT 1 FROM bot_states WHERE conversation_id = $1`,
        [canonical.id],
      );
      if (canonHasBotState.length === 0) {
        await client.query(
          `UPDATE bot_states SET conversation_id = $1 WHERE conversation_id = $2`,
          [canonical.id, dup.id],
        );
      } else {
        await client.query(`DELETE FROM bot_states WHERE conversation_id = $1`, [dup.id]);
      }

      await client.query(
        `UPDATE conversations SET is_archived = true, status = 'archived', updated_at = now() WHERE id = $1`,
        [dup.id],
      );
    }

    // Recalcula last_message* do canônico a partir do histórico já fundido
    // (objetivo e verificável — diferente do unread_count, que depende de
    // regra de negócio não migrada aqui, ver limitação no topo do arquivo).
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

async function mergeCrmContacts(client: PoolClient, report: Report): Promise<void> {
  console.log("\n=== CONTATOS CRM ===");

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

  const groups = groupBy(
    contacts,
    (c) => `${c.tenant_id}:${normalizePhone(c.phone || c.contact)}`,
  );

  console.log(`Encontrados ${groups.length} grupos de contatos CRM duplicados.`);

  for (const group of groups) {
    const filledFieldCount = (c: (typeof group)[number]): number =>
      [c.email, c.city, c.service_store, c.attendance_source, c.notes, c.tags].filter(
        (v) => v != null && v !== "",
      ).length;

    const scored = group.map((c) => ({
      ...c,
      purchaseCount: statsByContact.get(c.id)?.cnt ?? 0,
    }));
    scored.sort((a, b) => {
      if (b.purchaseCount !== a.purchaseCount) return b.purchaseCount - a.purchaseCount;
      const fc = filledFieldCount(b) - filledFieldCount(a);
      if (fc !== 0) return fc;
      return a.id - b.id;
    });
    const canonical = scored[0];
    const dups = scored.slice(1);

    console.log(
      `  tenant=${canonical.tenant_id} telefone=${normalizePhone(canonical.phone || canonical.contact)} -> ` +
        `mantém #${canonical.id} (${canonical.purchaseCount} compras), arquiva [${dups.map((d) => d.id).join(", ")}]`,
    );

    report.contacts.groups++;
    report.contacts.archived += dups.length;
    report.contacts.detail.push({
      tenantId: canonical.tenant_id,
      phone: normalizePhone(canonical.phone || canonical.contact),
      canonicalId: canonical.id,
      archivedIds: dups.map((d) => d.id),
    });

    if (!APPLY) continue;

    let mergedFields = {
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
      await client.query(
        `UPDATE crm_purchases SET contact_id = $1 WHERE contact_id = $2`,
        [canonical.id, dup.id],
      );
      await client.query(
        `UPDATE crm_internal_notes SET contact_id = $1 WHERE contact_id = $2`,
        [canonical.id, dup.id],
      );

      // Backfill: só preenche o que o canônico ainda não tinha.
      if (!mergedFields.email && dup.email) mergedFields.email = dup.email;
      if (!mergedFields.city && dup.city) mergedFields.city = dup.city;
      if (!mergedFields.service_store && dup.service_store) mergedFields.service_store = dup.service_store;
      if (!mergedFields.attendance_source && dup.attendance_source) mergedFields.attendance_source = dup.attendance_source;
      if (!mergedFields.notes && dup.notes) mergedFields.notes = dup.notes;
      if (!mergedFields.tags && dup.tags) mergedFields.tags = dup.tags;
      if (dup.is_new === false) mergedFields.is_new = false; // cliente recorrente tem prioridade sobre "novo"
      mergedFields.custom_fields = { ...(dup.custom_fields ?? {}), ...mergedFields.custom_fields };

      await client.query(
        `UPDATE crm_contacts SET is_archived = true, updated_at = now() WHERE id = $1`,
        [dup.id],
      );
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

async function verify(client: PoolClient, report: Report): Promise<boolean> {
  console.log("\n=== VERIFICAÇÃO (antes de decidir COMMIT) ===");
  const problems: string[] = [];

  const { rows: orphanMsgs } = await client.query(
    `SELECT COUNT(*)::int AS n FROM messages m
     LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL`,
  );
  if (orphanMsgs[0].n > 0) problems.push(`${orphanMsgs[0].n} mensagens órfãs (sem conversa)`);

  const { rows: orphanPurchases } = await client.query(
    `SELECT COUNT(*)::int AS n FROM crm_purchases p
     LEFT JOIN crm_contacts c ON c.id = p.contact_id WHERE c.id IS NULL`,
  );
  if (orphanPurchases[0].n > 0) problems.push(`${orphanPurchases[0].n} compras órfãs (sem contato)`);

  const { rows: dupParticipants } = await client.query(
    `SELECT conversation_id, user_id, COUNT(*)::int AS n FROM conversation_participants
     GROUP BY conversation_id, user_id HAVING COUNT(*) > 1`,
  );
  if (dupParticipants.length > 0) problems.push(`${dupParticipants.length} PKs duplicadas em conversation_participants`);

  console.log(`Conversas: ${report.conversations.groups} grupos, ${report.conversations.archived} arquivadas.`);
  console.log(`Contatos CRM: ${report.contacts.groups} grupos, ${report.contacts.archived} arquivadas.`);
  console.log(
    `(auditoria original esperava: 61 grupos / 67 arquivadas em conversas; 59 grupos / 59 arquivadas em contatos — ` +
      `diferença aqui é normal se novas conversas/contatos entraram desde a auditoria)`,
  );

  if (problems.length > 0) {
    console.error("\nFALHOU na verificação:");
    problems.forEach((p) => console.error(`  - ${p}`));
    return false;
  }
  console.log("\nOK — nenhuma inconsistência encontrada.");
  return true;
}

async function main() {
  console.log(APPLY ? "MODO: APLICAR (vai gravar no banco)" : "MODO: DRY-RUN (não grava nada, só mostra o plano)");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  const report: Report = {
    conversations: { groups: 0, archived: 0, detail: [] },
    contacts: { groups: 0, archived: 0, detail: [] },
  };

  try {
    await client.query("BEGIN");

    await mergeConversations(client, report);
    await mergeCrmContacts(client, report);

    const ok = await verify(client, report);

    if (APPLY && ok) {
      await client.query("COMMIT");
      console.log("\n✅ COMMIT feito. Mesclagem aplicada em produção.");
    } else {
      await client.query("ROLLBACK");
      console.log(
        APPLY
          ? "\n❌ ROLLBACK — verificação falhou, nada foi gravado. Revise os problemas acima antes de tentar de novo."
          : "\n(dry-run — ROLLBACK automático, nada foi gravado. Rode com --apply para aplicar de verdade.)",
      );
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nERRO — ROLLBACK feito, nada foi gravado.\n", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
