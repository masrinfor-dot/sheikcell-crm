import { test } from "node:test";
import assert from "node:assert/strict";
import { validErpBaseUrl } from "./erpBaseUrl";

test("endereço certo da API fica como está", () => {
  assert.equal(validErpBaseUrl("https://api.sheikcell.com.br/api/v1/"), "https://api.sheikcell.com.br/api/v1");
});

test("endereço da tela do ERP (erp.…/integracoes) vira o da API", () => {
  assert.equal(validErpBaseUrl("https://erp.sheikcell.com.br/integracoes"), "https://api.sheikcell.com.br/api/v1");
  assert.equal(validErpBaseUrl(" https://erp.sheikcell.com.br "), "https://api.sheikcell.com.br/api/v1");
});

test("tira /integrations do fim", () => {
  assert.equal(validErpBaseUrl("https://api.sheikcell.com.br/api/v1/integrations"), "https://api.sheikcell.com.br/api/v1");
});

test("recusa http fora do localhost e texto inválido", () => {
  assert.equal(validErpBaseUrl("http://api.sheikcell.com.br/api/v1"), null);
  assert.equal(validErpBaseUrl("api.sheikcell"), null);
});
