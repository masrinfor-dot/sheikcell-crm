/**
 * Cliente SSE do chat para o app mobile.
 *
 * React Native não tem EventSource nativo, então usamos XMLHttpRequest com
 * leitura incremental de `responseText` (funciona no nativo e na web) e
 * implementamos por conta própria:
 *  - parsing do protocolo SSE (`id:` / `event:` / `data:`, eventos separados
 *    por linha em branco);
 *  - reconexão automática com backoff e reenvio de `Last-Event-ID`, para o
 *    servidor reproduzir eventos perdidos durante a queda (mesma semântica do
 *    EventSource do navegador usado na Central de Atendimento web).
 */

export type ChatEventHandler = (data: unknown) => void;

export type ChatEventsConnection = {
  close: () => void;
};

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export function connectChatEvents(
  baseUrl: string,
  handlers: Record<string, ChatEventHandler>,
): ChatEventsConnection {
  let xhr: XMLHttpRequest | null = null;
  let closed = false;
  let lastEventId: string | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (eventName: string, rawData: string) => {
    const handler = handlers[eventName];
    if (!handler) return;
    try {
      handler(rawData ? JSON.parse(rawData) : null);
    } catch {
      /* payload inválido: ignora — nunca derruba a conexão por um evento ruim */
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer != null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = () => {
    if (closed) return;
    let parsedUpTo = 0; // até onde do responseText já foi processado

    const req = new XMLHttpRequest();
    xhr = req;
    req.open("GET", `${baseUrl}/api/chat/events`, true);
    req.setRequestHeader("Accept", "text/event-stream");
    req.setRequestHeader("Cache-Control", "no-cache");
    if (lastEventId != null) req.setRequestHeader("Last-Event-ID", lastEventId);
    req.withCredentials = true;

    const consume = () => {
      // readyState 3 = LOADING: responseText cresce a cada chunk recebido.
      const text = req.responseText ?? "";
      if (text.length <= parsedUpTo) return;
      const chunk = text.slice(parsedUpTo);
      // Só processa eventos COMPLETOS (terminados em linha em branco); o resto
      // fica para o próximo chunk.
      const lastBoundary = chunk.lastIndexOf("\n\n");
      if (lastBoundary === -1) return;
      const complete = chunk.slice(0, lastBoundary);
      parsedUpTo += lastBoundary + 2;

      for (const block of complete.split("\n\n")) {
        if (!block.trim()) continue;
        let eventName = "message";
        let id: string | null = null;
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // comentário (keepalive)
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          else if (line.startsWith("id:")) id = line.slice(3).trim();
        }
        // Avança o checkpoint de reconexão para TODO evento completo, mesmo os
        // que este cliente não trata (message, message_updated, …). Se só
        // avançássemos nos eventos tratados, o Last-Event-ID ficaria para trás
        // e uma reconexão reproduziria avisos de retorno já mostrados
        // (banners/haptics duplicados).
        if (id != null) lastEventId = id;
        if (dataLines.length > 0) {
          dispatch(eventName, dataLines.join("\n"));
        }
      }
      // Conexão viva e entregando eventos: zera o backoff.
      attempt = 0;
    };

    req.onreadystatechange = () => {
      if (closed) return;
      if (req.readyState === 3 || req.readyState === 4) consume();
      if (req.readyState === 4) scheduleReconnect(); // stream terminou: reconecta
    };
    req.onerror = () => { if (!closed) scheduleReconnect(); };
    req.ontimeout = () => { if (!closed) scheduleReconnect(); };

    try {
      req.send();
    } catch {
      scheduleReconnect();
    }
  };

  open();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      try { xhr?.abort(); } catch { /* ignore */ }
    },
  };
}
