import { useEffect, useState } from "react";

// Sinal fora do React pra pedir "abre essa conversa em tela cheia" a partir
// do widget flutuante — o mini-chat (docked) e o chat completo são
// instâncias React separadas (uma vive na raiz do app, outra dentro do
// dashboard), então não dá pra passar isso por props. Só um dashboard fica
// montado por sessão, então um listener por vez é suficiente (mesmo espírito
// do store do useInternalChatNotifier).
export type ChatExpandModule = "atendimento" | "equipe";
// origin "crm": o pedido veio do botão "ir para o atendimento" do CRM —
// os dashboards usam isso pra mostrar um botão "Voltar ao CRM" na
// conversa aberta (ver handleGoToChat em CrmBoard.tsx).
export type ChatExpandOrigin = "crm";
export type ChatExpandRequest = {
  module: ChatExpandModule;
  conversationId: number | null;
  requestId: number;
  origin?: ChatExpandOrigin;
};

let listener: ((req: ChatExpandRequest) => void) | null = null;
let requestCounter = 0;

/** Chamado pelo GlobalChatWidget (ou pelo CRM) ao clicar em "expandir". */
export function requestChatExpand(module: ChatExpandModule, conversationId: number | null, origin?: ChatExpandOrigin): void {
  requestCounter += 1;
  listener?.({ module, conversationId, requestId: requestCounter, origin });
}

/** Registrado pelo AdminDashboard/AttendantDashboard pra reagir ao pedido. */
export function useChatExpandListener(cb: (req: ChatExpandRequest) => void): void {
  useEffect(() => {
    listener = cb;
    return () => { if (listener === cb) listener = null; };
  }, [cb]);
}

// Sinal fora do React: "a aba Atendimento está a vista agora?" — os
// dashboards (Admin/Attendant) publicam isso ao trocar de aba. O
// GlobalChatWidget assina pra esconder o próprio balão/toggle quando o
// usuário já está direto na Central de Atendimento: sem isso, o botão
// flutuante (fixed bottom-right) fica sobreposto ao botão de enviar do
// composer, que também encosta no canto direito da tela nessa tela.
let atendimentoTabVisible = false;
let atendimentoTabVisibleListeners: Array<(v: boolean) => void> = [];

/** Chamado pelo AdminDashboard/AttendantDashboard ao trocar de aba. */
export function setAtendimentoTabVisible(visible: boolean): void {
  if (atendimentoTabVisible === visible) return;
  atendimentoTabVisible = visible;
  atendimentoTabVisibleListeners.forEach((cb) => cb(visible));
}

/** Assinado pelo GlobalChatWidget. */
export function useAtendimentoTabVisible(): boolean {
  const [visible, setVisible] = useState(atendimentoTabVisible);
  useEffect(() => {
    setVisible(atendimentoTabVisible); // sincroniza caso tenha mudado antes de montar
    atendimentoTabVisibleListeners.push(setVisible);
    return () => {
      atendimentoTabVisibleListeners = atendimentoTabVisibleListeners.filter((cb) => cb !== setVisible);
    };
  }, []);
  return visible;
}
