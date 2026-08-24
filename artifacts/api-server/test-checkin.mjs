#!/usr/bin/env node
// Testa o check-in de ponto via WhatsApp (tryConsumePontoCheckIn em
// src/lib/whatsappInbound.ts) simulando diretamente o POST que o bridge
// Baileys faria em produção — não envia nenhuma mensagem real de WhatsApp,
// só chama o webhook com o mesmo payload/assinatura que ele usaria.
//
// Uso:
//   SESSION_SECRET=xxx SESSION_KEY=t3-vendas PHONE=5511900000001 \
//     node artifacts/api-server/test-checkin.mjs
//
// Variáveis de ambiente:
//   SESSION_SECRET  (obrigatória) - o mesmo valor de produção usado pra
//                   assinar o segredo da ponte (nunca commitar/colar aqui).
//   SESSION_KEY     (obrigatória) - sessionKey configurada como linha
//                   oficial de ponto do tenant (tenants.pontoCheckInSessionKey).
//                   Veja GET /api/rh-dp/settings logado como admin.
//   PHONE           (obrigatória) - telefone (só dígitos, com DDI 55) do
//                   colaborador de TESTE cadastrado em employeesTable.
//   CRM_BASE_URL    (opcional) - default https://crm.sheikcell.com.br
//   IMAGE_PATH      (opcional) - caminho de uma foto real (jpg/png) pra usar
//                   como comprovante. Sem isso, gera um PNG 1x1 sintético.

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SESSION_SECRET = process.env["SESSION_SECRET"];
const SESSION_KEY = process.env["SESSION_KEY"];
const PHONE = process.env["PHONE"];
const BASE_URL = process.env["CRM_BASE_URL"] ?? "https://crm.sheikcell.com.br";
const IMAGE_PATH = process.env["IMAGE_PATH"];

const missing = ["SESSION_SECRET", "SESSION_KEY", "PHONE"].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Faltam variáveis de ambiente: ${missing.join(", ")}`);
  console.error("Veja o cabeçalho deste arquivo para o que cada uma significa.");
  process.exit(1);
}

// PNG 1x1 vermelho válido — só usado se IMAGE_PATH não for passado.
const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function loadImage() {
  if (!IMAGE_PATH) {
    return { base64: FALLBACK_PNG_BASE64, mime: "image/png" };
  }
  const buf = await readFile(IMAGE_PATH);
  const ext = path.extname(IMAGE_PATH).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { base64: buf.toString("base64"), mime };
}

function bridgeSecret(secret) {
  return createHmac("sha256", secret).update("whatsapp-bridge-v1").digest("hex");
}

async function main() {
  const { base64, mime } = await loadImage();
  const remoteJid = `${PHONE}@s.whatsapp.net`;

  const body = {
    sessionKey: SESSION_KEY,
    isGroupMsg: false,
    data: {
      key: { remoteJid, id: `PONTOTEST-${Date.now()}`, fromMe: false },
      pushName: "Teste Ponto WhatsApp",
      mediaType: "image",
      mediaMimeType: mime,
      mediaBase64: base64,
    },
  };

  const url = `${BASE_URL}/api/chat/webhook/whatsapp`;
  console.log(`POST ${url}`);
  console.log(`sessionKey=${SESSION_KEY} phone=${PHONE} mediaMimeType=${mime} (${Math.round(base64.length / 1024)}KB base64)`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": bridgeSecret(SESSION_SECRET),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log(`\nHTTP ${res.status}`);
  console.log(text);

  if (res.status === 401) {
    console.error(
      "\n401 Unauthorized: ou SESSION_SECRET está errado, ou META_WHATSAPP_WEBHOOK_SECRET está " +
      "configurado em produção (nesse caso o webhook exige assinatura Meta, não o segredo da ponte, " +
      "e este script não serve pra testar esse caminho).",
    );
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error("\nResposta inesperada — veja o corpo acima.");
    process.exit(1);
  }

  console.log(
    "\nWebhook aceitou a mensagem (ok:true). Isso só confirma que a mensagem foi PROCESSADA, não que " +
    "virou check-in de ponto — o webhook responde ok:true mesmo se a foto virar uma mensagem de chat " +
    "normal (ex.: sessionKey não é a linha oficial de ponto, ou telefone não bate com nenhum " +
    "colaborador ativo). Confira na tela RH-DP > Ponto (colaborador de teste, dia de hoje) se apareceu " +
    "uma batida nova com fonte 'whatsapp' e a foto como comprovante.",
  );
}

main().catch((err) => {
  console.error("Falha ao rodar o teste:", err);
  process.exit(1);
});
