import { useState, useEffect, useMemo } from "react";
import { api, type TeamContact } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Search, Star, Copy, Mail, Hash, Building2, BookUser } from "lucide-react";

// Diretório interno de contatos: colegas da equipe (reaproveita os usuários já
// cadastrados na loja). Acesso rápido a quem se fala com frequência via favoritos.
const AVATAR_COLORS = ["bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-rose-500", "bg-amber-500", "bg-cyan-500", "bg-fuchsia-500"];
function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}
function roleLabel(role: string): string {
  if (role === "admin") return "Admin";
  if (role === "supervisor") return "Supervisor";
  if (role === "superadmin") return "Superadmin";
  return "Vendedor";
}

export default function TeamDirectory() {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<TeamContact[] | null>(null);
  const [search, setSearch] = useState("");
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const load = () => { api.teamDirectory.list().then(setContacts).catch(() => setContacts([])); };
  useEffect(load, []);

  const toggleFavorite = async (c: TeamContact) => {
    setContacts((prev) => prev?.map((x) => x.id === c.id ? { ...x, favorited: !x.favorited } : x) ?? prev);
    try {
      if (c.favorited) await api.teamDirectory.unfavorite(c.id);
      else await api.teamDirectory.favorite(c.id);
    } catch {
      setContacts((prev) => prev?.map((x) => x.id === c.id ? { ...x, favorited: c.favorited } : x) ?? prev);
      toast({ title: "Não foi possível alterar favorito", variant: "destructive" });
    }
  };

  const copyContact = (c: TeamContact) => {
    const lines = [c.name, c.email, c.extension ? `Ramal: ${c.extension}` : null, c.sectorName ?? null]
      .filter(Boolean).join("\n");
    navigator.clipboard.writeText(lines)
      .then(() => toast({ title: "Copiado!", description: c.name }))
      .catch(() => toast({ title: "Não foi possível copiar", variant: "destructive" }));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (contacts ?? []).filter((c) =>
      (!onlyFavorites || c.favorited) &&
      (!q || c.name.toLowerCase().includes(q) || (c.sectorName ?? "").toLowerCase().includes(q) || (c.extension ?? "").includes(q))
    );
  }, [contacts, search, onlyFavorites]);

  return (
    <div className="space-y-4" data-testid="team-directory-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-border flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, setor ou ramal..."
            data-testid="input-directory-search"
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
        </div>
        <button onClick={() => setOnlyFavorites((v) => !v)} data-testid="button-directory-only-favorites"
          className={`px-3 py-2 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition ${
            onlyFavorites ? "bg-amber-50 text-amber-700 border-amber-300" : "bg-white text-muted-foreground border-border hover:bg-secondary"
          }`}>
          <Star className={`w-3.5 h-3.5 ${onlyFavorites ? "fill-amber-500" : ""}`} /> Favoritos
        </button>
      </div>

      {!contacts ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Carregando...</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <BookUser className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-sm">{onlyFavorites ? "Nenhum favorito ainda." : "Nenhum colega encontrado."}</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <div key={c.id} className="shk-card p-4" data-testid={`directory-card-${c.id}`}>
              <div className="flex items-start gap-3">
                <div className={`w-11 h-11 rounded-full ${avatarColor(c.name)} flex items-center justify-center text-white font-bold shrink-0`}>
                  {initials(c.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <p className="font-semibold text-sm text-foreground truncate">{c.name}</p>
                    <button onClick={() => toggleFavorite(c)} data-testid={`button-directory-favorite-${c.id}`}
                      title={c.favorited ? "Remover dos favoritos" : "Favoritar"}
                      className="p-0.5 shrink-0 hover:bg-amber-100 rounded transition">
                      <Star className={`w-4 h-4 ${c.favorited ? "text-amber-500 fill-amber-500" : "text-muted-foreground/50"}`} />
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{roleLabel(c.role)}{c.sectorName ? ` · ${c.sectorName}` : ""}</p>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5 truncate"><Mail className="w-3 h-3 shrink-0" /> {c.email}</div>
                {c.extension && <div className="flex items-center gap-1.5"><Hash className="w-3 h-3 shrink-0" /> Ramal {c.extension}</div>}
                {c.storeName && <div className="flex items-center gap-1.5 truncate"><Building2 className="w-3 h-3 shrink-0" /> {c.storeName}</div>}
              </div>
              <button onClick={() => copyContact(c)} data-testid={`button-directory-copy-${c.id}`}
                className="mt-3 w-full py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-secondary transition flex items-center justify-center gap-1.5">
                <Copy className="w-3.5 h-3.5" /> Copiar informações
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
