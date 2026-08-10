import { Router, type IRouter, type Request } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  db, bankAccountsTable, bankIntegrationCredentialsTable, bankTransactionsTable,
  acquirerSalesTable, reconciliationMatchesTable, storesTable, usersTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, sql, type SQL } from "drizzle-orm";
import { requireAdmin, requireAdminOrSupervisor, requireAuth, requireFeature, requireTenant, requireReauth, requireModule, isGlobalRole, verifyPassword } from "../middlewares/auth";
import { encryptSecret, type EncryptedSecret } from "../lib/crypto";
import { listProviders, ALL_PROVIDERS } from "../lib/financeBank/adapters/registry.ts";
import { runReconciliation } from "../lib/financeBank/reconciliation.ts";
import { computeMetrics, type MetricsTransaction, type MetricsSale } from "../lib/financeBank/metrics.ts";
import { logFinanceAudit } from "../lib/financeBank/audit.ts";
import { isOAuthProvider, authorizeUrl, exchangeCode } from "../lib/oauthProviders.ts";

const router: IRouter = Router();
router.use("/finance-bank", requireModule("financeiro_bancario"));
const FEATURE = "financeiro-bancario";

async function getOwnedStore(storeId: number, tenantId: number) {
  const [s] = await db.select().from(storesTable)
    .where(and(eq(storesTable.id, storeId), eq(storesTable.tenantId, tenantId))).limit(1);
  return s ?? null;
}

async function getOwnedAccount(accountId: number, tenantId: number) {
  const [a] = await db.select().from(bankAccountsTable)
    .where(and(eq(bankAccountsTable.id, accountId), eq(bankAccountsTable.tenantId, tenantId))).limit(1);
  return a ?? null;
}

// Isolamento por loja para quem NÃO é admin/supervisor (ex.: vendedor com a
// feature "financeiro-bancario" liberada via adminAccess) — mesma regra já
// usada em results.ts ("filtro por loja é exclusivo de admin/supervisor",
// fail closed, servidor manda): a loja pedida é ignorada e substituída pela
// própria loja do usuário (users.storeName → stores.id).
// undefined = sem restrição extra (papel global, usa o storeId pedido).
// null = usuário sem loja correspondente ⇒ resultado deve ser vazio, não erro.
async function resolveScopedStoreId(req: Request, tenantId: number, requestedStoreId: number | undefined): Promise<number | null | undefined> {
  if (isGlobalRole(req.session.userRole)) return requestedStoreId;
  const [me] = await db.select({ storeName: usersTable.storeName }).from(usersTable)
    .where(eq(usersTable.id, req.session.userId!)).limit(1);
  if (!me?.storeName) return null;
  const [store] = await db.select({ id: storesTable.id }).from(storesTable)
    .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.name, me.storeName))).limit(1);
  return store?.id ?? null;
}

// ─── Provedores conhecidos (para a tela de cadastro escolher banco/status) ──
router.get("/finance-bank/providers", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(listProviders());
});

// ─── Contas bancárias / maquininhas ─────────────────────────────────────────
router.get("/finance-bank/accounts", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, undefined);
  if (scopedStoreId === null) { res.json([]); return; }
  const conditions: SQL[] = [eq(bankAccountsTable.tenantId, tenantId)];
  if (scopedStoreId !== undefined) conditions.push(eq(bankAccountsTable.storeId, scopedStoreId));
  const rows = await db
    .select({
      id: bankAccountsTable.id, storeId: bankAccountsTable.storeId, storeName: storesTable.name,
      provider: bankAccountsTable.provider, kind: bankAccountsTable.kind, label: bankAccountsTable.label,
      status: bankAccountsTable.status, lastSyncAt: bankAccountsTable.lastSyncAt, isActive: bankAccountsTable.isActive,
      createdAt: bankAccountsTable.createdAt,
    })
    .from(bankAccountsTable)
    .innerJoin(storesTable, eq(bankAccountsTable.storeId, storesTable.id))
    .where(and(...conditions))
    .orderBy(desc(bankAccountsTable.createdAt));
  res.json(rows);
});

