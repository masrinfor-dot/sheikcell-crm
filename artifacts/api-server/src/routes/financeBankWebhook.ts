import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, bankAccountsTable, bankTransactionsTable, acquirerSalesTable, acquirerRepassesTable } from "@workspace/db";
import { pagBankAdapter } from "../lib/financeBank/adapters/pagbank.ts";
import type { ParsedWebhookPayload } from "../lib/financeBank/adapters/types.ts";
import { runReconciliation } from "../lib/financeBank/reconciliation.ts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Webhook do PagBank — SEM sessão/auth normal (é o servidor do PagBank
// chamando, não um usuário logado). A segurança é a verificação de assinatura
// (ver risco de doc no adapter). Não é filtrado por tenant pela URL — o
// tenant/loja é resolvido pelo external_account_id dentro do próprio payload,
// batido contra bank_accounts.external_account_id já cadastrado.
router.post("/finance-bank/webhook/pagbank", async (req: Request, res: Response): Promise<void> => {
  const verification = pagBankAdapter.verifyWebhookSignature(req.headers as Record<string, string>, req.rawBody ?? Buffer.alloc(0));
  if (!verification.valid) {
    logger.warn({ reason: verification.reason }, "Webhook PagBank rejeitado: assinatura inválida");
    res.status(401).json({ error: "Assinatura inválida" });
    return;
  }

  let payload: ParsedWebhookPayload;
  try {
    payload = pagBankAdapter.parseWebhookPayload(req.rawBody ?? Buffer.alloc(0));
  } catch (err) {
    logger.warn({ err }, "Webhook PagBank: payload inválido");
    res.status(400).json({ error: "Payload inválido" });
    return;
  }

  const accounts = await db.select().from(bankAccountsTable)
    .where(and(eq(bankAccountsTable.provider, "pagbank"), eq(bankAccountsTable.externalAccountId, payload.externalAccountId)));
  if (accounts.length === 0) {
    // Conta ainda não cadastrada no sistema — não é erro do PagBank, só não
    // temos onde gravar ainda. 200 para o PagBank não ficar reenviando.
    res.json({ ok: true, ignored: true });
    return;
  }

  for (const account of accounts) {
    if (account.kind === "maquininha") {
      for (const s of payload.sales) {
        await db.insert(acquirerSalesTable).values({
          tenantId: account.tenantId, bankAccountId: account.id, storeId: account.storeId,
          externalSaleId: s.externalSaleId, soldAt: s.soldAt, grossAmountCents: s.grossAmountCents,
          feeAmountCents: s.feeAmountCents, netAmountCents: s.netAmountCents, installments: s.installments,
          cardBrand: s.cardBrand, paymentMethod: s.paymentMethod, authorizationCode: s.authorizationCode,
          nsu: s.nsu, rawPayload: s.rawPayload,
        }).onConflictDoNothing();
      }
      for (const r of payload.repasses) {
        await db.insert(acquirerRepassesTable).values({
          tenantId: account.tenantId, bankAccountId: account.id, externalRepasseId: r.externalRepasseId,
          settledAt: r.settledAt, amountCents: r.amountCents, rawPayload: r.rawPayload,
        }).onConflictDoNothing();
      }
    } else {
      for (const t of payload.transactions) {
        await db.insert(bankTransactionsTable).values({
          tenantId: account.tenantId, bankAccountId: account.id, externalId: t.externalId, postedAt: t.postedAt,
          amountCents: t.amountCents, type: t.type, description: t.description,
          counterpartyDoc: t.counterpartyDoc, rawPayload: t.rawPayload,
        }).onConflictDoNothing();
      }
    }
    await runReconciliation(account.tenantId);
  }

  res.json({ ok: true });
});

export default router;
