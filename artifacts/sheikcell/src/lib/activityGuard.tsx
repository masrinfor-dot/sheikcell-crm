import { createContext, useContext, useRef, useCallback, type ReactNode } from "react";

// Registro leve de "operação crítica em andamento" (Fase 3 de Rotinas e
// Produtividade) — ChatCenter registra aqui os mesmos momentos em que já
// liga/desliga `sending`/`recording`. A trava obrigatória de checklist só
// aparece quando isBusy() está livre, pra nunca interromper um envio de
// mensagem ou uma gravação de áudio em andamento.
type ActivityGuardCtx = { register: (key: string) => void; unregister: (key: string) => void; isBusy: () => boolean };

const ActivityGuardContext = createContext<ActivityGuardCtx | null>(null);

export function ActivityGuardProvider({ children }: { children: ReactNode }) {
  const activeRef = useRef<Set<string>>(new Set());
  const register = useCallback((key: string) => { activeRef.current.add(key); }, []);
  const unregister = useCallback((key: string) => { activeRef.current.delete(key); }, []);
  const isBusy = useCallback(() => activeRef.current.size > 0, []);

  return (
    <ActivityGuardContext.Provider value={{ register, unregister, isBusy }}>
      {children}
    </ActivityGuardContext.Provider>
  );
}

// Fora do provider (ex.: tela de login), vira um no-op — nunca bloqueia nem
// quebra por engano fora da árvore autenticada.
const NOOP_GUARD: ActivityGuardCtx = { register: () => {}, unregister: () => {}, isBusy: () => false };

export function useActivityGuard(): ActivityGuardCtx {
  return useContext(ActivityGuardContext) ?? NOOP_GUARD;
}