router.post("/finance-bank/accounts", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { storeId, provider, kind, label } = req.body as { storeId?: number; provider?: string; kind?: string; label?: string };
  if (!storeId || !(await getOwnedStore(storeId, tenantId))) { res.status(400).json({ error: "Loja inválida" }); return; }
  if (!provider || !ALL_PROVIDERS.includes(provider as (typeof ALL_PROVIDERS)[number])) { res.status(400).json({ error: "Provedor inválido" }); return; }
  const cleanLabel = typeof label === "string" ? label.trim().slice(0, 120) : "";
  if (!cleanLabel) { res.status(400).json({ error: "Dê um nome para a conta" }); return; }
  const cleanKind = kind === "maquininha" ? "maquininha" : "conta";

  const [account] = await db.insert(bankAccountsTable).values({
    tenantId, storeId, provider, kind: cleanKind, label: cleanLabel, status: "nao_configurado",
  }).returning();
  await logFinanceAudit(req, tenantId, "account.create", "bank_account", account!.id, { storeId, provider, kind: cleanKind, label: cleanLabel });
  res.status(201).json(account);
});

router.patch("/finance-bank/accounts/:id", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  const account = await getOwnedAccount(id, tenantId);
  if (!account) { res.status(404).json({ error: "Conta não encontrada" }); return; }

  const { label, isActive } = req.body as { label?: string; isActive?: boolean };
  const updates: Partial<typeof bankAccountsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof label === "string" && label.trim()) updates.label = label.trim().slice(0, 120);
  if (typeof isActive === "boolean") updates.isActive = isActive;

  const [updated] = await db.update(bankAccountsTable).set(updates)
    .where(and(eq(bankAccountsTable.id, id), eq(bankAccountsTable.tenantId, tenantId))).returning();
  await logFinanceAudit(req, tenantId, "account.update", "bank_account", id, { label, isActive });
  res.json(updated);
});

router.delete("/finance-bank/accounts/:id", requireAdmin, requireReauth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  const account = await getOwnedAccount(id, tenantId);
  if (!account) { res.status(404).json({ error: "Conta não encontrada" }); return; }
  // Sem cascade em bank_transactions/acquirer_sales de propósito (auditabilidade
  // — nenhum lançamento financeiro some junto com o cadastro da conta). A
  // exclusão só é permitida enquanto não houver histórico gravado.
  const [hasTx] = await db.select({ id: bankTransactionsTable.id }).from(bankTransactionsTable)
    .where(eq(bankTransactionsTable.bankAccountId, id)).limit(1);
  if (hasTx) { res.status(409).json({ error: "Conta tem transações registradas — desative em vez de excluir" }); return; }
  await db.delete(bankIntegrationCredentialsTable).where(eq(bankIntegrationCredentialsTable.bankAccountId, id));
  await db.delete(bankAccountsTable).where(and(eq(bankAccountsTable.id, id), eq(bankAccountsTable.tenantId, tenantId)));
  await logFinanceAudit(req, tenantId, "account.delete", "bank_account", id, { label: account.label, provider: account.provider });
  res.json({ ok: true });
});

// ─── Credenciais de integração (criptografadas antes de gravar) ────────────
// Compartilhado pelos 3 jeitos de conectar uma conta (token colado, callback
// OAuth, upload de certificado) — sempre criptografa, grava e marca a conta
// como conectada do mesmo jeito, só o payload/authType muda por chamador.
async function saveCredential(
  req: Request, tenantId: number, accountId: number, provider: string,
  authType: "oauth" | "api_key" | "certificate", secretPlaintext: string, expiresAt: Date | null,
): Promise<void> {
  const encrypted: EncryptedSecret = encryptSecret(secretPlaintext);
  await db.insert(bankIntegrationCredentialsTable).values({
    tenantId, bankAccountId: accountId, provider, authType,
    encryptedPayload: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion,
    expiresAt: expiresAt ?? undefined, status: "ativo",
  });
  await db.update(bankAccountsTable).set({ status: "conectado", updatedAt: new Date() })
    .where(eq(bankAccountsTable.id, accountId));
  // Nunca logar o segredo em si — só que uma credencial foi trocada, quando e por quem.
  await logFinanceAudit(req, tenantId, "credential.save", "bank_integration_credential", accountId, { provider, authType });
}

