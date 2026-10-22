import { useEffect } from "react";
import { api, ApiError } from "@/lib/api";
import { requestChatExpand } from "@/lib/chatWidgetBus";

/**
 * Abrir a conversa direto pelo link (22/10/2026, pedido do Samuel: "abrir
 * conversa no CRM direto" a partir da OS do ERP). O ERP manda
 * `https://crm…/?telefone=5533999990000&nome=Fulano`; o CRM guarda o pedido
 * (sobrevive ao login) e, com o painel aberto, vai na conversa em andamento
 * desse número — ou cria o atendimento, como o "Novo atendimento".
 */
const KEY = "sheikcell:open-chat-phone";

export interface PendingOpenChat {
  phone: string;
  name: string | null;
}

/** Lê o pedido da URL, guarda e tira da barra de endereço. Chamado ao carregar o app. */
export function captureOpenChatParam(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const phone = (params.get("telefone") ?? "").replace(/\D/g, "");
  if (!phone) return;
  const name = params.get("nome")?.trim() || null;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ phone, name } satisfies PendingOpenChat));
  } catch {
    /* navegador sem sessionStorage: segue sem abrir */
  }
  params.delete("telefone");
  params.delete("nome");
  const rest = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
}

function takePending(): PendingOpenChat | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as PendingOpenChat;
    return parsed?.phone ? parsed : null;
  } catch {
    return null;
  }
}

/** Conversa em andamento do número, ou o atendimento novo (409 = já existia). */
export async function resolveConversationForPhone(pending: PendingOpenChat): Promise<number | null> {
  const found = await api.chat.conversationByPhone(pending.phone);
  if (found.conversationId != null) return found.conversationId;
  try {
    const created = await api.chat.createConversation({
      phone: pending.phone,
      name: pending.name ?? pending.phone,
      channel: "whatsapp",
    });
    return created.id;
  } catch (err) {
    if (err instanceof ApiError && typeof err.conversationId === "number") return err.conversationId;
    throw err;
  }
}

/**
 * Nos painéis (Admin/Atendente): com um pedido guardado, abre a conversa.
 * `onError` mostra o motivo (ex.: número sem WhatsApp, sem permissão de criar).
 */
export function useOpenChatFromUrl(onError: (message: string) => void): void {
  useEffect(() => {
    const pending = takePending();
    if (!pending) return;
    let alive = true;
    resolveConversationForPhone(pending)
      .then((id) => {
        if (alive && id != null) requestChatExpand("atendimento", id);
      })
      .catch((err: unknown) => {
        if (alive) onError((err as Error)?.message ?? "Não foi possível abrir a conversa.");
      });
    return () => {
      alive = false;
    };
    // Uma vez ao montar o painel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
