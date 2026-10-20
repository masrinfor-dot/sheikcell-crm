import { req } from "./api";

// Vendas que vieram do atendimento (19/10/2026): envio dos atendimentos ao
// ERP Prumo, vendas do ERP por atendente (Financeiro) e compras do cliente
// (ficha da conversa).
export type ErpSalesSyncStatus = {
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  sentCount: number;
  cursorAt: string | null;
  attendantsSyncedAt: string | null;
};

export type ErpSalesRow = {
  vendedorId: number | null;
  nome: string;
  loja: string | null;
  ativo: boolean;
  vendas: number;
  total: number;
  automaticas: number;
  marcadas: number;
};

export type ErpSalesSummary = {
  configured: boolean;
  error: string | null;
  rows: ErpSalesRow[];
  totals: { vendas: number; total: number };
};

export type ErpPurchase = {
  number: string;
  completedAt: string | null;
  total: number;
  storeName: string;
  items: string[];
  attendantName: string | null;
};

export const erpSalesApi = {
  status: () => req<ErpSalesSyncStatus>("/settings/erp/sales"),
  setEnabled: (enabled: boolean) =>
    req<ErpSalesSyncStatus>("/settings/erp/sales", { method: "PATCH", body: JSON.stringify({ enabled }) }),
  runNow: () =>
    req<{ result: { sent: number; scanned: number; error: string | null }; status: ErpSalesSyncStatus }>(
      "/settings/erp/sales/run", { method: "POST" }),
  summary: (days: number, store?: string | null) =>
    req<ErpSalesSummary>(`/finance/erp-sales?days=${days}${store ? `&store=${encodeURIComponent(store)}` : ""}`),
  purchases: (conversationId: number) =>
    req<{ available: boolean; customerName: string | null; sales: ErpPurchase[] }>(
      `/chat/conversations/${conversationId}/erp-purchases`),
};