router.post("/finance-bank/accounts/:id/credentials", requireAdmin, requireReauth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  const account = await getOwnedAccount(id, tenantId);
  if (!account) { res.status(404).json({ error: "Conta não encontrada" }); return; }

  const { secret } = req.body as { secret?: string };
  if (typeof secret !== "string" || !secret.trim()) { res.status(400).json({ error: "Informe o token/credencial" }); return; }

  await saveCredential(req, tenantId, id, account.provider, "api_key", secret.trim(), null);
  res.status(201).json({ ok: true });
});

// ─── Certificado digital (Inter, Itaú, Bradesco, Sicoob, Sicredi) ───────────
// Esses bancos não têm login-e-autoriza — o próprio titular gera um
// certificado (.pfx/.cer/.pem) + client_id/secret na área logada do banco.
// Guardamos tudo (certificado em base64 + credenciais) num único JSON
// criptografado — não vai pro disco, é pequeno o bastante pra caber
// direto na coluna já usada pelos outros dois tipos de credencial.
const CERT_EXTENSIONS = [".pfx", ".p12", ".cer", ".crt", ".pem"];
const CERT_MAX_BYTES = 2 * 1024 * 1024; // certificado é pequeno (KBs)

router.post("/finance-bank/accounts/:id/certificate", requireAdmin, requireReauth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  const account = await getOwnedAccount(id, tenantId);
  if (!account) { res.status(404).json({ error: "Conta não encontrada" }); return; }

  const { fileName, mimeType, data, certPassword, clientId, clientSecret } = req.body as {
    fileName?: string; mimeType?: string; data?: string; certPassword?: string; clientId?: string; clientSecret?: string;
  };
  if (!fileName || !CERT_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))) {
    res.status(400).json({ error: "Envie um arquivo .pfx, .p12, .cer, .crt ou .pem" }); return;
  }
  if (typeof data !== "string" || !data) { res.status(400).json({ error: "Arquivo vazio" }); return; }
  if (!clientId?.trim() || !clientSecret?.trim()) { res.status(400).json({ error: "Informe Client ID e Client Secret" }); return; }
  const bytes = Buffer.from(data, "base64").byteLength;
  if (bytes > CERT_MAX_BYTES) { res.status(400).json({ error: "Arquivo muito grande (máx. 2MB)" }); return; }

  const bundle = JSON.stringify({
    certBase64: data, certFileName: fileName, certMimeType: mimeType ?? "application/octet-stream",
    certPassword: certPassword ?? null, clientId: clientId.trim(), clientSecret: clientSecret.trim(),
  });
  await saveCredential(req, tenantId, id, account.provider, "certificate", bundle, null);
  res.status(201).json({ ok: true });
});

// ─── OAuth (PagBank, Mercado Pago): "Conectar" sem nunca ver a chave ────────
// state assinado (HMAC) em vez de guardar numa tabela — cabe tudo que o
// callback precisa (accountId/tenantId) no próprio state, verificado por
// assinatura + validade (10 min), sem round-trip extra no banco.
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  return process.env["FINANCE_OAUTH_STATE_SECRET"] || process.env["SESSION_SECRET"] || "sheikcell-dev-only-secret";
}

function signOAuthState(payload: { accountId: number; tenantId: number; provider: string; nonce: string; iat: number }): string {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(json).digest("base64url");
  return `${json}.${sig}`;
}

