import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { acquireSharedEventSource, releaseSharedEventSource } from "@/lib/sharedEventSource";

const INTERNAL_CHAT_EVENTS_URL = "/api/internal-chat/events";

// Store simples (fora do React) para o total de não lidas do chat interno —
// assim o InternalChat.tsx (quando montado) e o badge do menu (sempre
// montado) enxergam o mesmo número sem precisar de um Context Provider.
type Listener = (count: number) => void;
let unreadCount = 0;
const listeners = new Set<Listener>();
function publishUnread(count: number) {
  unreadCount = count;
  listeners.forEach((l) => l(count));
}
/** Chamado pelo InternalChat.tsx sempre que sua própria lista de conversas
 * muda, para o badge do menu refletir na hora (sem esperar o polling). */
export function reportInternalChatUnread(count: number) {
  publishUnread(count);
}

// Beep curto sintetizado via Web Audio API — evita empacotar um arquivo de
// áudio só para isso.
function playBlip() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch {
    /* ambiente sem suporte a áudio — segue sem som */
  }
}

function notifyDesktop(body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification("Chat interno", { body, tag: "internal-chat", icon: "/favicon.svg" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    /* Notification pode falhar em alguns navegadores/PWA — ignora */
  }
}

/**
 * Badge (contador de não lidas) + alerta (som/notificação do navegador) do
 * chat interno, ativo mesmo quando o painel não está montado na tela.
 *
 * `chatVisible` indica se a aba/painel do chat interno está na frente do
 * usuário agora — sem isso, toda mensagem alertaria mesmo com a conversa
 * já aberta. Mantém sua própria conexão SSE (separada da que o
 * InternalChat.tsx abre quando montado); a duplicidade é aceitável pois é
 * um número fixo e pequeno de conexões, não crescente.
 */
export function useInternalChatNotifier(userId: number | undefined, chatVisible: boolean, enabled = true): number {
  const [count, setCount] = useState(unreadCount);
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;

  useEffect(() => {
    listeners.add(setCount);
    return () => { listeners.delete(setCount); };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [enabled]);

  useEffect(() => {
    // Sem permissão de "equipe" (ex.: alguns vendedores), não entra na sala
    // geral nem abre conexão — só usuários com acesso ao chat interno.
    if (!enabled) return;
    let cancelled = false;
    const refreshUnread = () => {
      api.internalChat.conversations().then((list) => {
        if (cancelled) return;
        publishUnread(list.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0));
      }).catch(() => {});
    };
    refreshUnread();
    const poll = setInterval(refreshUnread, 20000);

    const es = acquireSharedEventSource(INTERNAL_CHAT_EVENTS_URL);
    const onInternalMessage = (e: Event) => {
      const payload = JSON.parse((e as MessageEvent).data) as {
        message: { senderId: number; senderName: string; content: string };
      };
      if (payload.message.senderId === userId) return; // própria mensagem
      refreshUnread();
      // Alerta só quando a tela não está sendo vista agora: aba do
      // navegador em segundo plano OU usuário em outra parte do app.
      if (document.hidden || !chatVisibleRef.current) {
        playBlip();
        notifyDesktop(`${payload.message.senderName}: ${payload.message.content.slice(0, 120)}`);
      }
    };
    es.addEventListener("internal_message", onInternalMessage);
    es.addEventListener("resync", refreshUnread);
    es.addEventListener("internal_reconnect", refreshUnread);

    return () => {
      cancelled = true;
      clearInterval(poll);
      es.removeEventListener("internal_message", onInternalMessage);
      es.removeEventListener("resync", refreshUnread);
      es.removeEventListener("internal_reconnect", refreshUnread);
      releaseSharedEventSource(INTERNAL_CHAT_EVENTS_URL);
    };
  }, [userId, enabled]);

  return count;
}
