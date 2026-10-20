// Gerente IA → ERP (linha ADM). O que o dono manda como boleto, conta ou
// comprovante vira um pedido na fila de aprovação do ERP (Financeiro ›
// Aprovações do agente — POST /agent/actions). NADA é lançado direto: o ERP
// guarda como PENDENTE e alguém aprova lá. Aqui fica só o espelho (painel e
// aviso no WhatsApp quando aprova/recusa).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, desc } from "drizzle-orm";
import { db, gerenteSettingsTable, gerenteErpActionsTable, type GerenteSettings } from "@workspace/db";
import { encryptErpSecret, decryptErpSecret } from "./erpCrypto";
import { resolveErpCredentials } from "./erpForward";
import { logger } from "./logger";
import { brl, fmtDateISO, spDateISO } from "./gerenteRules";

export type ErpActionType = "CREATE_PAYABLE" | "CREATE_RECEIVABLE" | "SETTLE_PAYABLE" | "SETTLE_RECEIVABLE";
const TYPE_LABEL: Record<ErpActionType, string> = {
  CREATE_PAYABLE: "Conta a pagar", CREATE_RECEIVABLE: "Conta a receber",
  SETTLE_PAYABLE: "Baixa de conta a pagar", SETTLE_RECEIVABLE: "Baixa de conta a receber",
};
const MAX_FILE_BYTES = 15 * 1024 * 1024;

// ─── Chave do agente ─────────────────────────────────────────────────────────

export async function saveAgentKey(tenantId: number, key: string | null): Promise<void> {
  if (!key) {
    await db.update(gerenteSettingsTable).set({ erpAgentKeyCiphertext: null, erpAgentKeyIv: null, erpAgentKeyAuthTag: null, erpAgentKeyVersion: null, updatedAt: new Date() })
      .where(eq(gerenteSettingsTable.tenantId, tenantId));
    return;
  }
  const enc = encryptErpSecret(key.trim());
  await db.update(gerenteSettingsTable).set({
    erpAgentKeyCiphertext: enc.ciphertext, erpAgentKeyIv: enc.iv, erpAgentKeyAuthTag: enc.authTag, erpAgentKeyVersion: enc.keyVersion, updatedAt: new Date(),
  }).where(eq(gerenteSettingsTable.tenantId, tenantId));
}

async function agentCreds(settings: GerenteSettings): Promise<{ baseUrl: string; key: string } | null> {
  if (!settings.erpAgentKeyCiphertext || !settings.erpAgentKeyIv || !settings.erpAgentKeyAuthTag) return null;
  const erp = await resolveErpCredentials(settings.tenantId);
  if (!erp) return null;
  try {
    const key = decryptErpSecret({ ciphertext: settings.erpAgentKeyCiphertext, iv: settings.erpAgentKeyIv, authTag: settings.erpAgentKeyAuthTag, keyVersion: settings.erpAgentKeyVersion ?? 1 });
    return { baseUrl: erp.baseUrl, key };
  } catch (err) {
    logger.warn({ err, tenantId: settings.tenantId }, "Gerente IA: chave do agente do ERP ilegível");
    return null;
  }
}

export async function erpAgentConfigured(settings: GerenteSettings): Promise<boolean> {
  return (await agentCreds(settings)) != null;
}