function verifyOAuthState(state: string): { accountId: number; tenantId: number; provider: string; iat: number } | null {
  const [json, sig] = state.split(".");
  if (!json || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(json).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(json, "base64url").toString("utf8")) as { accountId: number; tenantId: number; provider: string; iat: number };
    if (Date.now() - payload.iat > STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function appOrigin(req: Request): string {
  return process.env["APP_URL"] || `${req.protocol}://${req.get("host")}`;
}

// POST (não GET) de propósito: precisa de requireReauth (senha no corpo — uma
// senha NUNCA deve ir em query string de URL), então devolve a URL de
// autorização pronta em JSON; o front navega (window.location.href) depois.
router.post("/finance-bank/oauth/:provider/start", requireAdmin, requireReauth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const provider = req.params.provider as string;
  if (!isOAuthProvider(provider)) { res.status(400).json({ error: "Provedor não suporta conexão OAuth" }); return; }
  const { accountId } = req.body as { accountId?: number };
  const account = accountId != null ? await getOwnedAccount(accountId, tenantId) : null;
  if (!account) { res.status(404).json({ error: "Conta não encontrada" }); return; }
  if (account.provider !== provider) { res.status(400).json({ error: "Conta não corresponde ao provedor" }); return; }

  const state = signOAuthState({ accountId: accountId!, tenantId, provider, nonce: randomBytes(8).toString("hex"), iat: Date.now() });
  const redirectUri = `${appOrigin(req)}/api/finance-bank/oauth/${provider}/callback`;
  try {
    res.json({ url: authorizeUrl(provider, redirectUri, state) });
  } catch (err) {
    req.log.error({ err }, "Falha ao montar URL de autorização OAuth");
    res.status(500).json({ error: "Conexão OAuth não configurada para este provedor ainda" });
  }
});

router.get("/finance-bank/oauth/:provider/callback", requireAuth, async (req, res): Promise<void> => {
  const provider = req.params.provider as string;
  const { code, state } = req.query as { code?: string; state?: string };
  const back = (qs: string) => res.redirect(`${appOrigin(req)}/?financeiro-bancario=${qs}`);
  if (!isOAuthProvider(provider) || !code || !state) { back("oauth_error&reason=parametros_invalidos"); return; }

  const decoded = verifyOAuthState(state);
  if (!decoded || decoded.provider !== provider || decoded.tenantId !== req.session.tenantId) {
    back("oauth_error&reason=state_invalido"); return;
  }
  const account = await getOwnedAccount(decoded.accountId, decoded.tenantId);
  if (!account) { back("oauth_error&reason=conta_nao_encontrada"); return; }

  try {
    const redirectUri = `${appOrigin(req)}/api/finance-bank/oauth/${provider}/callback`;
    const token = await exchangeCode(provider, code, redirectUri);
    const expiresAt = token.expiresInSeconds ? new Date(Date.now() + token.expiresInSeconds * 1000) : null;
    const bundle = JSON.stringify({ accessToken: token.accessToken, refreshToken: token.refreshToken, tokenType: "bearer" });
    await saveCredential(req, decoded.tenantId, decoded.accountId, provider, "oauth", bundle, expiresAt);
    back("oauth_success");
  } catch (err) {
    req.log.error({ err }, "Falha ao trocar código OAuth por access token");
    await logFinanceAudit(req, decoded.tenantId, "credential.save", "bank_integration_credential", decoded.accountId, { provider, authType: "oauth", failed: true });
    back("oauth_error&reason=troca_de_token_falhou");
  }
});

// ─── Extrato (transações) ───────────────────────────────────────────────────
router.get("/finance-bank/transactions", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { accountId, storeId, status, from, to } = req.query as Record<string, string | undefined>;
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, storeId ? Number(storeId) : undefined);
  if (scopedStoreId === null) { res.json([]); return; }

  const conditions: SQL[] = [eq(bankTransactionsTable.tenantId, tenantId)];
  if (accountId) conditions.push(eq(bankTransactionsTable.bankAccountId, Number(accountId)));
  if (scopedStoreId !== undefined) conditions.push(eq(bankAccountsTable.storeId, scopedStoreId));
  if (status) conditions.push(eq(bankTransactionsTable.reconciliationStatus, status));
  if (from) conditions.push(gte(bankTransactionsTable.postedAt, new Date(from)));
  if (to) conditions.push(lte(bankTransactionsTable.postedAt, new Date(to)));

  const rows = await db
    .select({
      id: bankTransactionsTable.id, bankAccountId: bankTransactionsTable.bankAccountId,
      accountLabel: bankAccountsTable.label, storeId: bankAccountsTable.storeId,
      postedAt: bankTransactionsTable.postedAt, amountCents: bankTransactionsTable.amountCents,
      type: bankTransactionsTable.type, description: bankTransactionsTable.description,
      reconciliationStatus: bankTransactionsTable.reconciliationStatus,
    })
    .from(bankTransactionsTable)
    .innerJoin(bankAccountsTable, eq(bankTransactionsTable.bankAccountId, bankAccountsTable.id))
    .where(and(...conditions))
    .orderBy(desc(bankTransactionsTable.postedAt))
    .limit(500);

  res.json(rows);
});

