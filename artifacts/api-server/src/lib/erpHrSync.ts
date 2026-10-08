import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  db,
  employeesTable,
  employeeDocumentsTable,
  leaveRecordsTable,
  storesTable,
  tenantErpIntegrationsTable,
  timeBankClosuresTable,
  timeClockEntriesTable,
  timeClockEntryEditsTable,
} from "@workspace/db";
import { sendHistory } from "./erpHrHistory";
import { decryptErpSecret } from "./erpCrypto";
import { erpUrl } from "./erpOsMessages";
import { normalizePhone } from "./phone";
import { logger } from "./logger";
import { DOCS_DIR } from "../routes/documents";
import { employeeForErp, leaveDaysInMonth } from "./erpHrMapping";

// RH com o ERP Prumo (07/10/2026). O ERP é o DONO de todo o cadastro dos
// colaboradores (salário, documentos, banco de dados). O CRM só:
//   1. manda as batidas de ponto feitas pelo WhatsApp;
//   2. manda o fechamento do mês (banco de horas + faltas/afastamentos);
//   3. manda os documentos da contratação que recolhe (link do candidato);
//   4. uma vez só, a importação inicial de quem já está cadastrado aqui.
// E recebe do ERP a lista de quem bate ponto (nome, telefone, loja, ativo),
// espelhando aqui — o CRM nunca altera o cadastro no ERP. Como nas mensagens
// das OS, o ERP nunca chama o CRM: se um lado cair, o cursor espera.

const FETCH_TIMEOUT_MS = 30_000;
const PUNCH_BATCH = 500;
const CLOSURE_BATCH = 200;
const DOCUMENT_BATCH = 10;
const MAX_DOC_BYTES = 15 * 1024 * 1024;
const EMPLOYEE_DOCS_DIR = path.join(DOCS_DIR, "colaboradores");

