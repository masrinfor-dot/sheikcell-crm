import { test } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] ??= "postgres://sheikcell:sheikcell123@localhost:5432/sheikcell";
process.env["SESSION_SECRET"] ??= "isolation-test-secret";
process.env["OPENAI_API_KEY"] ??= "sk-fake-isolation-test";

const { parseBRLValue } = await import("./tradeInEstimate.ts");

test("parseBRLValue: formatos que a tabela e a IA devolvem", () => {
  assert.equal(parseBRLValue("R$ 1.234,56"), 1234.56);
  assert.equal(parseBRLValue("R$ 1.200"), 1200); // IA sem centavos — antes virava 1,2
  assert.equal(parseBRLValue("R$ 2.500,00"), 2500);
  assert.equal(parseBRLValue("1200"), 1200);
  assert.equal(parseBRLValue("R$ 850,5"), 850.5);
  assert.equal(parseBRLValue("R$ 1.200 a R$ 1.400"), 1200);
  assert.equal(parseBRLValue("sem valor"), null);
  assert.equal(parseBRLValue(null), null);
});
