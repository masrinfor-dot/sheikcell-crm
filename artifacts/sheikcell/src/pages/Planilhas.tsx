import { useState, useEffect } from "react";
import { api, type SheetLink, type Sector, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Table2, Plus, X, Trash2, Pencil, RefreshCw, ExternalLink, FileSpreadsheet,
} from "lucide-react";

// Aba "Planilhas": planilhas online e formulários (Google Sheets/Forms etc.)
// abertos dentro do sistema. Só o admin gerencia os links.
export default function Planilhas() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = user?.role === "admin";

  const [links, setLinks] = useState<SheetLink[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SheetLink | null>(null);
  const [form, setForm] = useState({ name: "", url: "" });
  const [saving, setSaving] = useState(false);
  // Acesso personalizado (só admin usa)
  const [accSectors, setAccSectors] = useState<number[]>([]);
  const [accUsers, setAccUsers] = useState<number[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [team, setTeam] = useState<User[]>([]);

  useEffect(() => {
    if (!canManage) return;
    api.sectors.list().then(setSectors).catch(() => {});
    api.admin.users.list().then((us) => setTeam(us.filter((u) => u.isActive && u.role !== "admin"))).catch(() => {});
  }, [canManage]);

  const fetchLinks = () => {
    api.sheetLinks.list().then((rows) => {
      setLinks(rows);
      setActiveId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)));
    }).catch(() => {});
  };

  useEffect(() => { fetchLinks(); }, []);

  const active = links.find((l) => l.id === activeId) ?? null;

  const openForm = (l?: SheetLink) => {
    setEditing(l ?? null);
    setForm(l ? { name: l.name, url: l.url } : { name: "", url: "" });
    setAccSectors(l?.allowedSectorIds ?? []);
    setAccUsers(l?.allowedUserIds ?? []);
    setShowForm(true);
  };

  const toggleId = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const handleSave = async () => {
    if (!form.name.trim() || !form.url.trim() || saving) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        allowedSectorIds: accSectors.length > 0 ? accSectors : null,
        allowedUserIds: accUsers.length > 0 ? accUsers : null,
      };
      if (editing) {
        const upd = await api.sheetLinks.update(editing.id, payload);
        setLinks((prev) => prev.map((l) => (l.id === upd.id ? upd : l)));
        if (activeId === upd.id) setIframeKey((k) => k + 1);
      } else {
        const created = await api.sheetLinks.create(payload);
        setLinks((prev) => [...prev, created]);
        setActiveId(created.id);
      }
      setShowForm(false);
      toast({ title: editing ? "Link atualizado" : "Link adicionado" });
    } catch (err) {
      toast({ title: "Erro", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (l: SheetLink) => {
    if (!window.confirm(`Remover "${l.name}" da lista?`)) return;
    try {
      await api.sheetLinks.remove(l.id);
      setLinks((prev) => prev.filter((x) => x.id !== l.id));
      if (activeId === l.id) setActiveId(null);
      toast({ title: "Link removido" });
    } catch {
      toast({ title: "Erro ao remover", variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)] md:h-[calc(100vh-6rem)]">
      {/* Barra de planilhas/formulários */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border border-border rounded-t-2xl overflow-x-auto">
        <Table2 className="w-4 h-4 text-primary shrink-0" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
          {links.length === 0 && (
            <span className="text-xs text-muted-foreground">Nenhuma planilha ou formulário cadastrado ainda.</span>
          )}
          {links.map((l) => (
            <div key={l.id} className="group/link relative shrink-0">
              <button
                onClick={() => { setActiveId(l.id); setIframeKey((k) => k + 1); }}
                data-testid={`sheet-link-${l.id}`}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition whitespace-nowrap ${
                  activeId === l.id
                    ? "bg-primary text-white border-primary"
                    : "bg-white text-muted-foreground border-border hover:bg-secondary"
                } ${canManage ? "pr-9" : ""}`}
              >
                {l.name}
              </button>
              {canManage && (
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden group-hover/link:flex items-center gap-0.5">
                  <button onClick={() => openForm(l)} title="Editar">
                    <Pencil className={`w-3 h-3 ${activeId === l.id ? "text-white/80" : "text-muted-foreground"}`} />
                  </button>
                  <button onClick={() => handleDelete(l)} title="Remover">
                    <Trash2 className={`w-3 h-3 ${activeId === l.id ? "text-white/80" : "text-red-400"}`} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
        {active && (
          <>
            <button onClick={() => setIframeKey((k) => k + 1)} title="Recarregar"
              className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition shrink-0">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <a href={active.url} target="_blank" rel="noopener noreferrer" title="Abrir em nova aba"
              className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition shrink-0">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </>
        )}
        {canManage && (
          <button onClick={() => openForm()} data-testid="button-add-sheet-link"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-primary text-white text-xs font-semibold shrink-0">
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        )}
      </div>

      {/* Planilha/formulário embutido */}
      <div className="flex-1 bg-white border border-t-0 border-border rounded-b-2xl overflow-hidden relative">
        {!active ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
            <FileSpreadsheet className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm font-semibold">Nenhuma planilha selecionada</p>
            <p className="text-xs mt-1 max-w-sm">
              {canManage
                ? 'Clique em "Adicionar" e cole o link de uma planilha online ou formulário (Google Planilhas, Google Forms...). Abre aqui dentro do sistema.'
                : "Peça ao administrador para cadastrar os links das planilhas e formulários."}
            </p>
          </div>
        ) : (
          <>
            <iframe
              key={`${active.id}-${iframeKey}`}
              src={active.url}
              title={active.name}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              referrerPolicy="no-referrer-when-downgrade"
            />
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 text-white text-[10px] px-3 py-1 rounded-full pointer-events-auto">
              Página em branco ou pedindo login?{" "}
              <a href={active.url} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
                abrir em nova aba
              </a>
            </div>
          </>
        )}
      </div>

      {/* Modal adicionar/editar */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="shk-card w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold">{editing ? "Editar link" : "Nova planilha ou formulário"}</h3>
              <button onClick={() => setShowForm(false)}><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ex.: Controle de estoque, Formulário de troca..." data-testid="input-sheet-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Link da planilha ou formulário</label>
                <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://docs.google.com/spreadsheets/..." data-testid="input-sheet-url"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Dica: no Google, use "Compartilhar" e deixe o acesso liberado para quem tem o link, assim a equipe consegue abrir e editar aqui dentro.
                </p>
              </div>
              {/* Acesso personalizado por setor e vendedor */}
              <div className="border-t border-border pt-3">
                <p className="text-xs font-bold mb-1">Quem pode ver esta planilha?</p>
                <p className="text-[11px] text-muted-foreground mb-2">
                  {accSectors.length === 0 && accUsers.length === 0
                    ? "Sem seleção = toda a equipe vê. Marque setores e/ou vendedores para restringir."
                    : "Só quem estiver marcado abaixo vai ver (admins veem sempre)."}
                </p>
                {sectors.length > 0 && (
                  <>
                    <p className="text-[11px] font-semibold text-muted-foreground mb-1">Setores</p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {sectors.map((s) => (
                        <button key={s.id} type="button" onClick={() => setAccSectors((p) => toggleId(p, s.id))}
                          data-testid={`sheet-acc-sector-${s.id}`}
                          className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition ${
                            accSectors.includes(s.id) ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border hover:bg-secondary"
                          }`}>
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {team.length > 0 && (
                  <>
                    <p className="text-[11px] font-semibold text-muted-foreground mb-1">Vendedores / equipe</p>
                    <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                      {team.map((u) => (
                        <button key={u.id} type="button" onClick={() => setAccUsers((p) => toggleId(p, u.id))}
                          data-testid={`sheet-acc-user-${u.id}`}
                          className={`px-2 py-1 rounded-full text-[11px] font-semibold border transition ${
                            accUsers.includes(u.id) ? "bg-primary text-white border-primary" : "bg-white text-muted-foreground border-border hover:bg-secondary"
                          }`}>
                          {u.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold border border-border hover:bg-secondary transition">
                Cancelar
              </button>
              <button onClick={handleSave} disabled={!form.name.trim() || !form.url.trim() || saving}
                data-testid="button-save-sheet-link"
                className="flex-1 px-3 py-2 rounded-xl text-xs font-semibold bg-primary text-white disabled:opacity-40 transition">
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
