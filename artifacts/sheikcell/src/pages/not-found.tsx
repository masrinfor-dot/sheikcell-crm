import { Link } from "wouter";
import { Smartphone, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
          <Smartphone className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-5xl font-extrabold text-primary mb-2">404</h1>
        <p className="text-muted-foreground mb-6">Página não encontrada</p>
        <Link href="/" className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-xl text-sm font-semibold hover:bg-primary/90 transition">
          <ArrowLeft className="w-4 h-4" />
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
