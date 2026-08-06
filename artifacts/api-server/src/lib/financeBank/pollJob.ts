// Job agendado de sincronização — busca extrato/vendas/repasses novos de cada
// conta PagBank conectada e roda a conciliação em seguida. Molde idêntico ao
// job de faturamento SaaS (lib/saasBilling.ts): guarda de reentrância simples,
// itera as contas, uma falha numa conta não derruba as demais.

import { and, eq, desc } from "drizzle-orm";
import {
  db, bankAccountsTable, bankIntegrationCredentialsTable,
  bankTransactionsTable, acquirerSalesTable, acquirerRepassesTable,
} from "@workspace/db";
import { logger } from "../logger.ts";
import { decryptSecret } from "../crypto.ts";
import { getBankAdapter, getAcquirerAdapter } from "./adapters/registry.ts";
import { createFetchHttpClient } from "./adapters/pagbank.ts";
import { runReconciliation } from "./reconciliation.ts";
import type { DecryptedCredential } from "./adapters/types.ts";

const SYNC_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // primeira sincronização: últimos 30 dias

async function decryptedCredentialFor(bankAccountId: number): Promise<DecryptedCredential | null> {
  const [cred] = await db.select().from(bankIntegrationCredentialsTable)
    .where(and(eq(bankIntegrationCredentialsTable.bankAccountId, bankAccountId), eq(bankIntegrationCredentialsTable.status, "ativo")))
    .orderBy(desc(bankIntegrationCredentialsTable.createdAt)).limit(1);
  if (!cred) return null;
  const secret = decryptSecret({ ciphertext: cred.encryptedPayload, iv: cred.iv, authTag: cred.authTag, keyVersion: cred.keyVersion });
  return { authType: cred.authType, secret };
}

let pollRunning = false;

export async function pollPagBankAccounts(): Promise<void> {
  if (pollRunning) return; // evita ticks sobrepostos
  pollRunning = true;
  const http = createFetchHttpClient();
  try {
    const accounts = await db.select().from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.provider, "pagbank"), eq(bankAccountsTable.status, "conectado"), eq(bankAccountsTable.isActive, true)));

    for (const account of accounts) {
      try {
        const credential = await decryptedCredentialFor(account.id);
        if (!credential) continue;
        const since = account.lastSyncAt ?? new Date(Date.now() - SYNC_LOOKBACK_MS);
        const until = new Date();

        if (account.kind === "maquininha") {
          const adapter = getAcquirerAdapter("pagbank");
          if (!adapter) continue;
          const sales = await adapter.fetchSales(account, credential, http, since, until);
          for (const s of sales) {
            await db.insert(acquirerSalesTable).values({
              tenantId: account.tenantId, bankAccountId: account.id, storeId: account.storeId,
              externalSaleId: s.externalSaleId, soldAt: s.soldAt, grossAmountCents: s.grossAmountCents,
              feeAmountCents: s.feeAmountCents, netAmountCents: s.netAmountCents, installments: s.installments,
              cardBrand: s.cardBrand, paymentMethod: s.paymentMethod, authorizationCode: s.authorizationCode,
              nsu: s.nsu, rawPayload: s.rawPayload,
            }).onConflictDoNothing();
          }
          const repasses = await adapter.fetchRepasses(account, credential, http, since, until);
          for (const r of repasses) {
            await db.insert(acquirerRepassesTable).values({
              tenantId: account.tenantId, bankAccountId: account.id, externalRepasseId: r.externalRepasseId,
              settledAt: r.settledAt, amountCents: r.amountCents, rawPayload: r.rawPayload,
            }).onConflictDoNothing();
          }
        } else {
          const adapter = getBankAdapter("pagbank");
          if (!adapter) continue;
          const transactions = await adapter.fetchTransactions(account, credential, http, since, until);
          for (const t of transactions) {
            await db.insert(bankTransactionsTable).values({
              tenantId: account.tenantId, bankAccountId: account.id, externalId: t.externalId, postedAt: t.postedAt,
              amountCents: t.amountCents, type: t.type, description: t.description,
              counterpartyDoc: t.counterpartyDoc, rawPayload: t.rawPayload,
            }).onConflictDoNothing();
          }
        }

        await db.update(bankAccountsTable).set({ lastSyncAt: until, updatedAt: new Date() }).where(eq(bankAccountsTable.id, account.id));
        await runReconciliation(account.tenantId);
      } catch (err) {
        logger.warn({ err, accountId: account.id }, "Falha ao sincronizar conta PagBank — demais contas seguem normalmente");
        await db.update(bankAccountsTable).set({ status: "erro", updatedAt: new Date() }).where(eq(bankAccountsTable.id, account.id));
      }
    }
  } catch (err) {
    logger.warn({ err }, "Tick de sincronização PagBank falhou");
  } finally {
    pollRunning = false;
  }
}
