import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPhotoUrl, signExportPhoto, verifyExportPhoto } from "./tradeInExport";

test("avaliação → ERP: link assinado da foto vale 72h e só pro arquivo certo", () => {
  const now = 1_700_000_000_000;
  const url = exportPhotoUrl("https://crm.exemplo/api", "/api/chat/media/abc-1.jpg", now)!;
  assert.match(url, /^https:\/\/crm\.exemplo\/api\/trade-in-export\/photo\/abc-1\.jpg\?exp=\d+&sig=[0-9a-f]{64}$/);
  const { exp, sig } = signExportPhoto("abc-1.jpg", now);
  assert.equal(verifyExportPhoto("abc-1.jpg", exp, sig, now + 71 * 3600_000), true);
  assert.equal(verifyExportPhoto("abc-1.jpg", exp, sig, now + 73 * 3600_000), false);
  assert.equal(verifyExportPhoto("outro.jpg", exp, sig, now), false);
  assert.equal(exportPhotoUrl("https://x/api", "/api/chat/media/../../etc/passwd", now)?.includes(".."), false);
  assert.equal(exportPhotoUrl("https://x/api", "", now), null);
});