// ─── Vendas de cartão (credenciadora/maquininha) ────────────────────────────
router.get("/finance-bank/sales", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { accountId, storeId, from, to } = req.query as Record<string, string | undefined>;
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, storeId ? Number(storeId) : undefined);
  if (scopedStoreId === null) { res.json([]); return; }

  const conditions: SQL[] = [eq(acquirerSalesTable.tenantId, tenantId)];
  if (accountId) conditions.push(eq(acquirerSalesTable.bankAccountId, Number(accountId)));
  if (scopedStoreId !== undefined) conditions.push(eq(acquirerSalesTable.storeId, scopedStoreId));
  if (from) conditions.push(gte(acquirerSalesTable.soldAt, new Date(from)));
  if (to) conditions.push(lte(acquirerSalesTable.soldAt, new Date(to)));

  const rows = await db.select().from(acquirerSalesTable).where(and(...conditions))
    .orderBy(desc(acquirerSalesTable.soldAt)).limit(500);
  res.json(rows);
});

// ─── Rodar conciliação manualmente ───────────────────────────────────────────
router.post("/finance-bank/reconcile", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { storeId } = req.body as { storeId?: number };
  const summary = await runReconciliation(tenantId, storeId);
  res.json(summary);
});

// ─── Fila de conciliação (revisão manual) ───────────────────────────────────
// Confere se o match pertence a uma loja que o usuário pode ver (mesma regra
// de isolamento das rotas de leitura acima) — usado tanto na listagem quanto
// no confirmar/rejeitar, para um vendedor não conciliar lançamento de outra loja.
async function getScopedMatch(req: Request, tenantId: number, matchId: number) {
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, undefined);
  if (scopedStoreId === null) return null;
  const conditions: SQL[] = [eq(reconciliationMatchesTable.id, matchId), eq(reconciliationMatchesTable.tenantId, tenantId)];
  if (scopedStoreId !== undefined) conditions.push(eq(bankAccountsTable.storeId, scopedStoreId));
  const [row] = await db.select({ id: reconciliationMatchesTable.id, bankTransactionId: reconciliationMatchesTable.bankTransactionId })
    .from(reconciliationMatchesTable)
    .innerJoin(bankTransactionsTable, eq(reconciliationMatchesTable.bankTransactionId, bankTransactionsTable.id))
    .innerJoin(bankAccountsTable, eq(bankTransactionsTable.bankAccountId, bankAccountsTable.id))
    .where(and(...conditions)).limit(1);
  return row ?? null;
}

