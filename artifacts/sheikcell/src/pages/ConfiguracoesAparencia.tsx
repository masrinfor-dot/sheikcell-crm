import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { extractDominantColor } from "@/lib/dominantColor";
import { useToast } from "@/hooks/use-toast";
import { Palette, Upload, Trash2, RotateCcw, UserCircle2, Plus } from "lucide-react";

const DEFAULT_COLOR = "#1a2e6e";
const MAX_LOGO_BYTES = 500 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export default function ConfiguracoesAparencia() {
  const { branding, refresh } = useBranding();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [companyName, setCompanyName] = useState("");
  const [primaryColor, setPrimaryColor] = useState(DEFAULT_COLOR);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Item 5 do roadmap de Atendimento: liga/desliga a identificação do
  // vendedor ("*Nome:*") que o cliente vê no WhatsApp. Sem tela própria de
  // configurações gerais ainda — reaproveita esta (única página que já
  // grava em app_settings) em vez de criar uma nova.
  const [showAttendantName, setShowAttendantName] = useState(true);
  const [savingAttendantName, setSavingAttendantName] = useState(false);

  // Motivos do modal "Finalizar atendimento" — editável aqui pelo admin.
  // "Outro" não entra na lista: é sempre a última opção fixa (ver ChatCenter.tsx).
  const [finalizeReasons, setFinalizeReasons] = useState<string[]>([]);
  const [newReason, setNewReason] = useState("");
  const [savingReasons, setSavingReasons] = useState(false);

  useEffect(() => {
    setCompanyName(branding.companyName ?? "");
    setPrimaryColor(branding.primaryColor ?? DEFAULT_COLOR);
    setLogoDataUrl(branding.logoDataUrl);
  }, [branding]);

  useEffect(() => {
    api.settings.get().then((s) => {
      setShowAttendantName(s.attendantNameVisibleToCustomer);
      setFinalizeReasons(s.finalizeReasons);
    }).catch(() => {});
  }, []);

  const handleToggleAttendantName = async (value: boolean) => {
    setShowAttendantName(value);
    setSavingAttendantName(true);
    try {
      await api.settings.update({ attendantNameVisibleToCustomer: value });
      toast({ title: value ? "Cliente volta a ver o nome do vendedor" : "Nome do vendedor não aparece mais pro cliente" });
    } catch (err) {
      setShowAttendantName(!value);
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingAttendantName(false);
    }
  };

  // Só atualiza o estado local — a gravação de verdade é sempre via
  // handleSaveReasons, pra não disparar uma request a cada tecla digitada.
  const addReason = () => {
    const r = newReason.trim().slice(0, 60);
    if (!r || r.toLowerCase() === "outro" || finalizeReasons.includes(r)) return;
    setFinalizeReasons((prev) => [...prev, r]);
    setNewReason("");
  };
  const removeReason = (i: number) => setFinalizeReasons((prev) => prev.filter((_, j) => j !== i));
  const updateReason = (i: number, value: string) =>
    setFinalizeReasons((prev) => prev.map((r, j) => (j === i ? value : r)));

  const handleSaveReasons = async () => {
    setSavingReasons(true);
    try {
      const { finalizeReasons: saved } = await api.settings.finalizeReasons.update(finalizeReasons);
      setFinalizeReasons(saved);
      toast({ title: "Motivos de finalização atualizados!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSavingReasons(false);
    }
  };

  const handleFile = (file: File) => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast({ title: "Formato não suportado", description: "Use PNG, JPG ou WEBP.", variant: "destructive" });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast({ title: "Arquivo muito grande", description: "Envie uma imagem de até 500KB.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      setLogoDataUrl(dataUrl);
      // Sugere a cor principal a partir da logo enviada; o usuário ainda pode
      // ajustar manualmente antes de salvar.
      const dominant = await extractDominantColor(dataUrl);
      if (dominant) setPrimaryColor(dominant);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.settings.branding.update({
        companyName: companyName.trim() || null,
        primaryColor,
        logoDataUrl,
      });
      await refresh();
      toast({ title: "Aparência atualizada!" });
    } catch (err) {
      toast({ title: "Erro ao salvar", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setCompanyName("");
    setPrimaryColor(DEFAULT_COLOR);
    setLogoDataUrl(null);
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="font-bold text-foreground flex items-center gap-2"><Palette className="w-5 h-5" /> Aparência</h2>
        <p className="text-xs text-muted-foreground mt-1">Personalize a logo, o nome e a cor do sistema para esta loja.</p>
      </div>

      <div className="shk-card p-5 space-y-4">
        <div>
          <label className="text-xs font-medium mb-1 block">Logo</label>
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-primary flex items-center justify-center overflow-hidden shrink-0 border border-border">
              {logoDataUrl ? (
                <img src={logoDataUrl} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <Palette className="w-6 h-6 text-white" />
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
              <button type="button" onClick={() => fileRef.current?.click()} data-testid="button-upload-logo"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary transition">
                <Upload className="w-3.5 h-3.5" /> Enviar imagem
              </button>
              {logoDataUrl && (
                <button type="button" onClick={() => setLogoDataUrl(null)} data-testid="button-remove-logo"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 transition">
                  <Trash2 className="w-3.5 h-3.5" /> Remover
                </button>
              )}
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1.5">PNG, JPG ou WEBP, até 500KB.</p>
        </div>

        <div>
          <label className="text-xs font-medium mb-1 block">Nome da empresa</label>
          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Sheikcell" maxLength={80} data-testid="input-company-name"
            className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          <p className="text-[10px] text-muted-foreground mt-1">Aparece ao lado da logo no topo do sistema.</p>
        </div>

        <div>
          <label className="text-xs font-medium mb-1 block">Cor principal</label>
          <div className="flex items-center gap-2">
            <input type="color" value={primaryColor} data-testid="input-primary-color"
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="w-10 h-10 rounded-xl border border-border cursor-pointer" />
            <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
              maxLength={7} data-testid="input-primary-color-hex"
              className="w-28 px-3 py-2 rounded-xl border border-border text-sm font-mono uppercase" />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">Usada em botões, links e destaques em todo o sistema.</p>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={handleReset} data-testid="button-reset-branding"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-secondary transition">
            <RotateCcw className="w-3.5 h-3.5" /> Restaurar padrão
          </button>
          <button type="button" onClick={handleSave} disabled={saving} data-testid="button-save-branding"
            className="ml-auto px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
            {saving ? "Salvando..." : "Salvar alterações"}
          </button>
        </div>
      </div>

      <div>
        <h2 className="font-bold text-foreground flex items-center gap-2"><UserCircle2 className="w-5 h-5" /> Atendimento</h2>
        <p className="text-xs text-muted-foreground mt-1">Como o cliente vê quem está atendendo ele no WhatsApp.</p>
      </div>
      <div className="shk-card p-5">
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span>
            <span className="text-sm font-medium block">Mostrar nome do vendedor pro cliente</span>
            <span className="text-[11px] text-muted-foreground">
              Quando ligado, cada mensagem enviada chega ao cliente como "*Nome do vendedor:*" antes do texto.
              Desligado, o cliente só vê o conteúdo — a identificação continua registrada internamente pro admin/supervisor.
            </span>
          </span>
          <input
            type="checkbox"
            checked={showAttendantName}
            disabled={savingAttendantName}
            onChange={(e) => handleToggleAttendantName(e.target.checked)}
            data-testid="toggle-attendant-name-visible"
            className="w-9 h-5 shrink-0 accent-primary cursor-pointer disabled:opacity-50"
          />
        </label>
      </div>

      <div className="shk-card p-5 space-y-3">
        <div>
          <span className="text-sm font-medium block">Motivos de finalização do atendimento</span>
          <span className="text-[11px] text-muted-foreground">
            Opções que aparecem pro vendedor ao clicar em "Finalizar atendimento". A opção "Outro"
            (com campo de texto livre) sempre aparece por último e não pode ser removida.
          </span>
        </div>
        <div className="space-y-2">
          {finalizeReasons.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={r} onChange={(e) => updateReason(i, e.target.value)}
                maxLength={60} data-testid={`input-finalize-reason-${i}`}
                className="flex-1 px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              <button type="button" onClick={() => removeReason(i)} data-testid={`button-remove-finalize-reason-${i}`}
                className="p-2 rounded-lg text-red-600 hover:bg-red-50 transition shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {finalizeReasons.length === 0 && (
            <p className="text-xs text-muted-foreground">Nenhum motivo cadastrado — adicione pelo menos um abaixo.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input value={newReason} onChange={(e) => setNewReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addReason(); } }}
            placeholder="Novo motivo..." maxLength={60} data-testid="input-new-finalize-reason"
            className="flex-1 px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          <button type="button" onClick={addReason} disabled={!newReason.trim()} data-testid="button-add-finalize-reason"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary transition disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        </div>
        <div className="flex justify-end pt-1">
          <button type="button" onClick={handleSaveReasons} disabled={savingReasons || finalizeReasons.length === 0}
            data-testid="button-save-finalize-reasons"
            className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-50">
            {savingReasons ? "Salvando..." : "Salvar motivos"}
          </button>
        </div>
      </div>
    </div>
  );
}
