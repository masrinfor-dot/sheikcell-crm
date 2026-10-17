import { test } from "node:test";
import assert from "node:assert/strict";
import { exportDocumentUrl, signExportDocument, verifyExportDocument } from "./documentsExport";

test("documentos → ERP: link assinado do arquivo vale 72h e só pro documento certo", () => {
  const now = 1_700_000_000_000;
  const url = exportDocumentUrl("https://crm.exemplo/api", 42, now);
  assert.match(url, /^https:\/\/crm\.exemplo\/api\/documents-export\/file\/42\?exp=\d+&sig=[0-9a-f]{64}$/);
  const { exp, sig } = signExportDocument(42, now);
  assert.equal(verifyExportDocument(42, exp, sig, now + 71 * 3600_000), true);
  assert.equal(verifyExportDocument(42, exp, sig, now + 73 * 3600_000), false);
  assert.equal(verifyExportDocument(43, exp, sig, now), false);
  assert.equal(verifyExportDocument(42, exp + 1, sig, now), false);
  assert.equal(verifyExportDocument(42, exp, "00", now), false);
  assert.equal(verifyExportDocument(-1, exp, sig, now), false);
});
