import { req } from "./api";

// Pontuação do atendimento → gamificação do ERP e "Clientes esperando
// resposta" na TV das lojas do ERP (27/10/2026).
export type ErpGamificationEvent = {
  id: number;
  eventId: string;
  type: "CONVERSATION_FIRST_RESPONSE" | "CONVERSATION_CONVERTED" | "CONVERSATION_UNANSWERED_SLA";
  status: "pending" | "processing" | "sent" | "failed";
  erpStatus: string | null;
  erpPoints: number | null;
  erpMessage: string | null;
  lastError: string | null;
  attempts: number;
  occurredAt: string;
  sentAt: string | null;
  conversationId: number | null;
  agentName: string | null;
};

export type ErpGamificationStatus = {
  configured: boolean;
  enabled: boolean;
  since: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  queue: { pending: number; processing: number; sent: number; failed: number };
  erpLast30Days: Record<string, { count: number; points: number }>;
  recent: ErpGamificationEvent[];
  tv: { enabled: boolean; lastPushAt: string | null; lastError: string | null; links: number };
};

export type ErpStoreLinks = {
  crmStores: { id: number; name: string }[];
  lines: { ref: string; label: string }[];
  links: { kind: "store" | "line"; crmRef: string; erpStoreId: string; erpStoreName: string | null }[];
  erpStores: { id: string; code: string | null; name: string }[] | null;
  erpStoresError: string | null;
};

export const erpGamificationApi = {
  status: () => req<ErpGamificationStatus>("/settings/erp/gamification"),
  save: (data: { enabled?: boolean; tvEnabled?: boolean }) =>
    req<ErpGamificationStatus>("/settings/erp/gamification", { method: "PATCH", body: JSON.stringify(data) }),
  runNow: () =>
    req<{
      gamification: { enqueued: { firstResponse: number; sla: number; converted: number }; sent: number; applied: number; error: string | null; salesError: string | null };
      tv: { stores: number; waiting: number; error: string | null; skipped?: string };
      status: ErpGamificationStatus;
    }>("/settings/erp/gamification/run", { method: "POST", timeoutMs: 90_000 }),
  retry: () => req<{ requeued: number; status: ErpGamificationStatus }>("/settings/erp/gamification/retry", { method: "POST" }),
  storeLinks: () => req<ErpStoreLinks>("/settings/erp/store-links"),
  saveStoreLinks: (links: { kind: "store" | "line"; crmRef: string; erpStoreId: string | null }[]) =>
    req<ErpStoreLinks>("/settings/erp/store-links", { method: "PUT", body: JSON.stringify({ links }) }),
};

export const ERP_EVENT_TYPE_LABEL: Record<ErpGamificationEvent["type"], string> = {
  CONVERSATION_FIRST_RESPONSE: "1ª resposta",
  CONVERSATION_CONVERTED: "Virou venda",
  CONVERSATION_UNANSWERED_SLA: "Sem resposta no prazo",
};

export const ERP_RESULT_LABEL: Record<string, { label: string; cls: string; hint: string }> = {
  APLICADO: { label: "Pontuou", cls: "bg-emerald-100 text-emerald-800", hint: "O ERP deu (ou tirou) os pontos." },
  DUPLICADO: { label: "Já recebido", cls: "bg-muted text-muted-foreground", hint: "O ERP já tinha esse evento — não pontua de novo." },
  SEM_USUARIO: { label: "Atendente sem usuário no ERP", cls: "bg-amber-100 text-amber-900", hint: "Ligue o atendente a um usuário no ERP (ou use o mesmo e-mail). O ERP pontua depois, sozinho." },
  REGRA_DESLIGADA: { label: "Regra desligada no ERP", cls: "bg-amber-100 text-amber-900", hint: "Ligue a regra de Atendimento na configuração da gamificação do ERP. Ele pontua depois, sozinho." },
  FORA_DO_PRAZO: { label: "Fora do prazo", cls: "bg-muted text-muted-foreground", hint: "A resposta passou do prazo da regra do ERP — não pontua." },
  INVALIDO: { label: "Recusado", cls: "bg-red-100 text-red-800", hint: "O ERP recusou o evento (ex.: venda de outro cliente)." },
  IGNORADO: { label: "Ignorado", cls: "bg-muted text-muted-foreground", hint: "O ERP não usa esse evento." },
};
