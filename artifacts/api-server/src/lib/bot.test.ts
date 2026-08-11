// Testa a ferramenta route_to_sector diretamente (execute()), sem passar
// pela OpenAI de verdade — o que importa testar aqui é a lógica que eu
// escrevi (validação do nome do setor, escrita no banco, broadcast), não o
// protocolo de function-calling da própria OpenAI (isso é responsabilidade
// deles, já testado pelo SDK). Cria uma loja/conversa de teste isolada
// (marcador __BOT_TOOL_TEST__) e limpa tudo no final.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["OPENAI_API_KEY"] ??= "sk-fake-bot-tool-test";

const { db, tenantsTable, sectorsTable, conversationsTable } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { routeToSectorTool } = await import("./bot.ts");

const MARK = "__BOT_TOOL_TEST__";

let tenantId: number;
let sectorAId: number;
let sectorBId: number;
let conversationId: number;

async function wipe(): Promise<void> {
  const stale = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.name, MARK));
  const ids = stale.map((t) => t.id);
  if (ids.length === 0) return;
  await db.delete(conversationsTable).where(inArray(conversationsTable.tenantId, ids));
  await db.delete(sectorsTable).where(inArray(sectorsTable.tenantId, ids));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
}

before(async () => {
  await wipe();
  const [tenant] = await db.insert(tenantsTable).values({ name: MARK }).returning();
  tenantId = tenant!.id;
  const [sectorA] = await db.insert(sectorsTable).values({ tenantId, name: "Vendas", isActive: true }).returning();
  const [sectorB] = await db.insert(sectorsTable).values({ tenantId, name: "Assistência Técnica", isActive: true }).returning();
  sectorAId = sectorA!.id;
  sectorBId = sectorB!.id;
  const [conv] = await db.insert(conversationsTable).values({
    tenantId, phone: "5511999998888", name: "Cliente Teste", channel: "manual", sectorId: sectorAId,
  }).returning();
  conversationId = conv!.id;
});

after(async () => { await wipe(); });

test("route_to_sector muda o setor quando o nome bate exatamente", async () => {
  const tool = routeToSectorTool([{ id: sectorAId, name: "Vendas" }, { id: sectorBId, name: "Assistência Técnica" }]);
  const result = await tool.execute({ sector: "Assistência Técnica" }, { tenantId, conversationId });
  assert.match(result, /direcionada/i);
  const [row] = await db.select({ sectorId: conversationsTable.sectorId }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  assert.equal(row?.sectorId, sectorBId);
});

test("route_to_sector é case-insensitive no nome do setor", async () => {
  const tool = routeToSectorTool([{ id: sectorAId, name: "Vendas" }]);
  const result = await tool.execute({ sector: "vendas" }, { tenantId, conversationId });
  assert.match(result, /direcionada/i);
  const [row] = await db.select({ sectorId: conversationsTable.sectorId }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  assert.equal(row?.sectorId, sectorAId);
});

test("route_to_sector com nome inventado não muda nada e devolve erro claro", async () => {
  const [before_] = await db.select({ sectorId: conversationsTable.sectorId }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  const tool = routeToSectorTool([{ id: sectorAId, name: "Vendas" }, { id: sectorBId, name: "Assistência Técnica" }]);
  const result = await tool.execute({ sector: "Setor Que Não Existe" }, { tenantId, conversationId });
  assert.match(result, /não existe/i);
  const [after_] = await db.select({ sectorId: conversationsTable.sectorId }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  assert.equal(after_?.sectorId, before_?.sectorId, "setor não deveria ter mudado com nome inválido");
});

test("route_to_sector pra conversa inexistente não lança", async () => {
  const tool = routeToSectorTool([{ id: sectorAId, name: "Vendas" }]);
  const result = await tool.execute({ sector: "Vendas" }, { tenantId, conversationId: 999999999 });
  assert.equal(typeof result, "string");
});
