import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Cofre da chave do ERP (06/10/2026). Usa AI_CREDENTIALS_KEY quando o
// servidor tem (versão 1, a mesma da chave de IA); senão deriva uma chave do
// SESSION_SECRET do servidor (versão 2) — assim a loja liga o ERP sem
// precisar configurar uma variável nova no servidor. Sem nenhum dos dois (ou
// com o segredo de desenvolvimento), recusa: nunca grava a chave sem cifrar.
const ALGORITHM = "aes-256-gcm";
const DEV_SESSION_SECRET = "sheikcell-dev-only-secret";

export type ErpEncrypted = { ciphertext: string; iv: string; authTag: string; keyVersion: number };

function keyFor(version: number): Buffer {
  if (version === 1) {
    const raw = process.env["AI_CREDENTIALS_KEY"];
    if (!raw) throw new Error("Cofre indisponível no servidor (AI_CREDENTIALS_KEY).");
    const key = Buffer.from(raw, "base64");
    if (key.byteLength !== 32) throw new Error("AI_CREDENTIALS_KEY precisa ter 32 bytes.");
    return key;
  }
  if (version === 2) {
    const secret = process.env["SESSION_SECRET"];
    if (!secret || secret === DEV_SESSION_SECRET) {
      throw new Error("Cofre indisponível no servidor: configure SESSION_SECRET (ou AI_CREDENTIALS_KEY).");
    }
    return createHash("sha256").update(`erp-integration-v1:${secret}`).digest();
  }
  throw new Error(`Versão de cofre desconhecida: ${version}`);
}

/** Versão a usar para gravar agora: 1 se o servidor tem AI_CREDENTIALS_KEY, senão 2. */
export function currentErpKeyVersion(): number {
  return process.env["AI_CREDENTIALS_KEY"] ? 1 : 2;
}

export function encryptErpSecret(plaintext: string): ErpEncrypted {
  const keyVersion = currentErpKeyVersion();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFor(keyVersion), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptErpSecret(payload: ErpEncrypted): string {
  const decipher = createDecipheriv(ALGORITHM, keyFor(payload.keyVersion), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
