import { useState, useRef, useEffect } from "react";
import { Search, Bell, ChevronDown, LayoutGrid } from "lucide-react";

// Redesign de layout (Fase 1, preview) — barra superior nova pro
// AdminDashboard (admin + supervisor), convivendo em paralelo com a
// sidebar antiga. Puramente visual: reaproveita a MESMA lista de tabs já
// filtrada por permissão (adminOnly/adminAccess, enabledModules,
// moduleGranted — calculada em AdminDashboard.tsx) e os mesmos TAB_GROUPS,
// sem recriar lógica nenhuma. Pesquisa/notificações aqui são só o espaço
// reservado — a função de verdade é a Fase 5.
export type TopBarTab = { id: string; label: string; icon: React.ComponentType<{ className?: string }> };
// tabs já vem resolvida (filtrada por permissão) — AdminDashboard.tsx monta
// isso a partir de TAB_GROUPS + `tabs`, essa peça só renderiza.
export type TopBarGroup = { key: string; label: string; icon: React.ComponentType<{ className?: string }>; tabs: TopBarTab[] };

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onOutside]);
  return ref;
}

function GroupMenu({ group, tab, setTab, internalChatUnread }: {
  group: TopBarGroup; tab: string; setTab: (id: string) => void; internalChatUnread: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const groupTabs = group.tabs;
  const activeHere = groupTabs.some((t) => t.id === tab);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} data-testid={`topbar-group-${group.key}`}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
          activeHere ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
        }`}>
        <group.icon className="w-4 h-4 shrink-0" />
        {group.label}
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-border rounded-xl shadow-lg py-1.5 z-30">
          {groupTabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => { setTab(id); setOpen(false); }} data-testid={`topbar-tab-${id}`}
              className={`flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-left transition-colors ${
                tab === id ? "bg-primary/10 text-primary" : "text-foreground hover:bg-secondary"
              }`}>
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1 truncate">{label}</span>
              {id === "equipe" && internalChatUnread > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {internalChatUnread > 99 ? "99+" : internalChatUnread}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminTopBar({ groups, tab, setTab, internalChatUnread }: {
  groups: TopBarGroup[]; tab: string; setTab: (id: string) => void; internalChatUnread: number;
}) {
  return (
    <div className="hidden md:flex items-center gap-1 bg-white border-b border-border sticky top-14 z-20 px-4 min-h-12 py-1 flex-wrap">
      <LayoutGrid className="w-4 h-4 text-muted-foreground shrink-0 mr-1" />
      {groups.map((group) => (
        group.tabs.length ? (
          <GroupMenu key={group.key} group={group} tab={tab} setTab={setTab} internalChatUnread={internalChatUnread} />
        ) : null
      ))}
      <div className="flex-1" />
      <button disabled title="Pesquisa global — chega na Fase 5" data-testid="topbar-search-stub"
        className="p-2 rounded-lg text-muted-foreground/50 cursor-not-allowed">
        <Search className="w-4 h-4" />
      </button>
      <button disabled title="Notificações unificadas — chega na Fase 5" data-testid="topbar-notifications-stub"
        className="p-2 rounded-lg text-muted-foreground/50 cursor-not-allowed">
        <Bell className="w-4 h-4" />
      </button>
    </div>
  );
}
