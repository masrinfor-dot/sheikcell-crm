import { useEffect } from "react";

// Sinal fora do React pra pedir "abre essa conversa em tela cheia" a partir
// do widget flutuante — o mini-chat (docked) e o chat completo são
// instâncias React separadas (uma vive na raiz do app, outra dentro do
// dashboard), então não dá pra passar isso por props. Só um dashboard fica
// montado por sessão, então um listener por vez é suficiente (mesmo espírito
// do store do useInternalChatNotifier).
export type ChatExpandModule = "atendimento" | "equipe";
export type ChatExpandRequest = {
  module: ChatExpandModule;
  conversationId: number | null;
  requestId: number;
};

let listener: ((req: ChatExpandRequest) => void) | null = null;
let requestCounter = 0;

/** Chamado pelo GlobalChatWidget ao clicar em "expandir". */
export function requestChatExpand(module: ChatExpandModule, conversationId: number | null): void {
  requestCounter += 1;
  listener?.({ module, conversationId, requestId: requestCounter });
}

/** Registrado pelo AdminDashboard/AttendantDashboard pra reagir ao pedido. */
export function useChatExpandListener(cb: (req: ChatExpandRequest) => void): void {
  useEffect(() => {
    listener = cb;
    return () => { if (listener === cb) listener = null; };
  }, [cb]);
}
