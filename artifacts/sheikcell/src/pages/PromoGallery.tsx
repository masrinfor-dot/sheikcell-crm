import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { api, type PromoItem } from "@/lib/api";
import { Image as ImageIcon, Plus, Trash2, Loader2, X, Send } from "lucide-react";

// Banco de Promoções — galeria de fotos/materiais prontos (fotos de aparelho,
// arte de promoção, etc.) pra reenvio rápido no Atendimento. Cadastro é só
// admin/supervisor (pedido explícito do lojista); qualquer vendedor com o
// módulo liberado usa a mesma galeria pra enviar — ver o modo "picker" abaixo,
// usado dentro do compositor de mensagens do Atendimento (ChatCenter.tsx).
//
// Sem props = página de gerenciamento (aba "Banco de Promoções"): grade com
// cadastrar/apagar pra quem pode, visualização pra quem não pode.
// Com onSend = modo seletor (popover do Atendimento): grade compacta com
// botão "Enviar" por item + "Enviar todos", sem controles de cadastro (isso
// fica só na aba de gerenciamento, pra não lotar o popover).
type Props = {
  onSend?: (item: PromoItem) => void | Promise<void>;
  onSendAll?: (items: PromoItem[]) => void | Promise<void>;
  sending?: boolean;
};

export default function PromoGallery({ onSend, onSendAll, sending }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = user?.role === "admin" || user?.role === "supervisor";
  const pickerMode = typeof onSend === "function";

  const [items, setItems] = useState<PromoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingId, setSendingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      setItems(await api.promoGallery.list());
    } catch (err) {
      toast({ title: "Erro ao carregar", description: err instanceof Error ? err.message : "Tente novamente", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function handleAdd() {
    if (!file) { toast({ title: "Escolha uma foto", variant: "destructive" }); return; }
    if (!title.trim()) { toast({ title: "Escreva um título/legenda", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const item = await api.promoGallery.add(title.trim(), file);
      setItems((prev) => [item, ...prev]);
      setShowAdd(false);
      setTitle("");
      setFile(null);
      toast({ title: "Adicionado ao banco de promoções" });
    } catch (err) {
      toast({ title: "Erro ao adicionar", description: err instanceof Error ? err.message : "Tente novamente", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: number) {
    if (!confirm("Apagar este item do banco de promoções?")) return;
    try {
      await api.promoGallery.remove(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      toast({ title: "Erro ao apagar", description: err instanceof Error ? err.message : "Tente novamente", variant: "destructive" });
    }
  }

  async function handleSendOne(item: PromoItem) {
    if (!onSend) return;
    setSendingId(item.id);
    try {
      await onSend(item);
    } finally {
      setSendingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  return (
    <div className={pickerMode ? "" : "p-4 md:p-6"}>
      {!pickerMode && (
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><ImageIcon className="w-5 h-5" /> Banco de Promoções</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {canManage
                ? "Fotos e materiais prontos pra reenvio rápido no Atendimento — vendedores usam a partir da conversa (botão de imagem ao lado do anexo)."
                : "Fotos e materiais disponíveis pra enviar direto de uma conversa no Atendimento."}
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => setShowAdd(true)} data-testid="button-add-promo"
              className="flex items-center gap-1.5 bg-primary text-white text-sm font-medium px-3 py-2 rounded-lg hover:bg-primary/90 transition shrink-0">
              <Plus className="w-4 h-4" /> Adicionar
            </button>
          )}
        </div>
      )}

      {pickerMode && items.length > 0 && onSendAll && (
        <div className="flex justify-end mb-2">
          <button type="button" onClick={() => onSendAll(items)} disabled={!!sending}
            data-testid="button-send-all-promo"
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-border hover:bg-secondary transition disabled:opacity-40">
            <Send className="w-3.5 h-3.5" /> Enviar todos ({items.length})
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          {canManage ? "Nenhum item cadastrado ainda. Clique em \"Adicionar\"." : "Nenhum item disponível ainda."}
        </p>
      ) : (
        <div className={`grid gap-3 ${pickerMode ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"}`}>
          {items.map((item) => (
            <div key={item.id} className="border border-border rounded-xl overflow-hidden bg-white group relative" data-testid={`card-promo-${item.id}`}>
              <img src={api.promoGallery.fileUrl(item.id)} alt={item.title} className="w-full aspect-square object-cover" loading="lazy" />
              <div className="p-2">
                <p className="text-xs font-medium line-clamp-2">{item.title}</p>
              </div>
              {pickerMode && (
                <button type="button" onClick={() => handleSendOne(item)} disabled={sendingId === item.id || !!sending}
                  data-testid={`button-send-promo-${item.id}`}
                  className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 bg-primary/95 text-white text-xs font-medium py-1.5 rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 transition disabled:opacity-60">
                  {sendingId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Enviar
                </button>
              )}
              {!pickerMode && canManage && (
                <button type="button" onClick={() => handleRemove(item.id)} title="Apagar" data-testid={`button-remove-promo-${item.id}`}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-red-600 transition">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !saving && setShowAdd(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Adicionar ao banco de promoções</h3>
              <button type="button" onClick={() => setShowAdd(false)} disabled={saving}><X className="w-4 h-4" /></button>
            </div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Título / legenda</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Promoção iPhone 13 - Agosto"
              data-testid="input-promo-title"
              className="w-full px-3 py-2 rounded-lg border border-border text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-primary/30" />
            <label className="block text-xs font-medium text-muted-foreground mb-1">Foto (JPEG, PNG ou WEBP, até 8MB)</label>
            <input type="file" accept="image/jpeg,image/png,image/webp" data-testid="input-promo-file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm mb-4" />
            <button type="button" onClick={handleAdd} disabled={saving} data-testid="button-save-promo"
              className="w-full bg-primary text-white text-sm font-medium py-2 rounded-lg hover:bg-primary/90 transition disabled:opacity-50 flex items-center justify-center gap-1.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Adicionar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
