import { useState, useEffect } from "react";
import { api, type TeamStatusRow } from "@/lib/api";
import { Wifi, X, Clock } from "lucide-react";

const roleLabel: Record<string, string> = { admin: "Admin", supervisor: "Supervisor", vendedor: "Vendedor" };

function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "nunca entrou";
  // O banco pode devolver "2026-07-31 22:06:30+00" (espaço em vez de T) — normaliza p/ Safari.
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Painel "quem está online agora" + histórico de horários de acesso.
export default function EquipeOnline() {
  const [rows, setRows] = useState<TeamStatusRow[]>([]);
  const [logsOf, setLogsOf] = useState<TeamStatusRow | null>(null);
  const [logs, setLogs] = useState<{ loggedInAt: string }[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    const load = () => api.teamStatus.list().then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 30_000); // atualiza sozinho a cada 30s
    return () => clearInterval(t);
  }, []);

  const openLogs = (u: TeamStatusRow) => {
    setLogsOf(u);
    setLogs([]);
    setLoadingLogs(true);
    api.teamStatus.accessLogs(u.id).then(setLogs).catch(() => {}).finally(() => setLoadingLogs(false));
  };

  const sorted = [...rows].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const onlineCount = rows.filter((r) => r.online).length;

  return (
    <div className="shk-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Wifi className="w-4 h-4 text-green-600" />
        <span className="font-bold text-sm">Equipe agora</span>
        <span className="text-xs font-semibold bg-green-100 text-green-700 rounded-full px-2 py-0.5" data-testid="text-online-count">
          {onlineCount} online
        </span>
        <span className="text-[11px] text-muted-foreground ml-auto hidden sm:block">toque em alguém para ver os horários de acesso</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {sorted.map((u) => (
          <button key={u.id} onClick={() => openLogs(u)} data-testid={`team-status-${u.id}`}
            className="flex items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-left hover:bg-secondary/50 transition">
            <div className="relative shrink-0">
              <div className="w-9 h-9 rounded-full bg-primary text-white text-xs font-semibold flex items-center justify-center">{initials(u.name)}</div>
              <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${u.online ? "bg-green-500" : "bg-gray-300"}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{u.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {u.online
                  ? <span className="text-green-600 font-semibold">Online agora</span>
                  : `Último acesso: ${fmtDateTime(u.lastLoginAt)}`}
                {" · "}{roleLabel[u.role] ?? u.role}
              </p>
            </div>
          </button>
        ))}
        {rows.length === 0 && <p className="text-xs text-muted-foreground col-span-full py-2">Carregando equipe...</p>}
      </div>

      {/* Modal: horários de acesso */}
      {logsOf && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3" onClick={() => setLogsOf(null)}>
          <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" /> Horários de acesso — {logsOf.name}
              </span>
              <button onClick={() => setLogsOf(null)} data-testid="button-close-access-logs" className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              {loadingLogs ? (
                <div className="h-16 rounded-lg bg-secondary animate-pulse" />
              ) : logs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Nenhum acesso registrado ainda.<br /><span className="text-xs">(o registro começou com esta atualização)</span></p>
              ) : (
                <ul className="space-y-1.5">
                  {logs.map((l, i) => {
                    const d = new Date(l.loggedInAt);
                    return (
                      <li key={i} className="flex items-center justify-between text-sm rounded-lg bg-secondary/40 px-3 py-1.5">
                        <span>{d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}</span>
                        <span className="font-semibold">{d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
