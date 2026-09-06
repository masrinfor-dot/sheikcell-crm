import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, buildMarketCheckPrompt, cleanMarketCheckVerdict, askCatalogAIWithWebSearch } from "./catalogMarketPrice";

test("extractJsonObject: parseia JSON puro", () => {
  const r = extractJsonObject<{ a: number }>('{"a":1}');
  assert.deepEqual(r, { a: 1 });
});

test("extractJsonObject: parseia JSON envolvido em ```json ... ```", () => {
  const r = extractJsonObject<{ verdict: string }>('```json\n{"verdict":"compativel"}\n```');
  assert.deepEqual(r, { verdict: "compativel" });
});

test("extractJsonObject: texto sem objeto JSON devolve null", () => {
  assert.equal(extractJsonObject("não consegui analisar"), null);
});

test("extractJsonObject: JSON malformado devolve null em vez de lançar", () => {
  assert.equal(extractJsonObject("{not valid json"), null);
});

test("cleanMarketCheckVerdict: aceita só os 4 valores válidos, resto vira sem_dados", () => {
  assert.equal(cleanMarketCheckVerdict("compativel"), "compativel");
  assert.equal(cleanMarketCheckVerdict("acima"), "acima");
  assert.equal(cleanMarketCheckVerdict("abaixo"), "abaixo");
  assert.equal(cleanMarketCheckVerdict("sem_dados"), "sem_dados");
  assert.equal(cleanMarketCheckVerdict("qualquer-coisa"), "sem_dados");
  assert.equal(cleanMarketCheckVerdict(undefined), "sem_dados");
  assert.equal(cleanMarketCheckVerdict(null), "sem_dados");
});

test("buildMarketCheckPrompt: inclui aparelho, condição e preço quando informado", () => {
  const p = buildMarketCheckPrompt({ device: "iPhone 13 128GB", conditionLabel: "Excelente", price: 2500 });
  assert.match(p, /iPhone 13 128GB/);
  assert.match(p, /Excelente/);
  assert.match(p, /R\$ 2500\.00/);
  assert.match(p, /verdict/);
});

test("buildMarketCheckPrompt: sem preço não menciona 'pretende cobrar'", () => {
  const p = buildMarketCheckPrompt({ device: "iPhone 13 128GB", conditionLabel: "Excelente", price: null });
  assert.doesNotMatch(p, /pretende cobrar/);
});

test("askCatalogAIWithWebSearch: usa responses.create com web_search_preview quando disponível", async () => {
  const calls: string[] = [];
  const fakeClient = {
    responses: {
      create: async (params: { tools: { type: string }[] }) => {
        calls.push("responses");
        assert.equal(params.tools[0]?.type, "web_search_preview");
        return { output_text: "resposta com web" };
      },
    },
    chat: { completions: { create: async () => { calls.push("chat"); return { choices: [{ message: { content: "fallback" } }] }; } } },
  };
  const result = await askCatalogAIWithWebSearch(fakeClient, "pergunta");
  assert.equal(result, "resposta com web");
  assert.deepEqual(calls, ["responses"]);
});

test("askCatalogAIWithWebSearch: cai pra chat.completions se responses.create falhar", async () => {
  const calls: string[] = [];
  const fakeClient = {
    responses: { create: async () => { calls.push("responses"); throw new Error("Responses API indisponível"); } },
    chat: {
      completions: {
        create: async (params: { messages: { content: string }[] }) => {
          calls.push("chat");
          assert.match(params.messages[0]?.content ?? "", /sem acesso à web/);
          return { choices: [{ message: { content: "estimativa sem web" } }] };
        },
      },
    },
  };
  const result = await askCatalogAIWithWebSearch(fakeClient, "pergunta");
  assert.equal(result, "estimativa sem web");
  assert.deepEqual(calls, ["responses", "chat"]);
});
