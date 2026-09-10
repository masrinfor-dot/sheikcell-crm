import { readFile } from "fs/promises";
import path from "path";
import { and, desc, eq } from "drizzle-orm";
import { db, employeeDocumentsTable, tenantsTable } from "@workspace/db";
import { DOCS_DIR } from "../routes/documents";
import { getOpenAiClientForTenant } from "./aiClient";
import { logger } from "./logger";

// Reconhecimento facial na batida de ponto (pedido 10/09, análise
// Tangerino) — opt-in por loja (tenants.facialRecognitionEnabled, default
// desligado: dado biométrico é sensível pela LGPD). Compara a selfie da
// batida de entrada contra a foto de referência do colaborador (documento
// "foto_3x4" já existente no banco de arquivos de RH) usando IA de visão.
//
// IMPORTANTE: isto é só um SINAL A MAIS pra revisão humana, igual ao que já
// existe hoje pra "duas fotos em pouco tempo" ou "sem foto disponível" — a
// batida NUNCA é bloqueada por causa disto, e qualquer falha (rede, IA
// indisponível, sem foto de referência cadastrada) é tratada como "sem
// sinal" (não marca nada), nunca como bloqueio. Decisão de mérito (advertir,
// descontar etc.) é sempre humana, no painel de ponto do RH.
const EMPLOYEE_DOCS_DIR = path.join(DOCS_DIR, "colaboradores");

export interface FaceCheckResult {
  match: boolean;
  reason: string;
}

async function loadReferencePhoto(employeeId: number, tenantId: number): Promise<{ base64: string; mimeType: string } | null> {
  const [doc] = await db.select().from(employeeDocumentsTable)
    .where(and(
      eq(employeeDocumentsTable.employeeId, employeeId),
      eq(employeeDocumentsTable.tenantId, tenantId),
      eq(employeeDocumentsTable.docType, "foto_3x4"),
    ))
    .orderBy(desc(employeeDocumentsTable.createdAt)).limit(1);
  if (!doc?.storedName || !doc.mimeType) return null;
  try {
    const buf = await readFile(path.join(EMPLOYEE_DOCS_DIR, path.basename(doc.storedName)));
    return { base64: buf.toString("base64"), mimeType: doc.mimeType };
  } catch {
    return null; // foto de referência sumiu do disco — trata como "sem referência", não como erro
  }
}

/**
 * Compara a selfie da batida (base64 + mimetype) contra a foto de
 * referência do colaborador, se a loja tiver a feature ligada e o
 * colaborador tiver uma foto 3x4 cadastrada. Retorna null quando não há
 * nada pra comparar (feature desligada, sem foto de referência) OU quando a
 * própria checagem falhar (nunca lança, nunca bloqueia a batida).
 */
export async function checkFaceMatch(
  employeeId: number, tenantId: number, selfieBase64: string, selfieMimeType: string,
): Promise<FaceCheckResult | null> {
  try {
    const [tenant] = await db.select({ facialRecognitionEnabled: tenantsTable.facialRecognitionEnabled })
      .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
    if (!tenant?.facialRecognitionEnabled) return null;

    const reference = await loadReferencePhoto(employeeId, tenantId);
    if (!reference) return null; // sem foto de referência cadastrada — nada pra comparar

    const client = await getOpenAiClientForTenant(tenantId);
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Estas duas fotos são da MESMA pessoa? A primeira é a foto de referência cadastrada, a segunda é uma selfie tirada agora na batida de ponto. Responda APENAS em JSON, sem markdown: {\"match\": true|false, \"reason\": \"motivo breve em português\"}. Se não conseguir ver um rosto claro em alguma das fotos, responda match:true (dê o benefício da dúvida — más condições de luz/ângulo não devem gerar falso alarme)." },
          { type: "image_url", image_url: { url: `data:${reference.mimeType};base64,${reference.base64}` } },
          { type: "image_url", image_url: { url: `data:${selfieMimeType};base64,${selfieBase64}` } },
        ],
      }],
    });
    const text = completion.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { match?: unknown; reason?: unknown };
    if (typeof parsed.match !== "boolean") return null;
    return { match: parsed.match, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "" };
  } catch (err) {
    logger.warn({ err, employeeId }, "Falha ao checar reconhecimento facial na batida de ponto — ignorando (nunca bloqueia)");
    return null;
  }
}
