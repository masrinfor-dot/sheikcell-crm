import { useState, useEffect } from "react";
import { api, type RoutingRule, type Sector, type ClassifyResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  GitFork, Zap, Plus, X, Check, ChevronDown, ChevronUp,
  ToggleLeft, ToggleRight, Trash2, FlaskConical, ArrowRight, Pencil, Save
} from "lucide-react";

const SECTOR_COLORS: Record<number, string> = {
  1: "#1a2e6e",
  2: "#7c3aed",
  3: "#dc2626",
  4: "#059669",
  5: "#6b7280",
};

function priorityLabel(p: number) {
  if (p >= 40) return { label: "Máxima", cls: "bg-red-100 text-red-700" };
  if (p >= 25) return { label: "Alta", cls: "bg-orange-100 text-orange-700" };
  if (p >= 15) return { label: "Média", cls: "bg-amber-100 text-amber-700" };
  return { label: "Baixa", cls: "bg-gray-100 text-gray-600" };
}

// ─── Keyword Tag ────────────────────────────────────────────────────────────
function KeywordTag({ word, onRemove }: { word: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-secondary text-foreground border border-border">
      {word}
      {onRemove && (
        <button onClick={onRemove} className="opacity-50 hover:opacity-100 transition">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

// ─── Rule Card ───────────────────────────────────────────────────────────────
function RuleCard({ rule, sectors, onSave, onDelete }: {
  rule: RoutingRule;
  sectors: Sector[];
  onSave: (id: number, data: Partial<{ keywords: string; isActive: boolean; name: string; priority: number; sectorId: number }>) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editName, setEditName] = useState(rule.name);
  const [editPriority, setEditPriority] = useState(rule.priority);
  const [editSectorId, setEditSectorId] = useState(rule.sectorId);
  const [kws, setKws] = useState(() => rule.keywords.split(",").map((k) => k.trim()).filter(Boolean));
  const [newKw, setNewKw] = useState("");
  const [dirty, setDirty] = useState(false);
  const sector = sectors.find((s) => s.id === rule.sectorId);
  const color = SECTOR_COLORS[rule.sectorId] ?? "#1a2e6e";
  const pri = priorityLabel(rule.priority);

  function addKw() {
    const trimmed = newKw.trim().toLowerCase();
    if (!trimmed || kws.includes(trimmed)) { setNewKw(""); return; }
    const next = [...kws, trimmed];
    setKws(next);
    setNewKw("");
    setDirty(true);
  }

  function removeKw(w: string) {
    setKws(kws.filter((k) => k !== w));
    setDirty(true);
  }

  function handleSave() {
    onSave(rule.id, { name: editName, keywords: kws.join(","), priority: editPriority, sectorId: editSectorId });
    setDirty(false);
  }

  return (
    <div className={`shk-card border-l-4 transition-all ${rule.isActive ? "opacity-100" : "opacity-60"}`}
      style={{ borderLeftColor: color }}>
      {/* Header */}
      <div className="flex items-center gap-3 p-4">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}20` }}>
          <GitFork className="w-4 h-4" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-foreground">{rule.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${pri.cls}`}>{pri.label}</span>
            {!rule.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Inativo</span>}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {sector?.name ?? "Setor #" + rule.sectorId} · {kws.length} palavra{kws.length !== 1 ? "s" : ""}-chave
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { onSave(rule.id, { isActive: !rule.isActive }); }}
            title={rule.isActive ? "Desativar" : "Ativar"}
            className="p-1.5 rounded-lg hover:bg-secondary transition"
          >
            {rule.isActive
              ? <ToggleRight className="w-5 h-5 text-green-500" />
              : <ToggleLeft className="w-5 h-5 text-muted-foreground" />}
          </button>
          <button onClick={() => onDelete(rule.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-500 transition">
            <Trash2 className="w-4 h-4" />
          </button>
          <button onClick={() => setExpanded((v) => !v)} className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Preview keywords (collapsed) */}
      {!expanded && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {kws.slice(0, 8).map((k) => <KeywordTag key={k} word={k} />)}
          {kws.length > 8 && <span className="text-xs text-muted-foreground">+{kws.length - 8} mais</span>}
        </div>
      )}

      {/* Expanded edit */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Nome da Regra</label>
              <input value={editName} onChange={(e) => { setEditName(e.target.value); setDirty(true); }}
                className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Setor de Destino</label>
              <select value={editSectorId} onChange={(e) => { setEditSectorId(Number(e.target.value)); setDirty(true); }}
                className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Prioridade</label>
              <input type="number" min={0} max={100} value={editPriority}
                onChange={(e) => { setEditPriority(Number(e.target.value)); setDirty(true); }}
                className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-2">Palavras-chave (disparadores)</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {kws.map((k) => <KeywordTag key={k} word={k} onRemove={() => removeKw(k)} />)}
            </div>
            <div className="flex gap-2">
              <input
                value={newKw}
                onChange={(e) => setNewKw(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKw(); } }}
                placeholder="Nova palavra-chave..."
                className="flex-1 px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button onClick={addKw} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-semibold hover:bg-primary/90 transition flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Adicionar
              </button>
            </div>
          </div>

          {dirty && (
            <div className="flex justify-end">
              <button onClick={handleSave} className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition">
                <Save className="w-4 h-4" /> Salvar alterações
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Classifier Tester ───────────────────────────────────────────────────────
function ClassifierTester({ sectors }: { sectors: Sector[] }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleTest() {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const r = await api.routing.classify(text);
      setResult(r);
    } catch {
      toast({ title: "Erro ao classificar", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  const resultSector = result?.sectorId ? sectors.find((s) => s.id === result.sectorId) : null;

  return (
    <div className="shk-card p-5 space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center">
          <FlaskConical className="w-4 h-4 text-amber-600" />
        </div>
        <div>
          <h3 className="font-bold text-sm text-foreground">Testar Classificação</h3>
          <p className="text-xs text-muted-foreground">Simule o roteamento de uma mensagem real</p>
        </div>
      </div>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setResult(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") handleTest(); }}
          placeholder='Ex: "Meu iPhone 15 não liga desde ontem..."'
          className="flex-1 px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <button onClick={handleTest} disabled={!text.trim() || loading}
          className="px-4 py-2 bg-primary text-white rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition flex items-center gap-1.5">
          {loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Zap className="w-4 h-4" />}
          Testar
        </button>
      </div>

      {result !== null && (
        <div className={`rounded-xl px-4 py-3 flex items-center gap-3 ${result.sectorId ? "bg-green-50 border border-green-200" : "bg-gray-50 border border-gray-200"}`}>
          {result.sectorId ? (
            <>
              <Check className="w-5 h-5 text-green-600 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-green-800">
                  Encaminhar para: <span style={{ color: SECTOR_COLORS[result.sectorId] ?? "#1a2e6e" }}>{resultSector?.name ?? "Setor #" + result.sectorId}</span>
                </p>
                <p className="text-xs text-green-700 mt-0.5">
                  Regra: <strong>{result.ruleName}</strong> · Gatilho: <code className="bg-green-100 px-1 rounded">{result.matchedKeyword}</code>
                </p>
              </div>
            </>
          ) : (
            <>
              <X className="w-5 h-5 text-gray-400 shrink-0" />
              <p className="text-sm text-gray-500">Nenhuma regra correspondente — será atribuído ao setor padrão.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── New Rule Form ────────────────────────────────────────────────────────────
function NewRuleForm({ sectors, onCreated }: { sectors: Sector[]; onCreated: () => void }) {
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: "", sectorId: 1, keywords: "", priority: 20 });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.keywords) return;
    setSaving(true);
    try {
      await api.routing.create({ ...form, keywords: form.keywords.toLowerCase() });
      toast({ title: "Regra criada!" });
      setShow(false);
      setForm({ name: "", sectorId: 1, keywords: "", priority: 20 });
      onCreated();
    } catch {
      toast({ title: "Erro ao criar regra", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!show) {
    return (
      <button onClick={() => setShow(true)}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-primary transition font-medium">
        <Plus className="w-4 h-4" /> Nova Regra de Distribuição
      </button>
    );
  }

  return (
    <div className="shk-card p-5 border-2 border-primary/30">
      <h3 className="font-bold text-sm mb-4 flex items-center gap-2"><Plus className="w-4 h-4 text-primary" /> Nova Regra</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Nome da Regra</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Ex: Garantia Pós-venda" className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Setor de Destino</label>
            <select value={form.sectorId} onChange={(e) => setForm({ ...form, sectorId: Number(e.target.value) })}
              className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Prioridade (0–100)</label>
            <input type="number" min={0} max={100} value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            Palavras-chave <span className="font-normal">(separadas por vírgula)</span>
          </label>
          <textarea required value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })}
            placeholder="garantia, troca, devolucao, defeito..." rows={2}
            className="w-full px-3 py-1.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none" />
        </div>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={() => setShow(false)} className="px-4 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition">
            Cancelar
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition flex items-center gap-1.5">
            {saving ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Check className="w-4 h-4" />}
            Criar Regra
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function DistribuicaoPanel() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  async function load() {
    try {
      const [r, s] = await Promise.all([api.routing.rules(), api.sectors.list()]);
      setRules((r as RoutingRule[]).sort((a: RoutingRule, b: RoutingRule) => b.priority - a.priority));
      setSectors(s);
    } catch {
      toast({ title: "Erro ao carregar regras", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleSave(id: number, data: Parameters<typeof api.routing.update>[1]) {
    try {
      const updated = await api.routing.update(id, data);
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)).sort((a, b) => b.priority - a.priority));
      toast({ title: "Regra atualizada" });
    } catch {
      toast({ title: "Erro ao salvar", variant: "destructive" });
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Remover esta regra de distribuição?")) return;
    try {
      await api.routing.remove(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
      toast({ title: "Regra removida" });
    } catch {
      toast({ title: "Erro ao remover", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-foreground flex items-center gap-2">
            <GitFork className="w-5 h-5 text-primary" />
            Distribuição Inteligente
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Palavras-chave nas mensagens são usadas para encaminhar automaticamente para o setor correto.
            Regras com maior prioridade são verificadas primeiro.
          </p>
        </div>
      </div>

      {/* Flow diagram */}
      <div className="shk-card p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Fluxo de Distribuição</p>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { label: "Mensagem Chega", icon: "💬", cls: "bg-blue-50 border-blue-200 text-blue-700" },
            { label: "Analisa Keywords", icon: "🔍", cls: "bg-amber-50 border-amber-200 text-amber-700" },
            { label: "Regra com maior prioridade", icon: "⚡", cls: "bg-purple-50 border-purple-200 text-purple-700" },
            { label: "Direciona ao Setor", icon: "🎯", cls: "bg-green-50 border-green-200 text-green-700" },
          ].map((step, i, arr) => (
            <div key={step.label} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${step.cls}`}>
                <span>{step.icon}</span> {step.label}
              </div>
              {i < arr.length - 1 && <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />}
            </div>
          ))}
        </div>
      </div>

      {/* Classifier tester */}
      <ClassifierTester sectors={sectors} />

      {/* Rules list */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Regras Ativas ({rules.filter((r) => r.isActive).length} de {rules.length})
        </p>
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => (
              <RuleCard key={rule.id} rule={rule} sectors={sectors} onSave={handleSave} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      {/* New rule form */}
      <NewRuleForm sectors={sectors} onCreated={load} />
    </div>
  );
}
