import { useCallback, useState } from "react";
import { MessageCircle, X, Maximize2, Headphones, MessagesSquare } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useInternalChatNotifier } from "@/hooks/useInternalChatNotifier";
import { requestChatExpand, useAtendimentoTabVisible } from "@/lib/chatWidgetBus";
import ChatCenter from "@/pages/ChatCenter";
import InternalChat from "@/pages/InternalChat";

type WidgetTab = "atendimento" | "equipe";

// Balão flutuante estilo Instagram/Messenger, visível em qualquer tela do
// app (montado uma vez na raiz, em App.tsx). As duas abas são o
// ChatCenter/InternalChat reais em modo `docked` — mesma lógica/dados da
// Central de Atendimento e do Chat interno completos, só que num painel
// compacto. Os dois ficam SEMPRE montados (só a visibilidade do container
// muda via CSS, nunca desmonta), pra:
//   1) os badges de não lidas continuarem contando com o painel fechado;
//   2) trocar de aba não perder o que estava aberto (sem refetch/flash).
// Mesmo truque que o ChatCenter já usa hoje dentro dos dashboards pro
// alarme de "sem resposta" funcionar com a aba escondida.
export default function GlobalChatWidget() {
  const { user } = useAuth();
  const canEquipe = user?.role === "admin"
    || ((user?.enabledModules == null || user.enabledModules.includes("equipe"))
      && user?.moduleAccess != null && "equipe" in user.moduleAccess);
  const [open, setOpen] = useState(false);
  // Dentro da própria tela de Atendimento OU de Chat Interno, o balão some
  // por completo — as duas já têm acesso direto ao que ele ofereceria (o
  // Atendimento e o Chat Interno de verdade, sem precisar do painel
  // compacto), então ele só ficava sobrando/atrapalhando ali. Nas outras
  // abas (Dashboard, CRM, Relatórios etc.) ele continua aparecendo normal.
  const insideAtendimento = useAtendimentoTabVisible();
  const hideBubble = insideAtendimento;
  const [activeTab, setActiveTab] = useState<WidgetTab>("atendimento");
  // Sem permissão de chat interno, o widget só tem a aba Atendimento. Dentro
  // da própria tela de Atendimento, força a aba Equipe (a de Atendimento
  // ficaria redundante ali).
  const effectiveTab: WidgetTab = !canEquipe ? "atendimento" : insideAtendimento ? "equipe" : activeTab;
  const panelPos = insideAtendimento ? "top-1/2 -translate-y-1/2 right-4 md:right-6" : "bottom-24 right-4 md:right-6";
  const buttonPos = insideAtendimento ? "top-1/2 -translate-y-1/2 right-4 md:right-6" : "bottom-20 right-4 md:bottom-6 md:right-6";

  const [atendimentoUnread, setAtendimentoUnread] = useState(0);
  const [atendimentoActiveId, setAtendimentoActiveId] = useState<number | null>(null);
  const [equipeActiveId, setEquipeActiveId] = useState<number | null>(null);
  // O InternalChat (docked, sempre montado abaixo) já publica sua contagem
  // de não lidas no store compartilhado — o mesmo que o badge do menu
  // lateral usa. Só assina aqui (enabled=false pula a parte de rede do
  // hook: não abre mais uma conexão SSE nem pede permissão de notificação).
  const equipeUnread = useInternalChatNotifier(user?.id, false, false);

  const handleAtendimentoUnread = useCallback((n: number) => setAtendimentoUnread(n), []);
  const handleAtendimentoActive = useCallback((id: number | null) => setAtendimentoActiveId(id), []);
  const handleEquipeActive = useCallback((id: number | null) => setEquipeActiveId(id), []);

  const totalUnread = atendimentoUnread + equipeUnread;

  const handleExpand = () => {
    const conversationId = effectiveTab === "atendimento" ? atendimentoActiveId : equipeActiveId;
    requestChatExpand(effectiveTab, conversationId);
    setOpen(false);
  };

  return (
    <>
      <div
        className={`fixed z-40 ${panelPos} w-[calc(100vw-2rem)] max-w-[380px] h-[min(560px,calc(var(--vvh,100vh)-8rem))] bg-white rounded-2xl shadow-2xl border border-border flex-col overflow-hidden ${open && !hideBubble ? "flex" : "hidden"}`}
        data-testid="panel-global-chat-widget"
      >
        <div className="flex items-center shrink-0 border-b border-border bg-white">
          {!insideAtendimento && (
          <button
            onClick={() => setActiveTab("atendimento")}
            data-testid="tab-widget-atendimento"
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition ${
              effectiveTab === "atendimento" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Headphones className="w-3.5 h-3.5" /> Atendimento
            {atendimentoUnread > 0 && (
              <span className="text-[10px] font-bold bg-red-500 text-white rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">{atendimentoUnread}</span>
            )}
          </button>
          )}
          {canEquipe && (
            <button
              onClick={() => setActiveTab("equipe")}
              data-testid="tab-widget-equipe"
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition ${
                effectiveTab === "equipe" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <MessagesSquare className="w-3.5 h-3.5" /> Equipe
              {equipeUnread > 0 && (
                <span className="text-[10px] font-bold bg-red-500 text-white rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">{equipeUnread}</span>
              )}
            </button>
          )}
          <button onClick={handleExpand} title="Abrir em tela cheia" data-testid="button-widget-expand"
            className="p-2.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition shrink-0">
            <Maximize2 className="w-4 h-4" />
          </button>
          <button onClick={() => setOpen(false)} title="Fechar" data-testid="button-widget-close"
            className="p-2.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`flex-1 min-h-0 ${effectiveTab === "atendimento" ? "flex flex-col" : "hidden"}`}>
          <ChatCenter docked onUnreadChange={handleAtendimentoUnread} onActiveConversationChange={handleAtendimentoActive} />
        </div>
        {canEquipe && (
          <div className={`flex-1 min-h-0 ${effectiveTab === "equipe" ? "flex flex-col" : "hidden"}`}>
            <InternalChat docked onActiveConversationChange={handleEquipeActive} />
          </div>
        )}
      </div>

      {!hideBubble && (
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="button-global-chat-widget"
        title={insideAtendimento ? "Chat interno" : "Chat"}
        className={`fixed z-40 ${buttonPos} w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-2xl flex items-center justify-center hover:scale-105 active:scale-95 transition`}
      >
        {open ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
        {!open && totalUnread > 0 && (
          <span className="absolute -top-1 -right-1 text-[11px] font-bold bg-red-500 text-white rounded-full min-w-[20px] h-5 px-1 flex items-center justify-center border-2 border-white">
            {totalUnread > 99 ? "99+" : totalUnread}
          </span>
        )}
      </button>
      )}
    </>
  );
}
