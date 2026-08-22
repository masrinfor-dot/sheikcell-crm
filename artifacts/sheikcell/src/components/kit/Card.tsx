import type { HTMLAttributes } from "react";

// Redesign Fase 2 — wrapper fino em cima da classe .shk-card (index.css),
// que já é o único primitivo de fato compartilhado hoje. Não muda o visual,
// só formaliza padding em vez de cada tela repetir "p-3"/"p-4"/"p-6" à mão.
export type CardPadding = "none" | "sm" | "md" | "lg";
const PADDING_CLASSES: Record<CardPadding, string> = {
  none: "", sm: "p-3", md: "p-4", lg: "p-6",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
}

export default function Card({ padding = "md", className = "", ...props }: CardProps) {
  return <div className={`shk-card ${PADDING_CLASSES[padding]} ${className}`} {...props} />;
}
