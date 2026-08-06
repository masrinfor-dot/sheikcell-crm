import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Criptografia em repouso das credenciais de integração financeira (ver
// bank_integration_credentials). AES-256-GCM: cada segredo tem seu próprio IV
// (nunca reaproveitado) e o authTag garante que um payload adulterado falha ao
// decifrar em vez de retornar lixo silenciosamente.
//
// FINANCE_CREDENTIALS_KEY precisa ser 32 bytes em base64, ex.: gerar com
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const ALGORITHM = "aes-256-gcm";
const KEY_VERSION = 1;

let cachedKey: Buffer | null = null;

// Falha explícita (throw) em vez de um fallback silencioso — sem a chave,
// nenhum segredo pode ser gravado ou lido, nunca "funciona sem criptografar".
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env["FINANCE_CREDENTIALS_KEY"];
  if (!raw) {
    throw new Error("FINANCE_CREDENTIALS_KEY env var is required to encrypt/decrypt integration credentials");
  }
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error("FINANCE_CREDENTIALS_KEY must decode to exactly 32 bytes (AES-256)");
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
