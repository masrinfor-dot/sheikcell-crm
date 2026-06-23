import { Smartphone, Headphones, Wrench, DollarSign, Users, ShoppingBag, type LucideProps } from "lucide-react";

const iconMap: Record<string, React.ComponentType<LucideProps>> = {
  smartphone: Smartphone,
  headphones: Headphones,
  wrench: Wrench,
  "dollar-sign": DollarSign,
  users: Users,
  "shopping-bag": ShoppingBag,
};

export function SectorIcon({ icon, className, style }: { icon: string; className?: string; style?: React.CSSProperties }) {
  const Icon = iconMap[icon] ?? Smartphone;
  return <Icon className={className} style={style} />;
}