export async function erpCall<T>(baseUrl: string, apiKey: string, pathName: string, init?: RequestInit): Promise<T> {
  const res = await fetch(erpUrl(baseUrl, pathName), {
    ...init,
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ERP respondeu ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export const post = <T>(baseUrl: string, apiKey: string, pathName: string, body: unknown) =>
  erpCall<T>(baseUrl, apiKey, pathName, { method: "POST", body: JSON.stringify(body) });

const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");

interface ErpEmployee {
  erpEmployeeId: string;
  crmEmployeeId: string | null;
  name: string;
  cpf: string | null;
  phone: string | null;
  email: string | null;
  storeName: string | null;
  jobTitle: string | null;
  isActive: boolean;
  updatedAt: string;
}

let running = false;

export async function runErpHrSync(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await db.select().from(tenantErpIntegrationsTable)
      .where(eq(tenantErpIntegrationsTable.hrSyncEnabled, true));
    for (const row of rows) {
      let apiKey: string;
      try {
        apiKey = decryptErpSecret({ ciphertext: row.encryptedApiKey, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion });
      } catch {
        await setState(row.tenantId, { hrLastError: "Não foi possível ler a chave do ERP (cofre)." });
        continue;
      }
      try {
        await syncTenant(row, apiKey);
        await setState(row.tenantId, { hrLastError: null, hrLastSyncAt: new Date() });
      } catch (err) {
        logger.warn({ err, tenantId: row.tenantId }, "ERP RH: sincronização falhou");
        await setState(row.tenantId, {
          hrLastError: String(err instanceof Error ? err.message : err).slice(0, 300),
          hrLastSyncAt: new Date(),
        });
      }
    }
  } finally {
    running = false;
  }
}

async function setState(tenantId: number, data: Partial<typeof tenantErpIntegrationsTable.$inferInsert>) {
  await db.update(tenantErpIntegrationsTable).set(data).where(eq(tenantErpIntegrationsTable.tenantId, tenantId));
}

async function syncTenant(row: typeof tenantErpIntegrationsTable.$inferSelect, apiKey: string) {
  const { tenantId, baseUrl } = row;
  const stores = await db.select({ id: storesTable.id, name: storesTable.name }).from(storesTable)
    .where(eq(storesTable.tenantId, tenantId));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  // 1) Importação inicial (uma vez): quem já está no CRM vai para o ERP.
  if (!row.hrImportedAt) {
    const all = await db.select().from(employeesTable).where(eq(employeesTable.tenantId, tenantId));
    for (let i = 0; i < all.length; i += 200) {
      await post(baseUrl, apiKey, "/integrations/hr/employees", {
        items: all.slice(i, i + 200).map((e) => employeeForErp(e, e.storeId ? storeName.get(e.storeId) ?? null : null)),
      });
    }
    await setState(tenantId, { hrImportedAt: new Date() });
  }

  // 2) O ERP manda: quem bate ponto. Espelha aqui (o ERP é o dono).
  const pulledAt = new Date();
  const since = row.hrLastPullAt ? `?since=${encodeURIComponent(row.hrLastPullAt.toISOString())}` : "";
  const fromErp = await erpCall<{ items: ErpEmployee[] }>(baseUrl, apiKey, `/integrations/hr/employees${since}`);
  const links: { erpEmployeeId: string; crmEmployeeId: string }[] = [];
  for (const e of fromErp.items) {
    const storeId = e.storeName ? stores.find((s) => norm(s.name) === norm(e.storeName))?.id ?? null : null;
    const mirror = {
      name: e.name,
      phone: e.phone ? normalizePhone(e.phone) || e.phone : null,
      email: e.email,
      cpf: e.cpf,
      role: e.jobTitle,
      isActive: e.isActive,
      ...(storeId ? { storeId } : {}),
    };
    const crmId = e.crmEmployeeId ? Number(e.crmEmployeeId) : null;
    if (crmId) {
      await db.update(employeesTable).set(mirror)
        .where(and(eq(employeesTable.tenantId, tenantId), eq(employeesTable.id, crmId)));
      continue;
    }
    // Novo no ERP: acha pelo CPF ou cria aqui para poder bater o ponto.
    const cpfDigits = (e.cpf ?? "").replace(/\D/g, "");
    const [byCpf] = cpfDigits
      ? (await db.select({ id: employeesTable.id, cpf: employeesTable.cpf }).from(employeesTable)
          .where(eq(employeesTable.tenantId, tenantId)))
          .filter((x) => (x.cpf ?? "").replace(/\D/g, "") === cpfDigits)
      : [];
    let id = byCpf?.id;
    if (id) {
      await db.update(employeesTable).set(mirror).where(eq(employeesTable.id, id));
    } else {
      const [created] = await db.insert(employeesTable).values({ tenantId, ...mirror }).returning({ id: employeesTable.id });
      id = created!.id;
    }
    links.push({ erpEmployeeId: e.erpEmployeeId, crmEmployeeId: String(id) });
  }
  if (links.length) await post(baseUrl, apiKey, "/integrations/hr/employees/link", { items: links });
  // O ERP devolve no máximo 500 por vez: com página cheia, continua de onde parou.
  const last = fromErp.items[fromErp.items.length - 1];
  await setState(tenantId, {
    hrLastPullAt: fromErp.items.length >= 500 && last ? new Date(last.updatedAt) : pulledAt,
  });

  // 3) Batidas de ponto (WhatsApp / app), em ordem de id.
  let punchCursor = row.hrLastPunchId;
  for (;;) {
    const batch = await db.select({
      id: timeClockEntriesTable.id,
      employeeId: timeClockEntriesTable.employeeId,
      kind: timeClockEntriesTable.kind,
      at: timeClockEntriesTable.at,
      source: timeClockEntriesTable.source,
    }).from(timeClockEntriesTable)
      .where(and(eq(timeClockEntriesTable.tenantId, tenantId), gt(timeClockEntriesTable.id, punchCursor)))
      .orderBy(asc(timeClockEntriesTable.id)).limit(PUNCH_BATCH);
    if (batch.length === 0) break;
    const res = await post<{ missing: string[] }>(baseUrl, apiKey, "/integrations/hr/punches", {
      items: batch.map((p) => ({
        crmEntryId: String(p.id),
        crmEmployeeId: String(p.employeeId),
        kind: p.kind,
        at: p.at.toISOString(),
        source: p.source,
      })),
    });
    if (res.missing?.length) {
      logger.warn({ tenantId, missing: res.missing.length }, "ERP RH: batidas de colaborador que não está no ERP");
    }
    punchCursor = batch[batch.length - 1]!.id;
    await setState(tenantId, { hrLastPunchId: punchCursor });
    if (batch.length < PUNCH_BATCH) break;
  }

  // 3b) Batidas corrigidas ou apagadas aqui (histórico de edições): o ERP
  // atualiza a mesma batida ou apaga.
  const edits = await db.select().from(timeClockEntryEditsTable)
    .where(and(eq(timeClockEntryEditsTable.tenantId, tenantId), gt(timeClockEntryEditsTable.id, row.hrLastEditId)))
    .orderBy(asc(timeClockEntryEditsTable.id)).limit(PUNCH_BATCH);
  if (edits.length) {
    const deleted = edits.filter((e) => e.action === "delete" && e.entryId != null).map((e) => String(e.entryId));
    const editedIds = [...new Set(edits.filter((e) => e.action === "edit" && e.entryId != null).map((e) => e.entryId!))];
    if (deleted.length) await post(baseUrl, apiKey, "/integrations/hr/punches/delete", { crmEntryIds: deleted });
    if (editedIds.length) {
      const current = await db.select().from(timeClockEntriesTable)
        .where(and(eq(timeClockEntriesTable.tenantId, tenantId), inArray(timeClockEntriesTable.id, editedIds)));
      if (current.length)
        await post(baseUrl, apiKey, "/integrations/hr/punches", {
          items: current.map((p) => ({ crmEntryId: String(p.id), crmEmployeeId: String(p.employeeId), kind: p.kind, at: p.at.toISOString(), source: p.source })),
        });
    }
    await setState(tenantId, { hrLastEditId: edits[edits.length - 1]!.id });
  }

  // 4) Fechamento do mês (snapshot congelado do banco de horas + faltas).
  const closures = await db.select().from(timeBankClosuresTable)
    .where(and(eq(timeBankClosuresTable.tenantId, tenantId), gt(timeBankClosuresTable.id, row.hrLastClosureId)))
    .orderBy(asc(timeBankClosuresTable.id)).limit(CLOSURE_BATCH);
  if (closures.length) {
    const leaves = await db.select({
      employeeId: leaveRecordsTable.employeeId,
      kind: leaveRecordsTable.kind,
      startDate: leaveRecordsTable.startDate,
      endDate: leaveRecordsTable.endDate,
    }).from(leaveRecordsTable).where(eq(leaveRecordsTable.tenantId, tenantId));
    await post(baseUrl, apiKey, "/integrations/hr/timesheets", {
      items: closures.map((c) => ({
        crmEmployeeId: String(c.employeeId),
        period: c.periodMonth,
        workedMinutes: Math.max(0, c.workedMinutes),
        expectedMinutes: Math.max(0, c.expectedMinutes),
        balanceMinutes: c.balanceMinutes,
        ...leaveDaysInMonth(leaves.filter((l) => l.employeeId === c.employeeId), c.periodMonth),
      })),
    });
    await setState(tenantId, { hrLastClosureId: closures[closures.length - 1]!.id });
  }

  // 5) Documentos da contratação recolhidos aqui → cadastro no ERP (arquivo
  // ou texto, como o contrato gerado).
  const docs = await db.select().from(employeeDocumentsTable)
    .where(and(eq(employeeDocumentsTable.tenantId, tenantId), gt(employeeDocumentsTable.id, row.hrLastDocumentId)))
    .orderBy(asc(employeeDocumentsTable.id)).limit(DOCUMENT_BATCH);
  for (const d of docs) {
    try {
      const common = {
        crmEmployeeId: String(d.employeeId),
        crmDocumentId: String(d.id),
        docType: d.docType,
        description: d.label ?? undefined,
        expiresAt: d.expiresAt ?? undefined,
      };
      if (d.storedName) {
        const buf = await readFile(path.join(EMPLOYEE_DOCS_DIR, path.basename(d.storedName)));
        if (buf.length > 0 && buf.length <= MAX_DOC_BYTES)
          await post(baseUrl, apiKey, "/integrations/hr/documents", {
            ...common,
            fileName: d.fileName ?? `${d.docType}`,
            mimeType: d.mimeType ?? "application/octet-stream",
            dataBase64: buf.toString("base64"),
          });
      } else if (d.textContent?.trim()) {
        await post(baseUrl, apiKey, "/integrations/hr/documents", { ...common, textContent: d.textContent });
      }
    } catch (err) {
      // Arquivo sumiu do disco ou o ERP recusou o tipo: segue para o próximo.
      logger.warn({ err, documentId: d.id }, "ERP RH: documento não foi");
      if (String(err).includes("ERP respondeu 5")) throw err; // ERP fora: tenta de novo depois
    }
    await setState(tenantId, { hrLastDocumentId: d.id });
  }

  // 6) RH mudou para o ERP: manda o histórico todo, um tipo por vez.
  if (row.hrMovedToErp && !row.hrHistoryDoneAt) await sendHistory(row, apiKey);
}
