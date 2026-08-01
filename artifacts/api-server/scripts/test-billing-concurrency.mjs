#!/usr/bin/env node
// Teste de integração de concorrência do faturamento do SaaS:
// dispara cancelamento do lojista EM PARALELO com geração de mensalidades e
// lançamento manual, e verifica o invariante: nunca sobra mensalidade
// pendente de loja cancelada. Também verifica que a geração paralela nunca
// duplica a mensalidade do mês (índice único tenant/mês).
//
// Uso: node scripts/test-billing-concurrency.mjs  (api-server rodando em dev)
const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const EMAIL = process.env.SUPERADMIN_EMAIL ?? "superadmin@sheikcell.com";
const PASSWORD = process.env.SUPERADMIN_PASSWORD ?? "superadmin123";

let cookie = "";
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let json = null;
  try { json = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, json };
}

function assert(cond, msg) {
  if (!cond) { console.error("FALHOU:", msg); process.exitCode = 1; }
  else console.log("ok:", msg);
}

const login = await req("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
if (login.status !== 200) { console.error("Login do superadmin falhou", login); process.exit(1); }

// Loja descartável só para o teste
const suffix = Math.random().toString(36).slice(2, 8);
const created = await req("POST", "/superadmin/tenants", { name: `__teste_concorrencia_${suffix}` });
const tenantId = created.json?.tenant?.id;
if (!tenantId) { console.error("Falha ao criar loja de teste", created); process.exit(1); }

await req("PUT", `/superadmin/tenants/${tenantId}/contract`, { plan: "Mensal", monthlyValueCents: 12345 });

const invoicesOf = async () =>
  (await req("GET", "/superadmin/saas/invoices")).json.invoices.filter((i) => i.tenantId === tenantId);

for (let round = 0; round < 5; round++) {
  // Reativa e limpa o mês testando meses diferentes por rodada
  await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "ativo", isActive: true });
  const month = `20${40 + round}-01`; // meses fictícios distintos por rodada

  // Corrida: cancelamento x geração x lançamento manual, tudo em paralelo
  const race = await Promise.all([
    req("POST", "/superadmin/saas/invoices/generate", { month }),
    req("POST", "/superadmin/saas/invoices/generate", { month }),
    req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "cancelado" }),
    req("POST", "/superadmin/saas/invoices", { tenantId, amountCents: 500, dueDate: `${month}-20` }),
    req("POST", "/superadmin/saas/invoices", { tenantId, amountCents: 500, dueDate: `${month}-21` }),
  ]);
  void race;

  const inv = await invoicesOf();
  const pendentes = inv.filter((i) => i.status === "pendente");
  assert(pendentes.length === 0, `rodada ${round}: nenhuma mensalidade pendente após cancelamento (encontradas ${pendentes.length})`);
  const doMes = inv.filter((i) => i.billingMonth === month);
  assert(doMes.length <= 1, `rodada ${round}: geração não duplicou o mês ${month} (encontradas ${doMes.length})`);
}

// Reabrir mensalidade PAGA de loja cancelada deve ser rejeitado
await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "ativo", isActive: true });
const paidMonth = "2046-02";
await req("POST", "/superadmin/saas/invoices/generate", { month: paidMonth });
const paid = (await invoicesOf()).find((i) => i.billingMonth === paidMonth);
await req("PATCH", `/superadmin/saas/invoices/${paid.id}`, { status: "paga" });
await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "cancelado" });
const reopen = await req("PATCH", `/superadmin/saas/invoices/${paid.id}`, { status: "pendente" });
assert(reopen.status === 400, `reabrir mensalidade paga de loja cancelada é rejeitado (status ${reopen.status})`);
const stillPaid = (await invoicesOf()).find((i) => i.id === paid.id);
assert(stillPaid.status === "paga", "mensalidade segue paga após tentativa de reabrir");

// Corrida manual x geração no MESMO mês: no máximo 1 cobrança do mês
await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "ativo", isActive: true });
const raceMonth = "2047-03";
await Promise.all([
  req("POST", "/superadmin/saas/invoices/generate", { month: raceMonth }),
  req("POST", "/superadmin/saas/invoices", { tenantId, amountCents: 700, dueDate: `${raceMonth}-10` }),
  req("POST", "/superadmin/saas/invoices/generate", { month: raceMonth }),
]);
const monthCharges = (await invoicesOf()).filter((i) => i.dueDate.startsWith(raceMonth) && i.status !== "cancelada");
assert(monthCharges.length === 1, `manual x geração no mesmo mês deixou exatamente 1 cobrança (encontradas ${monthCharges.length})`);

// Corrida contrato x cancelamento: nunca sobra loja cancelada com contrato ativo
for (let round = 0; round < 3; round++) {
  await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "ativo", isActive: true });
  await Promise.all([
    req("PUT", `/superadmin/tenants/${tenantId}/contract`, { plan: "Mensal", monthlyValueCents: 12345, isActive: true }),
    req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "cancelado" }),
    req("PUT", `/superadmin/tenants/${tenantId}/contract`, { plan: "Mensal", monthlyValueCents: 12345, isActive: true }),
  ]);
  const list = (await req("GET", "/superadmin/saas/contracts")).json.contracts.filter((c) => c.tenantId === tenantId);
  const badActive = list.filter((c) => c.isActive);
  assert(badActive.length === 0, `corrida contrato x cancelamento ${round}: loja cancelada sem contrato ativo (ativos: ${badActive.length})`);
}
// Gravar contrato em loja já cancelada é rejeitado
const putCancelled = await req("PUT", `/superadmin/tenants/${tenantId}/contract`, { plan: "Mensal", monthlyValueCents: 999 });
assert(putCancelled.status === 400, `contrato em loja cancelada é rejeitado (status ${putCancelled.status})`);

// Geração paralela SEM cancelamento também não pode duplicar
await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "ativo", isActive: true });
const month = "2045-06";
await Promise.all(Array.from({ length: 6 }, () => req("POST", "/superadmin/saas/invoices/generate", { month })));
const dup = (await invoicesOf()).filter((i) => i.billingMonth === month);
assert(dup.length === 1, `geração 6x paralela criou exatamente 1 mensalidade (encontradas ${dup.length})`);

// Limpeza: cancela a loja de teste (dados de teste ficam marcados como cancelados)
await req("PATCH", `/superadmin/tenants/${tenantId}`, { saasStatus: "cancelado" });
console.log(process.exitCode ? "TESTE FALHOU" : "TESTE PASSOU");
