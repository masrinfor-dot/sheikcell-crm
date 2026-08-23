import { useEffect, useState } from "react";
import { api, type MySession } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Laptop, Smartphone, ShieldCheck, X, LogOut } from "lucide-react";

// Item 15 do roadmap de segurança: o usuário revisa e encerra suas próprias
// sessões ativas (máx. 2 simultâneas — a mais antiga já é encerrada
// automaticamente no 3º login pelo backend; isto aqui é o autogerenciamento).
export default function MySessionsModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [busySid, setBusySid] = useState<string | null>(null);
  const [endingOthers, setEndingOthers] = useState(false);

  const load = () => {
    api.auth.sessions.list().then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
  };
  useEffect(load, []);

  const handleEnd = async (sid: string) => {
    setBusySid(sid);
    try {
      await api.auth.sessions.end(sid);
      load();
      toast({ title: "Sessão encerrada" });
    } catch (err) {
      toast({ title: "Erro ao encerrar sessão", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setBusySid(null);
    }
  };

  const handleEndOthers = async () => {
    setEndingOthers(true);
    try {
      await api.auth.sessions.endOthers();
      load();
      toast({ title: "As outras sessões foram encerradas" });
    } catch (err) {
      toast({ title: "Erro ao encerrar sessões", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setEndingOthers(false);
    }
  };

  const others = (sessions ?? []).filter((s) => !s.isCurrent);

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" /> Minhas sessões
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-secondary transition" data-testid="button-close-sessions">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          Máximo de 2 sessões simultâneas. Ao logar num 3º dispositivo, a mais antiga é encerrada automaticamente.
        </p>

        {sessions === null ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Carregando...</p>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Nenhuma sessão ativa encontrada.</p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {sessions.map((s) => (
              <div key={s.sid} data-testid={`session-row-${s.sid}`}
                className={`flex items-center gap-3 p-3 rounded-xl border ${s.isCurrent ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                {s.device === "Computador" ? <Laptop className="w-5 h-5 text-muted-foreground shrink-0" /> : <Smartphone className="w-5 h-5 text-muted-foreground shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate">
                    {s.device} · {s.browser} {s.isCurrent && <span className="text-primary">(esta sessão)</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {s.ip ?? "IP desconhecido"} · {s.loginAt ? new Date(s.loginAt).toLocaleString("pt-BR") : "horário desconhecido"}
                  </p>
                </div>
                {!s.isCurrent && (
                  <button onClick={() => handleEnd(s.sid)} disabled={busySid === s.sid} data-testid={`button-end-session-${s.sid}`}
                    className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 transition disabled:opacity-40 shrink-0" title="Encerrar esta sessão">
                    <LogOut className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-4">
          <button type="button" onClick={onClose}
            className="flex-1 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
            Fechar
          </button>
          {others.length > 0 && (
            <button type="button" onClick={handleEndOthers} disabled={endingOthers} data-testid="button-end-other-sessions"
              className="flex-1 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-40 transition">
              {endingOthers ? "Encerrando..." : "Encerrar outras sessões"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
