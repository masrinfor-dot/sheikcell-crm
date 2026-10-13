import { test } from "node:test";
import assert from "node:assert/strict";
import { mayInsertOnStatusPersist } from "./whatsappSessionRows.ts";

test("gravar status nunca recria uma conexão excluída (só atualiza)", () => {
  assert.equal(mayInsertOnStatusPersist(1, "t1-adminitrativo"), false);
  assert.equal(mayInsertOnStatusPersist(7, "t7-vendas"), false);
  assert.equal(mayInsertOnStatusPersist(1, "vendas"), false);
});

test("a conexão principal 'default' da loja 1 ainda pode ser criada ao gravar status", () => {
  assert.equal(mayInsertOnStatusPersist(1, "default"), true);
});

test("'default' de outra loja nunca é inserida (pertence à loja 1)", () => {
  assert.equal(mayInsertOnStatusPersist(2, "default"), false);
});
