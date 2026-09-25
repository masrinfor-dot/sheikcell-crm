import { useState, useEffect, useMemo, useCallback } from "react";
import { api, type WhatsappContactRow } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Search, Copy, MessageCircle, BadgeCheck, BookUser, ChevronDown } from "lucide-react";

// Agenda de Contatos do WhatsApp (pedido 25/09, fase 1 de "puxar histórico
// de conversa e contatos igual o WhatsApp Web"): mostra os contatos que o
// Baileys já sincronizou de cada linha (mesmo mecanismo do WhatsApp Web —
// roda continuamente, vai enchendo aos poucos mesmo em linhas já
// conectadas). Busca no servidor (o volume pode ser grande — não dá pra
// carregar tudo de uma vez como o Diretório interno da equipe).
const AVATAR_COLORS = ["bg-blue-500", "bg-emerald-500", "bg-violet-500", "bg-rose-500", "bg-amber-500", "bg-cyan-500", "bg-fuchsia-500"];
function avatarColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
// Formata um telefone brasileiro (com ou sem DDI 55) para exibição: "+55 (11) 99999-9999".
function formatPhoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const withoutDdi = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  if (withoutDdi.length === 11) return `(${withoutDdi.slice(0, 2)}) ${withoutDdi.slice(2, 7)}-${withoutDdi.slice(7)}`;
  if (withoutDdi.length === 10) return `(${withoutDdi.slice(0, 2)}) ${withoutDdi.slice(2, 6)}-${withoutDdi.slice(6)}`;
  return phone;
}

export default function WhatsappContacts() {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<WhatsappContactRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<{ sessionKey: string; displayName: string | null; color: string; icon: string | null }[]>([]);
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const PAGE_SIZE = 60;

  useEffect(() => { api.chat.waSessions().then(setSessions).catch(() => setSessions([])); }, []);

  const load = useCallback((opts?: { append?: boolean }) => {
    setLoading(true);
    api.whatsappContacts
      .list({ search: search || undefined, sessionKey: sessionFilter ?? undefined, limit: PAGE_SIZE, offset: opts?.append ? (contacts?.length ?? 0) : 0 })
      .then((res) => {
        setContacts((prev) => (opts?.append && prev ? [...prev, ...res.rows] : res.rows));
        setTotal(res.total);
      })
      .catch(() => { if (!opts?.append) { setContacts([]); setTotal(0); } })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sessionFilter]);

  // Busca com debounce — evita disparar uma requisição a cada tecla.
  useEffect(() => {
    const t = setTimeout(() => load(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sessionFilter]);

  const sessionByKey = useMemo(() => new Map(sessions.map((s) => [s.sessionKey, s])), [sessions]);

  const copyPhone = (c: WhatsappContactRow) => {
    navigator.clipboard.writeText(formatPhoneDisplay(c.phone))
      .then(() => toast({ title: "Telefone copiado!" }))
      .catch(() => toast({ title: "Não foi possível copiar", variant: "destructive" }));
  };

  const openInWhatsApp = (c: WhatsappContactRow) => {
    const digits = c.phone.replace(/\D/g, "");
    window.open(`https://wa.me/${digits}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-4" data-testid="whatsapp-contacts-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-border flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome ou telefone..."
            data-testid="input-whatsapp-contacts-search"
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground" />
        </div>
        {sessions.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={() => setSessionFilter(null)} data-testid="button-wacontacts-filter-all"
              className={`px-3 py-2 rounded-xl text-xs font-semibold border transition ${
                sessionFilter === null ? "bg-secondary border-border" : "bg-white text-muted-foreground border-border hover:bg-secondary"
              }`}>
              Todas as linhas
            </button>
            {sessions.map((s) => (
              <button key={s.sessionKey} onClick={() => setSessionFilter(s.sessionKey)}
                data-testid={`button-wacontacts-filter-${s.sessionKey}`}
                style={sessionFilter === s.sessionKey ? { backgroundColor: `${s.color}22`, borderColor: s.color, color: s.color } : undefined}
                className={`px-3 py-2 rounded-xl text-xs font-semibold border transition ${
                  sessionFilter === s.sessionKey ? "" : "bg-white text-muted-foreground border-border hover:bg-secondary"
                }`}>
                {s.icon ? `${s.icon} ` : ""}{s.displayName ?? s.sessionKey}
              </button>
            ))}
          </div>
        )}
      </div>

      {!contacts ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Carregando...</div>
      ) : contacts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <BookUser className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-sm">{search ? "Nenhum contato encontrado." : "Nenhum contato sincronizado ainda."}</p>
          {!search && (
            <p className="text-xs mt-1 max-w-sm text-center">
              A agenda é preenchida aos poucos pelo próprio WhatsApp conforme a linha conecta e recebe mensagens — pode levar um tempo até aparecer tudo.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{total} contato{total === 1 ? "" : "s"}</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {contacts.map((c) => {
              const displayName = c.name || c.pushName || formatPhoneDisplay(c.phone);
              const session = sessionByKey.get(c.sessionKey);
              return (
                <div key={`${c.sessionKey}-${c.id}`} className="shk-card p-4" data-testid={`wacontact-card-${c.id}`}>
                  <div className="flex items-start gap-3">
                    {c.avatarUrl ? (
                      <img src={c.avatarUrl} alt={displayName} className="w-11 h-11 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className={`w-11 h-11 rounded-full ${avatarColor(displayName)} flex items-center justify-center text-white font-bold shrink-0`}>
                        {initials(displayName)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <p className="font-semibold text-sm text-foreground truncate">{displayName}</p>
                        {c.isBusiness && (
                          <span title="Conta comercial verificada" className="shrink-0">
                            <BadgeCheck className="w-3.5 h-3.5 text-emerald-600" />
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">{formatPhoneDisplay(c.phone)}</p>
                      {c.name && c.pushName && c.name !== c.pushName && (
                        <p className="text-[11px] text-muted-foreground/70 truncate">perfil: {c.pushName}</p>
                      )}
                    </div>
                  </div>
                  {session && (
                    <div className="mt-2">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{ backgroundColor: `${session.color}22`, color: session.color }}>
                        {session.icon ? `${session.icon} ` : ""}via {session.displayName ?? c.sessionKey}
                      </span>
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => copyPhone(c)} data-testid={`button-wacontact-copy-${c.id}`}
                      className="flex-1 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-secondary transition flex items-center justify-center gap-1.5">
                      <Copy className="w-3.5 h-3.5" /> Copiar
                    </button>
                    <button onClick={() => openInWhatsApp(c)} data-testid={`button-wacontact-open-${c.id}`}
                      className="flex-1 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-secondary transition flex items-center justify-center gap-1.5">
                      <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {contacts.length < total && (
            <div className="flex justify-center pt-2">
              <button onClick={() => load({ append: true })} disabled={loading} data-testid="button-wacontacts-load-more"
                className="px-4 py-2 rounded-xl text-xs font-semibold border border-border bg-white text-muted-foreground hover:bg-secondary transition disabled:opacity-50 flex items-center gap-1.5">
                <ChevronDown className="w-3.5 h-3.5" /> {loading ? "Carregando..." : "Carregar mais"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
