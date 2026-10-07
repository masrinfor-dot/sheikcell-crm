import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  describeAttachment, friendlySendError, instagramMediaKind, parseInstagramWebhook,
  signMediaPath, verifyInstagramSignature, verifyMediaSignature,
} from "./instagram";

test("instagram: lê mensagem recebida, eco e ignora o que não é mensagem", () => {
  const events = parseInstagramWebhook({
    object: "instagram",
    entry: [{
      id: "17840000000000001",
      messaging: [
        { sender: { id: "999" }, recipient: { id: "17840000000000001" }, timestamp: 1, message: { mid: "m1", text: "Oi, tem iPhone 13?" } },
        { sender: { id: "17840000000000001" }, recipient: { id: "999" }, timestamp: 2, message: { mid: "m2", text: "Temos!", is_echo: true } },
        { sender: { id: "999" }, recipient: { id: "17840000000000001" }, read: { mid: "m2" } },
      ],
    }],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.accountId, "17840000000000001");
  assert.equal(events[0]!.senderId, "999");
  assert.equal(events[0]!.text, "Oi, tem iPhone 13?");
  assert.equal(events[0]!.isEcho, false);
  assert.equal(events[1]!.isEcho, true);
  assert.deepEqual(parseInstagramWebhook({ object: "page", entry: [] }), []);
  assert.deepEqual(parseInstagramWebhook(null), []);
});

test("instagram: assinatura X-Hub-Signature-256", () => {
  const body = Buffer.from('{"object":"instagram"}');
  const secret = "0123456789abcdef0123456789abcdef";
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyInstagramSignature(body, good, secret), true);
  assert.equal(verifyInstagramSignature(body, good, "outro-segredo"), false);
  assert.equal(verifyInstagramSignature(body, undefined, secret), false);
  assert.equal(verifyInstagramSignature(undefined, good, secret), false);
});

test("instagram: link de mídia assinado vence e não serve pra outro arquivo", () => {
  const now = 1_700_000_000_000;
  const { exp, sig } = signMediaPath("a.jpg", now, 60_000);
  assert.equal(verifyMediaSignature("a.jpg", exp, sig, now + 1000), true);
  assert.equal(verifyMediaSignature("b.jpg", exp, sig, now + 1000), false);
  assert.equal(verifyMediaSignature("a.jpg", exp, sig, now + 120_000), false);
  assert.equal(verifyMediaSignature("a.jpg", exp, "x", now), false);
});

test("instagram: tipos de anexo e erros amigáveis", () => {
  assert.equal(describeAttachment({ type: "image" }).msgType, "image");
  assert.equal(describeAttachment({ type: "file" }).msgType, "doc");
  assert.equal(describeAttachment({ type: "story_mention" }).msgType, "text");
  assert.equal(instagramMediaKind("doc"), "file");
  assert.match(friendlySendError({ error: { code: 10, error_subcode: 2534022 } }), /24h/);
  assert.match(friendlySendError({ error: { code: 190 } }), /Token/);
  assert.equal(friendlySendError({ error: { message: "boom" } }), "boom");
});
