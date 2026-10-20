import { useEffect, useState } from "react";
import { api, type TasksErpImportReport, type TasksErpStatus } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { ListTodo, CheckCircle2, AlertTriangle } from "lucide-react";

export function importSummary(r: TasksErpImportReport): string {
  return [
    `${r.created} tarefa(s) nova(s) no ERP`,
    r.existing ? `${r.existing} já estavam lá` : null,
    `${r.comments} comentário(s)`,
    `${r.subtasks} subtarefa(s)`,
    r.files ? `${r.files} anexo(s)` : null,
    r.fileErrors ? `${r.fileErrors} anexo(s) não foram (tipo não aceito no ERP)` : null,
  ].filter(Boolean).join(" · ");
}

// Quadro de tarefas unificado (19/10/2026): as tarefas passam a morar no ERP
// Prumo e este CRM mostra e edita as mesmas (mesmo padrão do RH). Ao mudar,
// todas as tarefas daqui vão para o ERP (com comentários, anexos e
// subtarefas); repetir não duplica. As tabelas daqui ficam guardadas.
export default function TasksErpCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<TasksErpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [withoutPair, setWithoutPair] = useState<string[] | null>(null);

  const load = () => { api.settings.erp.tasks.get().then(setStatus).catch(() => {}); };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); load(); }
    catch (err) { toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const check = () => run(async () => {
    const r = await api.settings.erp.tasks.check();
    setWithoutPair(r.crmUsersWithoutErpUser);
    toast({ title: "Acesso \"Quadro de tarefas\" ok", description: `${r.erpUsers} usuário(s) no ERP.` });
  });

  const move = () => {
    if (!window.confirm(
      "Mudar as tarefas para o ERP? Todas as tarefas daqui (com comentários, anexos e subtarefas) vão para o ERP e, a partir de agora, o quadro do CRM mostra e edita as tarefas de lá. As pessoas são casadas pelo e-mail; quem não tiver usuário no ERP aparece pelo nome. Os lembretes passam a vir do ERP.",
    )) return;
    void run(async () => {
      const r = await api.settings.erp.tasks.move();
      toast({ title: "Tarefas no ERP", description: importSummary(r.report) });
    });
  };

  const again = () => run(async () => {
    const r = await api.settings.erp.tasks.importAgain();
    toast({ title: "Importação conferida", description: importSummary(r.report) });
  });

  const back = () => {
    if (!window.confirm("Voltar a usar as tarefas guardadas no CRM? O que foi criado ou mudado no ERP depois da mudança NÃO volta para cá.")) return;
    void run(() => api.settings.erp.tasks.back());
  };

  if (!status) return null;

  return (
    <div className="shk-card p-5 space-y-3" data-testid="tasks-erp-card">
      <div className="flex items-center gap-2">
        <ListTodo className="w-4 h-4 text-primary" />
        <h3 className="font-bold text-sm text-foreground">Quadro de tarefas no ERP</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Um quadro só para o CRM e o ERP: as tarefas moram no ERP e aparecem aqui do mesmo jeito (responsáveis, comentários, subtarefas e lembretes).
        A chave do ERP precisa do acesso "Quadro de tarefas".
      </p>

      {!status.configured ? (
        <p className="text-xs text-amber-700 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> Cole a chave do ERP no card acima primeiro.</p>
      ) : status.moved ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2 text-xs text-emerald-900">
          <p className="font-semibold flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> Tarefas no ERP desde {status.movedAt ? new Date(status.movedAt).toLocaleDateString("pt-BR") : "—"}.
          </p>
          {status.lastImport && <p className="text-[11px]">Importação: {importSummary(status.lastImport)}.</p>}
          {status.lastImport?.peopleWithoutErpUser?.length ? (
            <p className="text-[11px]">Sem usuário no ERP (ficaram pelo nome): {status.lastImport.peopleWithoutErpUser.join(", ")}. Crie o usuário no ERP com o mesmo e-mail para ligar.</p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {status.erpUrl && (
              <a href={status.erpUrl} target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-[11px] font-semibold">Abrir no ERP</a>
            )}
            <button type="button" onClick={again} disabled={busy} data-testid="button-tasks-erp-import-again"
              className="px-3 py-1.5 rounded-lg border border-emerald-300 text-[11px] font-semibold disabled:opacity-50">
              Conferir importação de novo
            </button>
            <button type="button" onClick={back} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-red-700 hover:underline disabled:opacity-50">
              Voltar para o CRM
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          <p>{status.localTasks} tarefa(s) aqui hoje.</p>
          {withoutPair && withoutPair.length > 0 && (
            <p className="text-[11px] text-amber-800">
              Sem usuário no ERP com o mesmo e-mail (vão aparecer pelo nome): {withoutPair.join(", ")}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={check} disabled={busy} data-testid="button-tasks-erp-check"
              className="px-3 py-1.5 rounded-lg border border-border text-[11px] font-semibold disabled:opacity-50">
              Testar acesso
            </button>
            <button type="button" onClick={move} disabled={busy} data-testid="button-tasks-erp-move"
              className="px-3 py-1.5 rounded-lg bg-primary text-white text-[11px] font-semibold disabled:opacity-50">
              {busy ? "Mudando…" : "Mudar tarefas para o ERP"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
