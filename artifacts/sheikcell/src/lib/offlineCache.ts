// Cache offline das leituras da API (Fase 1 do app desktop / internet ruim).
//
// Toda resposta GET bem-sucedida que passa por req() é guardada no IndexedDB
// do navegador/WebView. Quando a rede cai, fica lenta demais ou o servidor não
// responde, req() devolve a última versão guardada em vez de travar a tela —
// e avisa o OfflineBanner que os dados podem estar desatualizados.
//
// Escritas (POST/PUT/PATCH/DELETE) NÃO entram aqui: sem internet elas falham
// com uma mensagem clara. Fila de escrita offline é a Fase 2.
//
// Segurança: o cache é apagado no logout e quando a sessão expira (401), pra
// que outra pessoa usando o mesmo PC não veja os dados de quem saiu.

const DB_NAME = "sheikcell-offline";
const STORE = "responses";
const DB_VERSION = 1;
// Entradas mais velhas que isso são descartadas ao abrir o app.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Rotas que nunca vão pro cache (login/sessão, conteúdo binário, exportações).
const DENY = [/^\/auth\/(login|logout)/, /\/media/, /\/download/, /\/export/, /\/files?\//];

type Entry = { path: string; data: unknown; savedAt: number };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) {
          r.result.createObjectStore(STORE, { keyPath: "path" });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export function isCacheable(path: string): boolean {
  return !DENY.some((re) => re.test(path));
}

export async function readCached<T>(path: string): Promise<{ data: T; savedAt: number } | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(path);
      r.onsuccess = () => {
        const e = r.result as Entry | undefined;
        resolve(e ? { data: e.data as T, savedAt: e.savedAt } : null);
      };
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeCached(path: string, data: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const entry: Entry = { path, data, savedAt: Date.now() };
    db.transaction(STORE, "readwrite").objectStore(STORE).put(entry);
  } catch {
    // Cota cheia / modo privado: segue sem cache.
  }
}

export async function clearOfflineCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function pruneOld(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const cur = store.openCursor();
    const limit = Date.now() - MAX_AGE_MS;
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      if ((c.value as Entry).savedAt < limit) c.delete();
      c.continue();
    };
  } catch {
    // ignora
  }
}
void pruneOld();

// ---------------------------------------------------------------------------
// Estado de conexão compartilhado com o OfflineBanner
// ---------------------------------------------------------------------------

export type ConnectivityState = {
  online: boolean;
  // Último momento em que uma tela foi montada com dados do cache (rede falhou).
  servingCacheSince: number | null;
};

let state: ConnectivityState = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  servingCacheSince: null,
};
const listeners = new Set<(s: ConnectivityState) => void>();

function emit(next: Partial<ConnectivityState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l(state));
}

export function getConnectivity(): ConnectivityState {
  return state;
}

export function subscribeConnectivity(fn: (s: ConnectivityState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function markServedFromCache() {
  if (state.servingCacheSince == null) emit({ servingCacheSince: Date.now() });
}

export function markNetworkOk() {
  if (!state.online || state.servingCacheSince != null) {
    emit({ online: true, servingCacheSince: null });
  }
}

export function markNetworkFailed() {
  if (state.online) emit({ online: false });
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => emit({ online: true }));
  window.addEventListener("offline", () => emit({ online: false }));
}
