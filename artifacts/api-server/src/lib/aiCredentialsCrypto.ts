import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Criptografia em repouso da chave de IA (OpenAI) que cada loja pode colar
// pra usar a própria conta em vez da chave global da plataforma. Mesmo
// padrão AES-256-GCM já usado antes pelo módulo Financeiro Bancário
// (removido, ver git history do commit "Remove Distribuição... Financeiro
// Bancário"): cada segredo tem seu próprio IV (nunca reaproveitado) e o
// authTag garante que um payload adulterado falha ao decifrar em vez de
// retornar lixo silenciosamente.
//
// AI_CREDENTIALS_KEY precisa ser 32 bytes em base64, ex.: gerar com
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const ALGORITHM = "aes-256-gcm";
const KEY_VERSION = 1;

let cachedKey: Buffer | null = null;

// Falha explícita (throw) em vez de um fallback silencioso — sem a chave,
// nenhuma credencial de loja pode ser gravada ou lida, nunca "funciona sem
// criptografar".
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env["AI_CREDENTIALS_KEY"];
  if (!raw) {
    throw new Error("AI_CREDENTIALS_KEY env var is required to encrypt/decrypt per-tenant AI credentials");
  }
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error("AI_CREDENTIALS_KEY must decode to exactly 32 bytes (AES-256)");
  }
  cachedKey = key;
  return key;
}

export type EncryptedSecret = {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyVersion: number;
};

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(12); // 96 bits — recomendado para GCM
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION,
  };
}

export function decryptSecret(payload: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