/** Testa a chave (GET /agent/ping). */
export async function pingAgent(settings: GerenteSettings): Promise<{ ok: boolean; message: string }> {
  const creds = await agentCreds(settings);
  if (!creds) return { ok: false, message: "Falta a chave do agente ou a integração com o ERP (Administração › Integrações)." };
  try {
    const r = await fetch(`${creds.baseUrl}/agent/ping`, { headers: { Authorization: `Bearer ${creds.key}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { actingUser?: { name?: string }; allowedActions?: string[]; message?: string };
    if (!r.ok) return { ok: false, message: j.message ?? `ERP respondeu ${r.status}` };
    return { ok: true, message: `Conectado. Lança como ${j.actingUser?.name ?? "usuário da chave"}; pode: ${(j.allowedActions ?? []).join(", ") || "—"}.` };
  } catch (err) {
    return { ok: false, message: `Não consegui falar com o ERP: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Leitura do documento (boleto / comprovante) ────────────────────────────

export type DocReading = {
  tipo: "boleto" | "comprovante" | "nota" | "outro";
  descricao: string | null;
  valor: number | null;
  vencimento: string | null;
  data_pagamento: string | null;
  linha_digitavel: string | null;
  beneficiario: string | null;
  beneficiario_documento: string | null;
  pagador: string | null;
  observacao: string | null;
};

const MIME_BY_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };

export async function loadMedia(mediaUrl: string): Promise<{ buf: Buffer; mime: string; fileName: string } | null> {
  const { MEDIA_DIR } = await import("./whatsappInbound");
  const fileName = path.basename(mediaUrl);
  if (!/^[a-zA-Z0-9._-]{5,120}$/.test(fileName)) return null;
  const ext = fileName.split(".").pop()!.toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;
  const buf = await readFile(path.join(MEDIA_DIR, fileName));
  if (buf.length > MAX_FILE_BYTES) return null;
  return { buf, mime, fileName };
}

export async function readFinancialDoc(tenantId: number, media: { buf: Buffer; mime: string; fileName: string }, caption: string): Promise<DocReading | null> {
  const { getOpenAiClientForTenant } = await import("./aiClient");
  const openai = await getOpenAiClientForTenant(tenantId);
  const dataUrl = `data:${media.mime};base64,${media.buf.toString("base64")}`;
  const filePart = media.mime === "application/pdf"
    ? ({ type: "file", file: { filename: media.fileName, file_data: dataUrl } } as const)
    : ({ type: "image_url", image_url: { url: dataUrl } } as const);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 500, response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Você lê documentos financeiros brasileiros enviados por WhatsApp (boleto, fatura, comprovante de pagamento Pix/TED/boleto, nota). Hoje é ${spDateISO()}. Devolva SÓ um JSON: {"tipo":"boleto|comprovante|nota|outro","descricao":"o que é, curto (ex.: Energia Cemig out/26)","valor":número em reais ou null,"vencimento":"YYYY-MM-DD" ou null,"data_pagamento":"YYYY-MM-DD" ou null,"linha_digitavel":"só dígitos" ou null,"beneficiario":"quem recebe" ou null,"beneficiario_documento":"CPF/CNPJ só dígitos" ou null,"pagador":"quem paga" ou null,"observacao":"algo importante" ou null}. Não invente: campo ilegível = null.`,
      },
      { role: "user", content: [{ type: "text", text: caption ? `Mensagem junto: ${caption}` : "Leia o documento." }, filePart] as never },
    ],
  });
  try {
    const j = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Partial<DocReading>;
    const iso = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
    return {
      tipo: (["boleto", "comprovante", "nota", "outro"] as const).includes(j.tipo as never) ? (j.tipo as DocReading["tipo"]) : "outro",
      descricao: str(j.descricao), valor: typeof j.valor === "number" && j.valor > 0 ? Math.round(j.valor * 100) / 100 : null,
      vencimento: iso(j.vencimento), data_pagamento: iso(j.data_pagamento),
      linha_digitavel: typeof j.linha_digitavel === "string" ? j.linha_digitavel.replace(/\D/g, "").slice(0, 60) || null : null,
      beneficiario: str(j.beneficiario, 120), beneficiario_documento: typeof j.beneficiario_documento === "string" ? j.beneficiario_documento.replace(/\D/g, "").slice(0, 14) || null : null,
      pagador: str(j.pagador, 120), observacao: str(j.observacao, 300),
    };
  } catch {
    return null;
  }
}

// ─── Envio à fila do ERP ─────────────────────────────────────────────────────

export type ErpActionInput = {
  type: ErpActionType;
  payload: Record<string, unknown>;
  summary: string;
  senderPhone: string;
  messageText: string;
  attachment?: { buf: Buffer; mime: string; fileName: string } | null;
  sourceMessageId?: number;
};

async function postAction(creds: { baseUrl: string; key: string }, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${creds.baseUrl}/agent/actions`, {
    method: "POST", headers: { Authorization: `Bearer ${creds.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, json };
}

/**
 * Manda o pedido pra fila de aprovação do ERP. Se o ERP não achar a pessoa
 * (beneficiário ainda não cadastrado), manda de novo sem a pessoa e com o
 * nome nas observações — o financeiro vincula ao aprovar.
 */
export async function submitErpAction(settings: GerenteSettings, input: ErpActionInput): Promise<string> {
  const creds = await agentCreds(settings);
  const label = TYPE_LABEL[input.type];
  const [row] = await db.insert(gerenteErpActionsTable).values({
    tenantId: settings.tenantId, type: input.type, summary: input.summary.slice(0, 500), payload: input.payload,
    status: creds ? "PENDENTE" : "FALHA_ENVIO", sourceMessageId: input.sourceMessageId ?? null,
    message: creds ? null : "ERP não configurado no Gerente IA",
  }).returning();
  if (!creds) return `⚠️ Entendi (${label}: ${input.summary}), mas o Gerente IA ainda não está ligado ao ERP. Cole a chave do agente em Gerente IA → Configurações → ERP.`;

  const attachments = input.attachment ? [{ fileName: input.attachment.fileName, mimeType: input.attachment.mime, dataBase64: input.attachment.buf.toString("base64") }] : undefined;
  const base = { type: input.type, summary: input.summary.slice(0, 500), senderPhone: input.senderPhone, senderName: "SAMUEL", messageText: input.messageText.slice(0, 4000), attachments };
  try {
    let res = await postAction(creds, { ...base, payload: input.payload });
    const errText = String(res.json["message"] ?? "");
    if (!res.ok && res.status < 500 && /pessoa/i.test(errText) && ("personName" in input.payload || "personDocument" in input.payload)) {
      const { personName, personDocument, ...rest } = input.payload as Record<string, unknown> & { personName?: string; personDocument?: string };
      const notes = [rest["notes"], personName ? `Beneficiário: ${personName}${personDocument ? ` (${personDocument})` : ""} — não cadastrado no ERP` : null].filter(Boolean).join(" · ");
      res = await postAction(creds, { ...base, payload: { ...rest, notes } });
    }
    if (!res.ok) {
      const msg = String(res.json["message"] ?? `ERP respondeu ${res.status}`).slice(0, 500);
      await db.update(gerenteErpActionsTable).set({ status: "FALHA_ENVIO", message: msg, updatedAt: new Date() }).where(eq(gerenteErpActionsTable.id, row!.id));
      return `⚠️ O ERP não aceitou (${label}): ${msg}`;
    }
    const erpId = String(res.json["id"] ?? "");
    const status = String(res.json["status"] ?? "PENDENTE");
    await db.update(gerenteErpActionsTable).set({ erpActionId: erpId || null, status, message: String(res.json["message"] ?? ""), notifiedStatus: status, updatedAt: new Date() })
      .where(eq(gerenteErpActionsTable.id, row!.id));
    return `🧾 *${label}* enviada pro ERP — *aguardando aprovação*\n${input.summary}\nAprovar em: ERP › Financeiro › Aprovações do agente. Te aviso quando aprovarem.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(gerenteErpActionsTable).set({ status: "FALHA_ENVIO", message: msg.slice(0, 500), updatedAt: new Date() }).where(eq(gerenteErpActionsTable.id, row!.id));
    return `⚠️ Não consegui falar com o ERP agora (${label}). Ficou registrado no painel pra reenviar.`;
  }
}

/** Reenvia um pedido que falhou (botão no painel). */
export async function resendErpAction(settings: GerenteSettings, id: number): Promise<string> {
  const [row] = await db.select().from(gerenteErpActionsTable)
    .where(and(eq(gerenteErpActionsTable.id, id), eq(gerenteErpActionsTable.tenantId, settings.tenantId))).limit(1);
  if (!row || row.status !== "FALHA_ENVIO") return "Nada pra reenviar.";
  await db.delete(gerenteErpActionsTable).where(eq(gerenteErpActionsTable.id, row.id));
  return submitErpAction(settings, {
    type: row.type as ErpActionType, payload: (row.payload ?? {}) as Record<string, unknown>, summary: row.summary,
    senderPhone: settings.lastPhone ?? settings.authorizedPhones[0] ?? "", messageText: row.summary,
  });
}

// ─── Montagem do pedido ──────────────────────────────────────────────────────

/** Documento lido → pedido do ERP (ou null se não der pra montar). */
export function actionFromDoc(doc: DocReading, caption: string): { type: ErpActionType; payload: Record<string, unknown>; summary: string; missing: string[] } | null {
  const c = caption.toLowerCase();
  const isReceive = /\breceber\b|\brecebi\b|\bcliente pagou\b/.test(c);
  if (doc.tipo === "comprovante") {
    const missing = doc.valor ? [] : ["valor"];
    const payload: Record<string, unknown> = {
      ...(doc.beneficiario ? { personName: doc.beneficiario } : {}),
      ...(doc.valor ? { amount: doc.valor, amountPaid: doc.valor } : {}),
      ...(doc.descricao ? { description: doc.descricao } : {}),
      paidAt: doc.data_pagamento ?? spDateISO(),
      notes: [doc.observacao, caption].filter(Boolean).join(" · ") || undefined,
    };
    const type: ErpActionType = isReceive ? "SETTLE_RECEIVABLE" : "SETTLE_PAYABLE";
    return { type, payload, summary: `${doc.descricao ?? "Pagamento"}${doc.beneficiario ? ` · ${doc.beneficiario}` : ""}${doc.valor ? ` · ${brl(Math.round(doc.valor * 100))}` : ""} · pago ${fmtDateISO(doc.data_pagamento ?? spDateISO())}`, missing };
  }
  if (doc.tipo === "boleto" || doc.tipo === "nota") {
    const missing = [!doc.valor && "valor", !doc.vencimento && "vencimento"].filter(Boolean) as string[];
    const description = (doc.descricao ?? (doc.beneficiario ? `Boleto ${doc.beneficiario}` : "Boleto")).slice(0, 200);
    const payload: Record<string, unknown> = {
      description, totalAmount: doc.valor ?? undefined, dueDate: doc.vencimento ?? undefined,
      documentNumber: doc.linha_digitavel ?? undefined, paymentKind: "BOLETO",
      ...(doc.beneficiario ? { personName: doc.beneficiario } : {}),
      ...(doc.beneficiario_documento ? { personDocument: doc.beneficiario_documento } : {}),
      notes: [doc.observacao, caption, doc.linha_digitavel ? `Linha digitável: ${doc.linha_digitavel}` : null].filter(Boolean).join(" · ") || undefined,
    };
    const type: ErpActionType = isReceive ? "CREATE_RECEIVABLE" : "CREATE_PAYABLE";
    return { type, payload, summary: `${description}${doc.beneficiario ? ` · ${doc.beneficiario}` : ""}${doc.valor ? ` · ${brl(Math.round(doc.valor * 100))}` : ""}${doc.vencimento ? ` · vence ${fmtDateISO(doc.vencimento)}` : ""}`, missing };
  }
  return null;
}

// ─── Acompanhamento (job) ────────────────────────────────────────────────────

/** Consulta no ERP os pedidos ainda pendentes e avisa o dono quando mudam. */
export async function pollErpActions(settings: GerenteSettings, notify: (text: string) => Promise<boolean>): Promise<number> {
  const creds = await agentCreds(settings);
  if (!creds) return 0;
  const open = await db.select().from(gerenteErpActionsTable).where(and(
    eq(gerenteErpActionsTable.tenantId, settings.tenantId), inArray(gerenteErpActionsTable.status, ["PENDENTE"]),
  )).orderBy(desc(gerenteErpActionsTable.id)).limit(30);
  let changed = 0;
  for (const a of open) {
    if (!a.erpActionId) continue;
    try {
      const r = await fetch(`${creds.baseUrl}/agent/actions/${a.erpActionId}`, { headers: { Authorization: `Bearer ${creds.key}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { status?: string; message?: string };
      if (!j.status || j.status === a.status) continue;
      await db.update(gerenteErpActionsTable).set({ status: j.status, message: j.message ?? null, updatedAt: new Date() }).where(eq(gerenteErpActionsTable.id, a.id));
      if (a.notifiedStatus !== j.status) {
        const icon = j.status === "APROVADA" ? "✅" : j.status === "RECUSADA" ? "❌" : "⚠️";
        if (await notify(`${icon} *ERP — ${TYPE_LABEL[a.type as ErpActionType] ?? a.type}:* ${a.summary}\n${j.message ?? j.status}`)) {
          await db.update(gerenteErpActionsTable).set({ notifiedStatus: j.status }).where(eq(gerenteErpActionsTable.id, a.id));
        }
      }
      changed++;
    } catch (err) {
      logger.warn({ err, id: a.id }, "Gerente IA: falha ao consultar ação no ERP");
    }
  }
  return changed;
}
