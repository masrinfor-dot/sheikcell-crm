import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { MapPin, Loader2 } from "lucide-react";

// Campo de texto com sugestão automática de cidade/bairro (Google Places,
// via proxy no backend — ver routes/geo.ts). Sem servidor configurado (sem
// GOOGLE_PLACES_API_KEY), a busca simplesmente não retorna nada e o campo
// funciona como um input de texto normal, sem quebrar a tela.
type Props = {
  value: string;
  onChange: (value: string) => void;
  kind: "city" | "address";
  placeholder?: string;
  className?: string;
  testId?: string;
};

export function AddressAutocompleteInput({ value, onChange, kind, placeholder, className, testId }: Props) {
  const [suggestions, setSuggestions] = useState<{ description: string; mainText: string; secondaryText: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handleChange(next: string) {
    onChange(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = next.trim();
    if (q.length < 3) { setSuggestions([]); setOpen(false); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const myReqId = ++reqIdRef.current;
      try {
        const r = await api.geo.autocomplete(q, kind);
        if (myReqId !== reqIdRef.current) return; // resposta antiga, ignora
        setSuggestions(r.results);
        setOpen(r.results.length > 0);
      } catch {
        if (myReqId !== reqIdRef.current) return;
        setSuggestions([]);
      } finally {
        if (myReqId === reqIdRef.current) setLoading(false);
      }
    }, 350);
  }

  function pick(mainText: string) {
    onChange(mainText);
    setOpen(false);
    setSuggestions([]);
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <input
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          placeholder={placeholder}
          className={className}
          autoComplete="off"
          data-testid={testId}
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-xl border border-border bg-popover shadow-lg overflow-hidden">
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => pick(s.mainText)}
              className="w-full flex items-start gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors"
            >
              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">{s.mainText}</span>
                {s.secondaryText && <span className="text-muted-foreground"> — {s.secondaryText}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
