import { useEffect, useRef } from "react";

/**
 * Fecha um menu/dropdown ao clicar fora dele (ou soltar o dedo fora, no
 * celular). Devolve um ref pra colocar no container do menu inteiro
 * (botão + painel aberto) — um clique em QUALQUER lugar de fora chama
 * `onOutside`, então normalmente isso é só `setAberto(false)`.
 */
export function useClickOutside<T extends HTMLElement>(onOutside: () => void, active = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return;
    function handler(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [onOutside, active]);
  return ref;
}
