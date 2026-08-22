import { forwardRef, type SelectHTMLAttributes } from "react";

// Redesign Fase 2 — formaliza o <select> de filtro repetido em toda tela
// de listagem (RotinasProdutividade sozinha tinha essa combinação de
// classe 6+ vezes). Mesmo estilo, só vira componente.
const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className = "", ...props }, ref) => (
    <select
      ref={ref}
      className={`px-2 py-1.5 rounded-lg border border-border text-xs bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 ${className}`}
      {...props}
    />
  ),
);
Select.displayName = "Select";
export default Select;