router.get("/finance-bank/reconciliation-matches", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { status } = req.query as { status?: string };
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, undefined);
  if (scopedStoreId === null) { res.json([]); return; }

  const conditions: SQL[] = [eq(reconciliationMatchesTable.tenantId, tenantId)];
  if (status) conditions.push(eq(reconciliationMatchesTable.status, status));
  if (scopedStoreId !== undefined) conditions.push(eq(bankAccountsTable.storeId, scopedStoreId));

  const rows = await db
    .select({
      id: reconciliationMatchesTable.id, bankTransactionId: reconciliationMatchesTable.bankTransactionId,
      matchedType: reconciliationMatchesTable.matchedType, matchedRecordId: reconciliationMatchesTable.matchedRecordId,
      ruleId: reconciliationMatchesTable.ruleId, matchedBy: reconciliationMatchesTable.matchedBy,
      status: reconciliationMatchesTable.status, createdAt: reconciliationMatchesTable.createdAt,
    })
    .from(reconciliationMatchesTable)
    .innerJoin(bankTransactionsTable, eq(reconciliationMatchesTable.bankTransactionId, bankTransactionsTable.id))
    .innerJoin(bankAccountsTable, eq(bankTransactionsTable.bankAccountId, bankAccountsTable.id))
    .where(and(...conditions))
    .orderBy(desc(reconciliationMatchesTable.createdAt)).limit(500);
  res.json(rows);
});

// Acima deste valor (em centavos), confirmar manualmente exige reautenticar
// por senha — abaixo, confirma normal (não incomodar por valores pequenos).
const REAUTH_THRESHOLD_CENTS = Number(process.env["FINANCE_REAUTH_THRESHOLD_CENTS"] ?? 500_000);

router.post("/finance-bank/reconciliation-matches/:id/confirm", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  const match = await getScopedMatch(req, tenantId, id);
  if (!match) { res.status(404).json({ error: "Match não encontrado" }); return; }

  const [tx] = await db.select({ amountCents: bankTransactionsTable.amountCents }).from(bankTransactionsTable)
    .where(eq(bankTransactionsTable.id, match.bankTransactionId)).limit(1);
  if (tx && Math.abs(tx.amountCents) >= REAUTH_THRESHOLD_CENTS) {
    const { confirmPassword } = req.body as { confirmPassword?: string };
    const valid = typeof confirmPassword === "string" && (await verifyPassword(req.session.userId!, confirmPassword));
    await logFinanceAudit(req, tenantId, valid ? "reauth.success" : "reauth.failed", "reauth", id, { path: req.path, amountCents: tx.amountCents });
    if (!valid) { res.status(401).json({ error: "Confirme sua senha para continuar", code: "REAUTH_REQUIRED" }); return; }
  }

  const [updated] = await db.update(reconciliationMatchesTable).set({ status: "manual_confirmed" })
    .where(and(eq(reconciliationMatchesTable.id, id), eq(reconciliationMatchesTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Match não encontrado" }); return; }
  await logFinanceAudit(req, tenantId, "match.confirm", "reconciliation_match", id);
  res.json(updated);
});

router.post("/finance-bank/reconciliation-matches/:id/reject", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!, 10);
  const match = await getScopedMatch(req, tenantId, id);
  if (!match) { res.status(404).json({ error: "Match não encontrado" }); return; }

  // Rejeitar desfaz o casamento: a transação volta a ficar pendente para ser
  // conciliada de novo (manualmente ou numa próxima rodada automática).
  await db.update(reconciliationMatchesTable).set({ status: "rejected" }).where(eq(reconciliationMatchesTable.id, id));
  await db.update(bankTransactionsTable).set({ reconciliationStatus: "pending" })
    .where(eq(bankTransactionsTable.id, match.bankTransactionId));
  await logFinanceAudit(req, tenantId, "match.reject", "reconciliation_match", id, { bankTransactionId: match.bankTransactionId });
  res.json({ ok: true });
});

