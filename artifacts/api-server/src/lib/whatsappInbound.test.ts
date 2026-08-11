import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

const { db, tenantsTable, sectorsTable, conversationsTable, messagesTable, whatsappSessionsTable } = await import("@workspace/db");
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
