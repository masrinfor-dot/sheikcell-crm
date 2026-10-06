import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptErpSecret, encryptErpSecret } from "./erpCrypto";

test("cofre do ERP: sem AI_CREDENTIALS_KEY usa o SESSION_SECRET (v2) e volta ao texto", () => {
  const prevAi = process.env["AI_CREDENTIALS_KEY"];
  const prevSession = process.env["SESSION_SECRET"];
  delete process.env["AI_CREDENTIALS_KEY"];
  process.env["SESSION_SECRET"] = "segredo-de-teste-123";
  const enc = encryptErpSecret("erp_0123456789ab_segredo");
  assert.equal(enc.keyVersion, 2);
  assert.notEqual(enc.ciphertext, "erp_0123456789ab_segredo");
  assert.equal(decryptErpSecret(enc), "erp_0123456789ab_segredo");
  process.env["SESSION_SECRET"] = "sheikcell-dev-only-secret";
  assert.throws(() => encryptErpSecret("x"), /Cofre indisponível/);
  if (prevAi === undefined) delete process.env["AI_CREDENTIALS_KEY"]; else process.env["AI_CREDENTIALS_KEY"] = prevAi;
  if (prevSession === undefined) delete process.env["SESSION_SECRET"]; else process.env["SESSION_SECRET"] = prevSession;
});
