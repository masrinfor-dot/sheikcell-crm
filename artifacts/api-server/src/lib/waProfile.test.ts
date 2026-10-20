import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpMedia = mkdtempSync(path.join(os.tmpdir(), "waprofile-"));
process.env["MEDIA_DIR"] = tmpMedia;
process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";
process.env["WHATSAPP_BRIDGE_URL"] ??= "http://localhost:3002";
process.env["NODE_ENV"] ??= "development";

const { db, tenantsTable, conversationsTable, messagesTable, whatsappContactsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const {
  refreshConversationAvatar, conversationsNeedingAvatar, fillNumberOnlyNames, isLocalAvatar, AVATAR_DIR,
} = await import("./waProfile.ts");

// Fotos de perfil e nomes do WhatsApp (pedido 20/10/2026).

const MARK = "__TEST_WA_PROFILE__";
const rnd = Math.random().toString(36).slice(2, 8);
const key = `test-prof-${rnd}`;
let tenantId: number;
const ids: Record<string, number> = {};

before(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.name, MARK));
  const [t] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = t!.id;
  const now = Date.now();
  const rows = await db.insert(conversationsTable).values([
    { tenantId, phone: "553398811111", name: "553398811111", channel: "whatsapp", sessionKey: key, avatarUrl: "https://pps.whatsapp.net/velho.jpg", lastMessageAt: new Date(now) },
    { tenantId, phone: "553398822222", name: "553398822222", channel: "whatsapp", sessionKey: key, lastMessageAt: new Date(now - 1000) },
    { tenantId, phone: "553398833333", name: "553398833333", channel: "whatsapp", sessionKey: key, avatarFetchedAt: new Date(now - 3600_000), lastMessageAt: new Date(now - 2000) },
    { tenantId, phone: "553398844444", name: "Nome editado", channel: "whatsapp", sessionKey: key, avatarFetchedAt: new Date(now - 10 * 24 * 3600_000), lastMessageAt: new Date(now - 3000) },
  ]).returning({ id: conversationsTable.id, phone: conversationsTable.phone });
  for (const r of rows) ids[r.phone] = r.id;
  // Agenda desta linha com o 9º dígito (o telefone da conversa está sem ele).
  await db.insert(whatsappContactsTable).values([
    { tenantId, sessionKey: key, jid: "5533998811111@s.whatsapp.net", phone: "5533998811111", name: "Distribuidora Zé" },
    { tenantId, sessionKey: key, jid: "553398844444@s.whatsapp.net", phone: "553398844444", name: "Outro nome" },
  ]);
  // Sem agenda: o nome que o cliente usa no perfil, que veio na mensagem.
  await db.insert(messagesTable).values({ tenantId, conversationId: ids["553398822222"]!, content: "oi", direction: "inbound", type: "text", senderName: "Marcell Reparos" });
});

after(async () => {
  await db.delete(messagesTable).where(eq(messagesTable.tenantId, tenantId));
  await db.delete(whatsappContactsTable).where(eq(whatsappContactsTable.tenantId, tenantId));
  await db.delete(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  rmSync(tmpMedia, { recursive: true, force: true });
});

test("fila de fotos: nunca buscadas primeiro, depois as velhas; recém-buscada fica de fora", async () => {
  const list = await conversationsNeedingAvatar(tenantId, key, 10);
  assert.deepEqual(list.map((c) => c.phone), ["553398811111", "553398822222", "553398844444"]);
});

test("foto encontrada: guarda no disco e troca o link do WhatsApp pelo do CRM", async () => {
  const conv = { id: ids["553398811111"]!, phone: "553398811111", avatarUrl: "https://pps.whatsapp.net/velho.jpg" };
  const r = await refreshConversationAvatar(conv, key, async () => ({ kind: "found", mimeType: "image/jpeg", data: Buffer.from("JPEGDATA") }));
  assert.equal(r, "saved");
  const file = path.join(AVATAR_DIR, `${conv.id}.jpg`);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, "utf8"), "JPEGDATA");
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conv.id));
  assert.ok(isLocalAvatar(row!.avatarUrl));
  assert.match(row!.avatarUrl!, new RegExp(`^/api/chat/avatars/${conv.id}\\?v=\\d+$`));
  assert.ok(row!.avatarFetchedAt);
});

test("sem foto: tira o link velho do WhatsApp e não pergunta de novo tão cedo; linha fora não marca nada", async () => {
  const id = ids["553398844444"]!;
  await db.update(conversationsTable).set({ avatarUrl: "https://pps.whatsapp.net/expirou.jpg" }).where(eq(conversationsTable.id, id));
  const off = await refreshConversationAvatar({ id, phone: "553398844444", avatarUrl: "https://pps.whatsapp.net/expirou.jpg" }, key, async () => ({ kind: "offline" }));
  assert.equal(off, "offline");
  let [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  assert.equal(row!.avatarUrl, "https://pps.whatsapp.net/expirou.jpg");

  const none = await refreshConversationAvatar({ id, phone: "553398844444", avatarUrl: row!.avatarUrl }, key, async () => ({ kind: "none" }));
  assert.equal(none, "none");
  [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  assert.equal(row!.avatarUrl, null);
  const list = await conversationsNeedingAvatar(tenantId, key, 10);
  assert.ok(!list.some((c) => c.id === id));
});

test("nomes: agenda (com ou sem o 9º dígito), depois o nome do perfil da mensagem; nome editado não muda", async () => {
  const changed = await fillNumberOnlyNames(tenantId);
  assert.equal(changed, 2);
  const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.tenantId, tenantId));
  const byPhone = new Map(rows.map((r) => [r.phone, r.name]));
  assert.equal(byPhone.get("553398811111"), "Distribuidora Zé");
  assert.equal(byPhone.get("553398822222"), "Marcell Reparos");
  assert.equal(byPhone.get("553398833333"), "553398833333"); // nada cadastrado: continua o número
  assert.equal(byPhone.get("553398844444"), "Nome editado");
  assert.equal(await fillNumberOnlyNames(tenantId), 0); // idempotente
});
