import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

const { db, tenantsTable, sectorsTable, conversationsTable, messagesTable, whatsappSessionsTable, attendanceLogsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { processInboundWA, MEDIA_DIR } = await import("./whatsappInbound.ts");

const MARK = "__TEST_DOC_WITH_CAPTION__";
// Sufixo aleatório: whatsapp_sessions.session_key é único GLOBAL (não por
// tenant) — uma chave fixa colide se a limpeza de uma rodada anterior não
// tiver rodado a tempo (test runner concorrente entre arquivos de teste).
const sessionKey = `test-doc-caption-${Math.random().toString(36).slice(2, 10)}`;
let tenantId: number;

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  await db.insert(sectorsTable).values({ tenantId, name: "Vendas", isActive: true });
  await db.insert(whatsappSessionsTable).values({ tenantId, sessionKey, status: "connected" });
});

after(async () => {
  // Apaga os arquivos de mídia salvos em disco pelo teste — sem isso, cada
  // rodada local deixa PDFs órfãos acumulando em artifacts/api-server/media/
  // (rastreado no git neste repo, não é diretório temporário).
  const savedMessages = await db.select({ mediaUrl: messagesTable.mediaUrl })
    .from(messagesTable).where(eq(messagesTable.tenantId, tenantId));
  for (const m of savedMessages) {
    if (!m.mediaUrl) continue;
    await unlink(path.join(MEDIA_DIR, path.basename(m.mediaUrl))).catch(() => {});
  }
  // messages/attendance_logs primeiro: messages.conversation_id não tem
  // cascade, então apagar conversations antes deixaria as mensagens órfãs e
  // travando exclusões futuras da mesma loja (restrição de chave estrangeira).
  await db.delete(messagesTable).where(eq(messagesTable.tenantId, tenantId));
  await db.delete(attendanceLogsTable).where(eq(attendanceLogsTable.tenantId, tenantId));
  await db.delete(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  await db.delete(whatsappSessionsTable).where(eq(whatsappSessionsTable.tenantId, tenantId));
  await db.delete(sectorsTable).where(eq(sectorsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

test("documentWithCaptionMessage: extrai nome do arquivo e legenda do documento embrulhado", async () => {
  await processInboundWA({
    sessionKey,
    isGroupMsg: false,
    data: {
      key: { remoteJid: "5511999998888@s.whatsapp.net", id: "DOCCAP1" },
      pushName: "Cliente Doc",
      mediaType: "doc",
      mediaMimeType: "application/pdf",
      mediaBase64: Buffer.from("conteudo falso do pdf").toString("base64"),
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              fileName: "orcamento.pdf",
              caption: "Segue o orçamento combinado",
            },
          },
        },
      },
    },
  });

  const [msg] = await db.select().from(messagesTable)
    .where(eq(messagesTable.externalId, "DOCCAP1")).limit(1);
  assert.ok(msg, "mensagem deveria ter sido criada");
  assert.equal(msg!.type, "doc", "tipo deveria ser 'doc', igual a um documento comum");
  assert.equal(msg!.content, "Segue o orçamento combinado", "conteúdo deveria ser a legenda, não o nome do arquivo");
  assert.ok(msg!.mediaUrl, "deveria ter salvo o arquivo de mídia");
});

test("documentWithCaptionMessage sem legenda: usa o nome do arquivo como preview", async () => {
  await processInboundWA({
    sessionKey,
    isGroupMsg: false,
    data: {
      key: { remoteJid: "5511999998888@s.whatsapp.net", id: "DOCCAP2" },
      pushName: "Cliente Doc",
      mediaType: "doc",
      mediaMimeType: "application/pdf",
      mediaBase64: Buffer.from("outro pdf falso").toString("base64"),
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              fileName: "nota-fiscal.pdf",
            },
          },
        },
      },
    },
  });

  const [msg] = await db.select().from(messagesTable)
    .where(eq(messagesTable.externalId, "DOCCAP2")).limit(1);
  assert.ok(msg, "mensagem deveria ter sido criada");
  assert.equal(msg!.type, "doc");
  assert.equal(msg!.content, "📄 nota-fiscal.pdf", "sem legenda, deveria cair no placeholder com o nome do arquivo");
});

test("resposta da pesquisa de satisfação com telefone sem o 9º dígito não reabre a conversa resolvida", async () => {
  // Simula o cenário do bug: a conversa foi salva na forma canônica (COM o
  // 9º dígito), mas a resposta chega com o JID SEM o 9 (comum em reentregas/
  // roteamento do WhatsApp). Antes da correção, tryConsumeSurveyReply fazia
  // match exato de telefone, não achava a conversa, e ela caía no fluxo
  // normal — que reabre (vira "Potencial") por engano.
  const canonicalPhone = "5511987776001";
  const phoneWithout9 = "551187776001";

  const [conv] = await db.insert(conversationsTable).values({
    tenantId, phone: canonicalPhone, name: "Cliente Pesquisa", channel: "whatsapp",
    sessionKey, sectorId: (await db.select().from(sectorsTable).where(eq(sectorsTable.tenantId, tenantId)).limit(1))[0]!.id,
    status: "resolved", assigneeId: null,
  }).returning();

  const [log] = await db.insert(attendanceLogsTable).values({
    tenantId, queueEntryId: 0, clientName: "Cliente Pesquisa", clientContact: canonicalPhone,
    sectorId: conv!.sectorId!, sectorName: "Vendas", channel: "whatsapp", outcome: "completed",
  }).returning();

  await db.update(conversationsTable).set({
    pendingSurveyLogId: log!.id, surveySentAt: new Date(), surveyScaleMax: 5, surveyWindowHours: 48,
  }).where(eq(conversationsTable.id, conv!.id));

  await processInboundWA({
    sessionKey,
    isGroupMsg: false,
    data: {
      key: { remoteJid: `${phoneWithout9}@s.whatsapp.net`, id: `SURVEYREPLY-${sessionKey}` },
      pushName: "Cliente Pesquisa",
      message: { conversation: "5" },
    },
  });

  const [updatedConv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv!.id)).limit(1);
  assert.equal(updatedConv!.status, "resolved", "a conversa não deveria reabrir ao responder a pesquisa");
  assert.equal(updatedConv!.pendingSurveyLogId, null, "a pesquisa deveria ser consumida (deixar de aguardar)");

  const [updatedLog] = await db.select().from(attendanceLogsTable).where(eq(attendanceLogsTable.id, log!.id)).limit(1);
  assert.equal(updatedLog!.satisfactionRating, 5, "a nota deveria ter sido gravada no atendimento");
});
