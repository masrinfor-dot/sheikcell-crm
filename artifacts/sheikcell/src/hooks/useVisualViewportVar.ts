import { useEffect } from "react";

// Mantém a variável CSS --vvh sincronizada com a altura REAL da área visível
// da tela (window.visualViewport), que encolhe quando o teclado virtual do
// celular abre. "100dvh" já tenta resolver isso, mas alguns navegadores
// (principalmente WebViews Android mais antigos) atualizam o dvh com atraso
// ou nem atualizam durante o teclado aberto — a Visual Viewport API é a
// fonte mais confiável. CSS que usa `calc(var(--vvh, 100dvh) - ...)` cai de
// volta pro dvh normal enquanto essa var não foi definida (SSR, navegador
// sem suporte) ou antes do primeiro evento disparar.
export function useVisualViewportVar(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
}
