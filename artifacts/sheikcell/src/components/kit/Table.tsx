import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

// Redesign Fase 2 — formaliza a tabela hand-rolled (RH.tsx, Financeiro.tsx,
// Relatorios.tsx, Resultados.tsx, TaskBoard.tsx, TvBox.tsx já tinham essa
// mesma combinação texto-xs/py-2 px-3 repetida cada uma do seu jeito).
// Colunas ocultáveis/ordenáveis são Fase 6 — aqui só o estilo base.
export function Table({ className = "", ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-xs ${className}`} {...props} />
    </div>
  );
}
export function TableHead({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={`border-b border-border ${className}`} {...props} />;
}
export function TableBody({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}
export function TableRow({ className = "", ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={`border-b border-border last:border-0 hover:bg-secondary/40 transition ${className}`} {...props} />;
}
export function Th({ className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={`text-left py-2 px-3 font-semibold text-muted-foreground ${className}`} {...props} />;
}
export function Td({ className = "", ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`py-2 px-3 ${className}`} {...props} />;
}
