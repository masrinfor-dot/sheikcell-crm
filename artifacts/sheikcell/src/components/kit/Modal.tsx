import type { ReactNode } from "react";
import { X } from "lucide-react";

// Redesign Fase 2 — formaliza o modal que cada tela reconstruía do zero
// (overlay fixed inset-0 + shk-card centralizado) — RotinasProdutividade
// sozinha tinha essa mesma estrutura duas vezes (form de checklist,
// respostas). Mesmo visual, só vira componente.
export type ModalWidth = "sm" | "md" | "lg" | "xl";
const WIDTH_CLASSES: Record<ModalWidth, string> = {
  sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl",
};

export default function Modal({
  open, onClose, title, children, footer, width = "lg",
}: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: ModalWidth;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className={`shk-card w-full ${WIDTH_CLASSES[width]} p-6 my-8 bg-white`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold">{title}</h3>
          <button onClick={onClose} data-testid="modal-close" aria-label="Fechar">
            <X className="w-5 h-5 text-muted-foreground hover:text-foreground transition" />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto pr-1">{children}</div>
        {footer && <div className="flex gap-2 mt-5">{footer}</div>}
      </div>
    </div>
  );
}
