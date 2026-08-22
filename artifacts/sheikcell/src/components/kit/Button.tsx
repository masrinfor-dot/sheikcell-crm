import { forwardRef, type ButtonHTMLAttributes } from "react";

// Redesign Fase 2 — formaliza o botão que já era hand-rolled em toda
// página (RotinasProdutividade, ChatCenter, RH etc.), mesma paleta/raio já
// em uso — não é um visual novo, é o padrão existente virando componente.
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary/90 disabled:opacity-40",
  secondary: "border border-border text-foreground hover:bg-secondary disabled:opacity-40",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40",
  danger: "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-40",
};
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-[11px]",
  md: "px-3 py-2 text-xs",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  ),
);
Button.displayName = "Button";
export default Button;
