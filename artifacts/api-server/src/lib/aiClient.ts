import OpenAI from "openai";
import { openai as globalOpenai } from "@workspace/integrations-openai-ai";
import { db, tenantAiCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptSecret } from "./aiCredentialsCrypto";
import { logger } from "./logger";

// Resolve o client da OpenAI a usar pra um tenant: a chave própria da loja
// (se configurada e ligada) ou a chave global da plataforma como fallback —
// nunca falha "sem IA" só porque a loja não colou uma chave ainda, ou
// porque a credencial dela deu erro (rede, decrypt, etc.).
//
// Cacheado em memória por tenant, invalidado automaticamente quando a
// credencial é salva de novo (updatedAt muda). Isso evita decifrar a chave
// a cada chamada de IA, sem precisar de um TTL/invalidação manual.
const tenantClientCache = new Map<number, { client: OpenAI; updatedAt: number }>();

export async function getOpenAiClientForTenant(tenantId: number): Promise<OpenAI> {
  try {
    const [cred] = await db.select().from(tenantAiCredentialsTable)
      .where(eq(tenantAiCredentialsTable.tenantId, tenantId)).limit(1);
    if (!cred || !cred.useOwnKey) return globalOpenai;

    const updatedAt = cred.updatedAt.getTime();
    const cached = tenantClientCache.get(tenantId);
    if (cached && cached.updatedAt === updatedAt) return cached.client;

    const apiKey = decryptSecret({
      ciphertext: cred.encryptedApiKey, iv: cred.iv, authTag: cred.authTag, keyVersion: cred.keyVersion,
    });
    const client = new OpenAI({ apiKey, timeout: 25_000, maxRetries: 1 });
    tenantClientCache.set(tenantId, { client, updatedAt });
    return client;
  } catch (err) {
    logger.warn({ err, tenantId }, "Falha ao resolver chave OpenAI da loja — usando chave global da plataforma");
    return globalOpenai;
  }
}
