// Pool de conexões SSE compartilhadas por URL. Vários componentes que
// escutam o mesmo stream (ex.: ChatCenter da página + o do widget flutuante)
// reaproveitam a MESMA conexão real em vez de abrir uma cada — o navegador
// limita a 6 conexões HTTP/1.1 simultâneas por origem, e cada EventSource
// aberto conta uma pra sempre (streaming não libera). Sem isso, montar o
// mesmo componente em dois lugares (página + widget global) estoura esse
// limite e trava toda requisição nova (foi exatamente o bug do chat interno
// não enviar mensagem: 3 conexões de /internal-chat/events + 3 de
// /chat/events abertas ao mesmo tempo, sem sobrar conexão pro POST).
//
// Cada chamador deve: 1) pegar a conexão com acquireSharedEventSource, 2)
// registrar seus listeners nela normalmente, 3) no cleanup, REMOVER os
// próprios listeners (addEventListener/removeEventListener com a mesma
// referência de função) e então chamar releaseSharedEventSource — a conexão
// real só fecha quando o último interessado sair.
type Entry = { es: EventSource; refCount: number };
const registry = new Map<string, Entry>();

export function acquireSharedEventSource(url: string): EventSource {
  let entry = registry.get(url);
  if (!entry) {
    entry = { es: new EventSource(url, { withCredentials: true }), refCount: 0 };
    registry.set(url, entry);
  }
  entry.refCount++;
  return entry.es;
}

export function releaseSharedEventSource(url: string): void {
  const entry = registry.get(url);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.es.close();
    registry.delete(url);
  }
}
