import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRICING_SETTINGS,
  sanitizePricingSettings,
  resolveCategoryMargin,
  precoVendaDoProduto,
  precoAVistaDoProduto,
  parcelamento12xDoProduto,
  calcularPrecoVenda,
} from "./catalogPricing";

test("sanitizePricingSettings: categoryMarginOverrides ausente vira objeto vazio", () => {
  const s = sanitizePricingSettings({ defaultMarginPercent: 30 });
  assert.deepEqual(s.categoryMarginOverrides, {});
});

test("sanitizePricingSettings: aceita margens por categoria válidas e descarta inválidas", () => {
  const s = sanitizePricingSettings({
    categoryMarginOverrides: {
      "3": 18, // válida
      "5": 40.256, // válida, arredonda pra 2 casas
      "0": 20, // categoria inválida (<=0) — descarta
      "-1": 20, // categoria inválida — descarta
      abc: 20, // chave não numérica — descarta
      "7": 150, // fora da faixa (0-95) — descarta
      "8": -5, // fora da faixa — descarta
    },
  });
  assert.deepEqual(s.categoryMarginOverrides, { "3": 18, "5": 40.26 });
});

test("resolveCategoryMargin: categoria null devolve null (cai no padrão da loja)", () => {
  const settings = sanitizePricingSettings({ categoryMarginOverrides: { "3": 18 } });
  assert.equal(resolveCategoryMargin(null, settings), null);
  assert.equal(resolveCategoryMargin(undefined, settings), null);
});

test("resolveCategoryMargin: categoria sem override configurado devolve null", () => {
  const settings = sanitizePricingSettings({ categoryMarginOverrides: { "3": 18 } });
  assert.equal(resolveCategoryMargin(99, settings), null);
});

test("resolveCategoryMargin: categoria com override devolve a margem configurada", () => {
  const settings = sanitizePricingSettings({ categoryMarginOverrides: { "3": 18 } });
  assert.equal(resolveCategoryMargin(3, settings), 18);
});

test("precoVendaDoProduto: prioridade margem própria > categoria > padrão da loja", () => {
  const settings = sanitizePricingSettings({
    defaultMarginPercent: 25,
    categoryMarginOverrides: { "3": 15 },
    cardFeeTable: { "1": 0 },
  });
  const custo = 1000;

  // Sem override próprio, categoria SEM margem configurada -> usa a padrão (25%)
  const semCategoria = precoVendaDoProduto({ costPrice: custo, costIncludesInvoice: true, marginPercentOverride: null }, settings, 1, null);
  const comCategoriaSemOverride = precoVendaDoProduto({ costPrice: custo, costIncludesInvoice: true, marginPercentOverride: null }, settings, 1, 999);
  assert.equal(semCategoria, calcularPrecoVenda({ custo, margemPercent: 25, notaFiscalPercent: 0, taxaCartaoPercent: 0, custoJaIncluiNotaFiscal: true }));
  assert.equal(comCategoriaSemOverride, semCategoria);

  // Sem override próprio, categoria COM margem configurada -> usa a da categoria (15%)
  const comCategoria = precoVendaDoProduto({ costPrice: custo, costIncludesInvoice: true, marginPercentOverride: null }, settings, 1, 3);
  assert.equal(comCategoria, calcularPrecoVenda({ custo, margemPercent: 15, notaFiscalPercent: 0, taxaCartaoPercent: 0, custoJaIncluiNotaFiscal: true }));

  // Com override próprio -> sempre vence, mesmo com categoria configurada
  const comOverrideProprio = precoVendaDoProduto({ costPrice: custo, costIncludesInvoice: true, marginPercentOverride: 40 }, settings, 1, 3);
  assert.equal(comOverrideProprio, calcularPrecoVenda({ custo, margemPercent: 40, notaFiscalPercent: 0, taxaCartaoPercent: 0, custoJaIncluiNotaFiscal: true }));
});

test("precoAVistaDoProduto e parcelamento12xDoProduto também respeitam a margem de categoria", () => {
  const settings = sanitizePricingSettings({
    defaultMarginPercent: 25,
    categoryMarginOverrides: { "3": 15 },
    cardFeeTable: { "1": 0, "12": 10 },
  });
  const produto = { costPrice: 1000, costIncludesInvoice: true, marginPercentOverride: null };

  const priceCashPadrao = precoAVistaDoProduto(produto, settings, null);
  const priceCashCategoria = precoAVistaDoProduto(produto, settings, 3);
  assert.notEqual(priceCashPadrao, priceCashCategoria);
  assert.equal(priceCashCategoria, calcularPrecoVenda({ custo: 1000, margemPercent: 15, notaFiscalPercent: 0, taxaCartaoPercent: 0, custoJaIncluiNotaFiscal: true }));

  const parcelamentoCategoria = parcelamento12xDoProduto(produto, settings, 3);
  const esperadoTotal = calcularPrecoVenda({ custo: 1000, margemPercent: 15, notaFiscalPercent: 0, taxaCartaoPercent: 10, custoJaIncluiNotaFiscal: true });
  assert.equal(parcelamentoCategoria?.total, esperadoTotal);
});

test("chamadas sem categoryId continuam com o comportamento antigo (compatibilidade)", () => {
  const settings = DEFAULT_PRICING_SETTINGS;
  const produto = { costPrice: 500, costIncludesInvoice: false, marginPercentOverride: null };
  // Sem passar categoryId nenhum (parâmetro omitido) — não deve quebrar nem mudar o resultado.
  const preco = precoVendaDoProduto(produto, settings);
  assert.equal(preco, calcularPrecoVenda({ custo: 500, margemPercent: settings.defaultMarginPercent, notaFiscalPercent: 0, taxaCartaoPercent: settings.cardFeeTable["1"] ?? 0, custoJaIncluiNotaFiscal: false }));
});
