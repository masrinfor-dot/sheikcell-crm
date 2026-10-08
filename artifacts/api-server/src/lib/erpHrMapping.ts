import type { employeesTable } from "@workspace/db";

// RH com o ERP Prumo (07/10/2026): formatos puros (sem banco) do que o CRM
// manda ao ERP — testáveis sem DATABASE_URL.

type Employee = typeof employeesTable.$inferSelect;
type Leave = { kind: string; startDate: string; endDate: string };

/** Colaborador do CRM no formato da importação inicial do ERP. */
export function employeeForErp(e: Employee, storeName: string | null) {
  return {
    crmEmployeeId: String(e.id),
    name: e.name,
    cpf: e.cpf ?? null,
    phone: e.phone ?? null,
    email: e.email ?? null,
    storeName,
    jobTitle: e.role ?? null,
    jobFunction: e.jobFunction ?? null,
    contractType: e.contractType ?? null,
    salaryCents: e.salaryCents ?? null,
    admissionDate: e.admissionDate ?? null,
    isActive: e.isActive,
  };
}

/** Dias de falta injustificada e de afastamento (férias, atestado, justificada) dentro do mês. */
export function leaveDaysInMonth(leaves: Leave[], periodMonth: string): { absenceDays: number; leaveDays: number } {
  const [y, m] = periodMonth.split("-").map(Number);
  const first = Date.UTC(y!, m! - 1, 1);
  const last = Date.UTC(y!, m!, 0);
  const DAY = 86_400_000;
  let absenceDays = 0;
  let leaveDays = 0;
  for (const l of leaves) {
    const from = Math.max(Date.parse(`${l.startDate}T00:00:00Z`), first);
    const to = Math.min(Date.parse(`${l.endDate}T00:00:00Z`), last);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) continue;
    const days = Math.round((to - from) / DAY) + 1;
    if (l.kind === "falta_injustificada") absenceDays += days;
    else leaveDays += days;
  }
  return { absenceDays, leaveDays };
}

/** O que continua aqui depois da mudança: bater o ponto e ler. */
export function isAllowedAfterMove(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (/^\/rh-dp\/me\/punch\b/.test(path)) return true;
  if (/^\/rh\/moved\b/.test(path)) return true;
  return false;
}