// ─── Dashboard de saldos ─────────────────────────────────────────────────────
router.get("/finance-bank/dashboard", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { storeId } = req.query as { storeId?: string };
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, storeId ? Number(storeId) : undefined);
  if (scopedStoreId === null) { res.json({ accounts: [], totalCents: 0 }); return; }

  const conditions: SQL[] = [eq(bankAccountsTable.tenantId, tenantId), eq(bankAccountsTable.isActive, true)];
  if (scopedStoreId !== undefined) conditions.push(eq(bankAccountsTable.storeId, scopedStoreId));

  // Saldo aproximado = soma de tudo que já entrou/saiu no extrato importado
  // (não é o saldo "oficial" do banco — ver adapter.fetchBalance para isso —
  // mas já dá visão em tempo real do que o sistema conhece, com o timestamp
  // de última sincronização de cada conta ao lado para deixar claro o atraso).
  const rows = await db
    .select({
      accountId: bankAccountsTable.id, label: bankAccountsTable.label, provider: bankAccountsTable.provider,
      storeId: bankAccountsTable.storeId, storeName: storesTable.name, lastSyncAt: bankAccountsTable.lastSyncAt,
      balanceCents: sql<number>`coalesce(sum(${bankTransactionsTable.amountCents}), 0)::int`,
    })
    .from(bankAccountsTable)
    .innerJoin(storesTable, eq(bankAccountsTable.storeId, storesTable.id))
    .leftJoin(bankTransactionsTable, eq(bankTransactionsTable.bankAccountId, bankAccountsTable.id))
    .where(and(...conditions))
    .groupBy(bankAccountsTable.id, storesTable.name);

  const totalCents = rows.reduce((sum, r) => sum + r.balanceCents, 0);
  res.json({ accounts: rows, totalCents });
});

// ─── Métricas do dashboard (gráficos + filtros) ─────────────────────────────
// Agregação em JS (não em SQL) de propósito: no volume esperado da Fase 1 (uma
// integração, poucas lojas) é simples, testável (ver metrics.ts/metrics.test.ts)
// e evita SQL de agrupamento por data diferente por dialeto/driver. Revisitar
// se o volume crescer muito (agregação no banco).
router.get("/finance-bank/metrics", requireFeature(FEATURE), async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const { storeId, provider, from, to } = req.query as Record<string, string | undefined>;
  const scopedStoreId = await resolveScopedStoreId(req, tenantId, storeId ? Number(storeId) : undefined);
  if (scopedStoreId === null) {
    res.json({ totals: { creditCents: 0, debitCents: 0, netCents: 0, pendingCount: 0, matchedCount: 0, reconciliationRatePct: 0 }, cashFlowByDay: [], byStore: [], byProvider: [], salesByPaymentMethod: [] });
    return;
  }

  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  const txConditions: SQL[] = [
    eq(bankTransactionsTable.tenantId, tenantId),
    gte(bankTransactionsTable.postedAt, fromDate),
    lte(bankTransactionsTable.postedAt, toDate),
  ];
  if (scopedStoreId !== undefined) txConditions.push(eq(bankAccountsTable.storeId, scopedStoreId));
  if (provider) txConditions.push(eq(bankAccountsTable.provider, provider));

  const transactions = await db
    .select({
      amountCents: bankTransactionsTable.amountCents, type: bankTransactionsTable.type,
      postedAt: bankTransactionsTable.postedAt, reconciliationStatus: bankTransactionsTable.reconciliationStatus,
      storeId: bankAccountsTable.storeId, storeName: storesTable.name, provider: bankAccountsTable.provider,
    })
    .from(bankTransactionsTable)
    .innerJoin(bankAccountsTable, eq(bankTransactionsTable.bankAccountId, bankAccountsTable.id))
    .innerJoin(storesTable, eq(bankAccountsTable.storeId, storesTable.id))
    .where(and(...txConditions));

  const saleConditions: SQL[] = [
    eq(acquirerSalesTable.tenantId, tenantId),
    gte(acquirerSalesTable.soldAt, fromDate),
    lte(acquirerSalesTable.soldAt, toDate),
  ];
  if (scopedStoreId !== undefined) saleConditions.push(eq(acquirerSalesTable.storeId, scopedStoreId));

  const sales = await db
    .select({ paymentMethod: acquirerSalesTable.paymentMethod, grossAmountCents: acquirerSalesTable.grossAmountCents })
    .from(acquirerSalesTable)
    .where(and(...saleConditions));

  // type/reconciliationStatus/paymentMethod são colunas text() sem $type<>() no
  // schema (mesmo padrão do resto do módulo) — só valores das nossas próprias
  // rotas de inserção chegam aqui, então o cast é seguro.
  res.json(computeMetrics(transactions as MetricsTransaction[], sales as MetricsSale[]));
});

export default router;
