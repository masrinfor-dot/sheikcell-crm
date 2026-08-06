import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env["FINANCE_CREDENTIALS_KEY"] = randomBytes(32).toString("base64");
const { encryptSecret, decryptSecret } = await import("./crypto.ts");

test("encryptSecret/decryptSecret round-trip preserva o texto original", () => {
  const original = "token-secreto-do-pagbank-12345";
  const enc = encryptSecret(original);
  assert.equal(decryptSecret(enc), original);
});

test("ciphertext/iv mudam a cada chamada (IV nunca reaproveitado)", () => {
  const enc1 = encryptSecret("mesmo-segredo");
  const enc2 = encryptSecret("mesmo-segredo");
  assert.notEqual(enc1.iv, enc2.iv);
  assert.notEqual(enc1.ciphertext, enc2.ciphertext);
});

test("payload adulterado (authTag trocado) falha ao decifrar", () => {
  const enc = encryptSecret("valor-original");
  const tampered = { ...enc, authTag: encryptSecret("outro").authTag };
  assert.throws(() => decryptSecret(tampered));
});
