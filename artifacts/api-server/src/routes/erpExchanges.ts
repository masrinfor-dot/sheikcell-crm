import { Router, type IRouter } from "express";
import { db, tenantErpIntegrationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin, requireTenant } from "../middlewares/auth";
import { decryptErpSecret } from "../lib/erpCrypto";
import { erpFlowsOverview, erpKeyScopes, listErpExchanges, withErpTenant, type ErpExchangeQuery } from "../lib/erpExchanges";

// Configurações › Integrações › Trocas com o ERP (19/10/2026): o mapa do que
// é trocado com o ERP Prumo (ligado / desligado / sem acesso na chave) e o
// histórico de cada troca (90 dias). Só admin; nunca devolve a chave.
const router: IRouter = Router();

router.get("/settings/erp/exchanges/flows", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const [row] = await db.select().from(tenantErpIntegrationsTable)
    .where(eq(tenantErpIntegrationsTable.tenantId, tenantId)).limit(1);
  let scopes: string[] | null = null;
  let pingError: string | null = null;
  if (row) {
    const result = await erpKeyScopes(tenantId, async () => {
      const { pingErp } = await import("../lib/erpOsMessages");
      const key = decryptErpSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
      return withErpTenant(tenantId, () => pingErp(row.baseUrl, key));
    });
    scopes = result.scopes;
    pingError = result.error;
  }
  res.json({
    configured: !!row,
    keyScopes: scopes,
    pingError,
    flows: await erpFlowsOverview(tenantId, row ?? null, scopes),
  });
});

router.get("/settings/erp/exchanges", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const q = req.query as Record<string, unknown>;
  const pick = (k: keyof ErpExchangeQuery) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  res.json(await listErpExchanges(tenantId, {
    flow: pick("flow"), direction: pick("direction"), result: pick("result"),
    from: pick("from"), to: pick("to"), hideEmpty: pick("hideEmpty"), page: pick("page"),
  }));
});

export default router;
