import { useState, useEffect, useCallback, useRef } from "react";
import {
  api,
  type GerenteSettings, type GerenteOverview, type GerenteEvent, type GerenteReminder,
  type GerenteEntry, type GerenteBill, type GerenteMessage, type GerenteScope,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  BrainCircuit, Sun, CalendarDays, Bell, Wallet, MessageCircle, Settings as SettingsIcon,
  Plus, Check, Clock, X, Trash2, Send, RefreshCw, AlertTriangle, Smartphone,
} from "lucide-react";

// Aba "Gerente IA" (admin): secretária executiva por WhatsApp — só mensagens
// do(s) número(s) autorizado(s) (celular pessoal do dono) entram aqui.
// Painel: Meu dia, Agenda, Lembretes, Financeiro, Conversar e Configurações.

const INPUT = "w-full px-3 py-2 rounded-xl border border-border text-sm mt-1 bg-background";
const BTN = "px-3 py-1.5 rounded-lg text-xs font-semibold transition disabled:opacity-40";
const BTN_PRIMARY = `${BTN} bg-primary text-white`;
const BTN_GHOST = `${BTN} border border-border hover:bg-muted`;

type SubTab = "dia" | "agenda" | "lembretes" | "financeiro" | "conversar" | "config";

const brl = (cents: number): string => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDT = (iso: string): string => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtT = (iso: string): string => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const fmtD = (d: string): string => { const [y, m, day] = d.slice(0, 10).split("-"); return `${day}/${m}/${y}`; };
// <input type="datetime-local"> ↔ "YYYY-MM-DDTHH:mm" no fuso de São Paulo (o que a API espera).
const toLocalInput = (iso: string): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return `${p["year"]}-${p["month"]}-${p["day"]}T${p["hour"] === "24" ? "00" : p["hour"]}:${p["minute"]}`;
};
const centsFromInput = (v: string): number => Math.round(Number(v.replace(/\./g, "").replace(",", ".")) * 100);
const fmtPhone = (p: string): string => {
  const d = p.replace(/\D/g, "");
  const local = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return p;
};
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : "Erro");

export default function GerenteIa() {
  const { toast } = useToast();
  const [sub, setSub] = useState<SubTab>("dia");
  const [settings, setSettings] = useState<GerenteSettings | null>(null);

  const loadSettings = useCallback(async () => {
    try { setSettings(await api.gerente.settings.get()); }
    catch (err) { toast({ title: "Erro ao carregar o Gerente IA", description: errMsg(err), variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const tabs: { id: SubTab; label: string; icon: typeof Sun }[] = [
    { id: "dia", label: "Meu dia", icon: Sun },
    { id: "agenda", label: "Agenda", icon: CalendarDays },
    { id: "lembretes", label: "Lembretes", icon: Bell },
    { id: "financeiro", label: "Financeiro", icon: Wallet },
    { id: "conversar", label: "Conversar", icon: MessageCircle },
    { id: "config", label: "Configurações", icon: SettingsIcon },
  ];

  const noPhones = settings && settings.authorizedPhones.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <BrainCircuit className="w-5 h-5 text-primary" /> {settings?.assistantName ?? "Gerente IA"}
        </h2>
        {settings && (
          <span className={`text-[11px] px-2 py-1 rounded-full border ${settings.enabled ? "bg-green-50 text-green-700 border-green-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>
            {settings.enabled ? "Ligado" : "Desligado"} · {settings.authorizedPhones.length} número{settings.authorizedPhones.length === 1 ? "" : "s"} autorizado{settings.authorizedPhones.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {noPhones && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> Nenhum número autorizado — cadastre seu celular pessoal em Configurações para o Gerente IA responder no WhatsApp.
        </p>
      )}

      <div className="flex gap-1 flex-wrap border-b border-border">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setSub(t.id)} data-testid={`gerente-tab-${t.id}`}
            className={`px-3 py-2 text-xs font-semibold flex items-center gap-1.5 border-b-2 -mb-px transition ${sub === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {sub === "dia" && <MeuDia onGo={setSub} />}
      {sub === "agenda" && <Agenda />}
      {sub === "lembretes" && <Lembretes />}
      {sub === "financeiro" && <Financeiro />}
      {sub === "conversar" && <Conversar />}
      {sub === "config" && settings && <Config settings={settings} onSaved={setSettings} />}
    </div>
  );
}

// ─── Meu dia ─────────────────────────────────────────────────────────────────
function MeuDia({ onGo }: { onGo: (t: SubTab) => void }) {
  const { toast } = useToast();
  const [ov, setOv] = useState<GerenteOverview | null>(null);
  const load = useCallback(async () => {
    try { setOv(await api.gerente.overview()); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  if (!ov) return <p className="text-sm text-muted-foreground">Carregando...</p>;

  const sum = (kind: "gasto" | "receita", scope?: GerenteScope) => ov.month.filter((m) => m.kind === kind && (!scope || m.scope === scope)).reduce((s, m) => s + m.total, 0);
  const receitas = sum("receita"), gastos = sum("gasto");

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      <div className="shk-card p-4 space-y-2">
        <h3 className="font-bold text-sm flex items-center gap-2"><CalendarDays className="w-4 h-4 text-primary" /> Compromissos de hoje</h3>
        {ov.events.length === 0 ? <p className="text-xs text-muted-foreground">Nenhum compromisso hoje.</p> : ov.events.map((e) => (
          <div key={e.id} className="text-xs flex gap-2"><span className="font-mono text-muted-foreground w-12">{fmtT(e.startsAt)}</span><span>{e.title}{e.location ? <span className="text-muted-foreground"> · {e.location}</span> : null}</span></div>
        ))}
        <button onClick={() => onGo("agenda")} className="text-[11px] text-primary font-semibold">Ver agenda →</button>
      </div>
      <div className="shk-card p-4 space-y-2">
        <h3 className="font-bold text-sm flex items-center gap-2"><Bell className="w-4 h-4 text-primary" /> Lembretes de hoje</h3>
        {ov.reminders.length === 0 ? <p className="text-xs text-muted-foreground">Nada pendente pra hoje.</p> : ov.reminders.map((r) => (
          <div key={r.id} className="text-xs flex gap-2"><span className="font-mono text-muted-foreground w-12">{fmtT(r.dueAt)}</span><span>{r.title}{r.urgent ? " ‼️" : ""}</span></div>
        ))}
        <button onClick={() => onGo("lembretes")} className="text-[11px] text-primary font-semibold">Ver lembretes →</button>
      </div>
      <div className="shk-card p-4 space-y-2">
        <h3 className="font-bold text-sm flex items-center gap-2"><Wallet className="w-4 h-4 text-primary" /> Financeiro do mês</h3>
        <div className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
          <span className="text-muted-foreground">Receitas</span><span className="text-green-700 font-semibold text-right">{brl(receitas)}</span>
          <span className="text-muted-foreground">Gastos</span><span className="text-red-700 font-semibold text-right">{brl(gastos)}</span>
          <span className="text-muted-foreground">Saldo</span><span className={`font-bold text-right ${receitas - gastos >= 0 ? "text-green-700" : "text-red-700"}`}>{brl(receitas - gastos)}</span>
          <span className="text-muted-foreground">Gastos pessoais</span><span className="text-right">{brl(sum("gasto", "pessoal"))}</span>
        </div>
        {ov.billsDueToday.length > 0 && (
          <div className="text-xs mt-2 space-y-0.5">
            <p className="font-semibold text-amber-700">Contas vencendo/vencidas:</p>
            {ov.billsDueToday.map((b) => <div key={b.id}>• {b.kind === "pagar" ? "pagar" : "receber"} {brl(b.amountCents)} — {b.description} ({fmtD(b.dueDate)})</div>)}
          </div>
        )}
        <button onClick={() => onGo("financeiro")} className="text-[11px] text-primary font-semibold">Ver financeiro →</button>
      </div>
      <div className="shk-card p-4 lg:col-span-3">
        <h3 className="font-bold text-sm mb-2">Resumo como vai no WhatsApp</h3>
        <pre className="text-xs whitespace-pre-wrap font-sans bg-muted/40 rounded-xl p-3">{ov.digest}</pre>
      </div>
    </div>
  );
}

// ─── Agenda ──────────────────────────────────────────────────────────────────
function Agenda() {
  const { toast } = useToast();
  const [rows, setRows] = useState<GerenteEvent[]>([]);
  const [form, setForm] = useState({ title: "", startsAt: "", location: "", participants: "", scope: "empresa" as GerenteScope, remindMinutesBefore: "30" });
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setRows(await api.gerente.events.list(undefined, 60)); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!form.title.trim() || !form.startsAt) { toast({ title: "Título e data/hora são obrigatórios", variant: "destructive" }); return; }
    try {
      await api.gerente.events.create({ title: form.title, startsAt: form.startsAt, location: form.location, participants: form.participants, scope: form.scope, remindMinutesBefore: Number(form.remindMinutesBefore) || 30 });
      setForm({ title: "", startsAt: "", location: "", participants: "", scope: "empresa", remindMinutesBefore: "30" }); setOpen(false); await load();
    } catch (err) { toast({ title: "Erro ao agendar", description: errMsg(err), variant: "destructive" }); }
  };
  const setStatus = async (e: GerenteEvent, status: GerenteEvent["status"]) => {
    try { await api.gerente.events.update(e.id, { status }); await load(); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };

  const active = rows.filter((r) => r.status === "agendado");
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">Próximos 60 dias · {active.length} compromisso{active.length === 1 ? "" : "s"}</p>
        <button onClick={() => setOpen((v) => !v)} className={BTN_PRIMARY} data-testid="gerente-new-event"><Plus className="w-3 h-3 inline mr-1" />Novo</button>
      </div>
      {open && (
        <div className="shk-card p-4 grid md:grid-cols-3 gap-3 text-xs">
          <label className="md:col-span-2">Título<input className={INPUT} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>Quando<input type="datetime-local" className={INPUT} value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></label>
          <label>Local<input className={INPUT} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
          <label>Participantes<input className={INPUT} value={form.participants} onChange={(e) => setForm({ ...form, participants: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label>Âmbito<select className={INPUT} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as GerenteScope })}><option value="empresa">Empresa</option><option value="pessoal">Pessoal</option></select></label>
            <label>Avisar (min antes)<input type="number" className={INPUT} value={form.remindMinutesBefore} onChange={(e) => setForm({ ...form, remindMinutesBefore: e.target.value })} /></label>
          </div>
          <div className="md:col-span-3 flex gap-2 justify-end"><button onClick={() => setOpen(false)} className={BTN_GHOST}>Cancelar</button><button onClick={create} className={BTN_PRIMARY}>Agendar</button></div>
        </div>
      )}
      <div className="shk-card divide-y divide-border">
        {active.length === 0 && <p className="p-4 text-xs text-muted-foreground">Nenhum compromisso agendado.</p>}
        {active.map((e) => (
          <div key={e.id} className="p-3 flex items-center gap-3 text-xs">
            <div className="font-mono text-muted-foreground w-24 shrink-0">{fmtDT(e.startsAt)}</div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{e.title} {e.scope === "pessoal" && <span className="text-[10px] text-muted-foreground font-normal">(pessoal)</span>}</div>
              <div className="text-muted-foreground truncate">{[e.location, e.participants && `com ${e.participants}`].filter(Boolean).join(" · ")}</div>
            </div>
            <button onClick={() => setStatus(e, "concluido")} className={BTN_GHOST} title="Concluído"><Check className="w-3.5 h-3.5" /></button>
            <button onClick={() => setStatus(e, "cancelado")} className={BTN_GHOST} title="Cancelar"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Lembretes ───────────────────────────────────────────────────────────────
function Lembretes() {
  const { toast } = useToast();
  const [rows, setRows] = useState<GerenteReminder[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState({ title: "", dueAt: "", urgent: false });
  const load = useCallback(async () => {
    try { setRows(await api.gerente.reminders.list(showAll)); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  }, [toast, showAll]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!form.title.trim() || !form.dueAt) { toast({ title: "Título e horário são obrigatórios", variant: "destructive" }); return; }
    try { await api.gerente.reminders.create(form); setForm({ title: "", dueAt: "", urgent: false }); await load(); }
    catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };
  const update = async (r: GerenteReminder, data: Parameters<typeof api.gerente.reminders.update>[1]) => {
    try { await api.gerente.reminders.update(r.id, data); await load(); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };
  const snooze = (r: GerenteReminder, minutes: number) => update(r, { dueAt: toLocalInput(new Date(Math.max(Date.now(), new Date(r.dueAt).getTime()) + minutes * 60_000).toISOString()) });

  const STATUS: Record<GerenteReminder["status"], string> = { pendente: "bg-amber-100 text-amber-700", concluido: "bg-green-100 text-green-700", cancelado: "bg-slate-100 text-slate-500" };
  return (
    <div className="space-y-3">
      <div className="shk-card p-4 grid md:grid-cols-4 gap-3 text-xs items-end">
        <label className="md:col-span-2">Lembrar de<input className={INPUT} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="ligar pro contador" /></label>
        <label>Quando<input type="datetime-local" className={INPUT} value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></label>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1"><input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} /> Urgente</label>
          <button onClick={create} className={BTN_PRIMARY} data-testid="gerente-new-reminder"><Plus className="w-3 h-3 inline mr-1" />Criar</button>
        </div>
      </div>
      <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Mostrar concluídos e cancelados</label>
      <div className="shk-card divide-y divide-border">
        {rows.length === 0 && <p className="p-4 text-xs text-muted-foreground">Nenhum lembrete.</p>}
        {rows.map((r) => (
          <div key={r.id} className="p-3 flex items-center gap-3 text-xs">
            <div className="font-mono text-muted-foreground w-24 shrink-0">{fmtDT(r.dueAt)}</div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{r.title}{r.urgent ? " ‼️" : ""}</div>
              <div className="text-muted-foreground"><span className={`px-1.5 py-0.5 rounded ${STATUS[r.status]}`}>{r.status}</span>{r.sentAt ? ` · avisado ${fmtDT(r.sentAt)}` : ""}{r.snoozeCount ? ` · adiado ${r.snoozeCount}x` : ""}</div>
            </div>
            {r.status === "pendente" && (<>
              <button onClick={() => update(r, { status: "concluido" })} className={BTN_GHOST} title="Feito"><Check className="w-3.5 h-3.5" /></button>
              <button onClick={() => snooze(r, 60)} className={BTN_GHOST} title="Adiar 1h"><Clock className="w-3.5 h-3.5" /> 1h</button>
              <button onClick={() => snooze(r, 24 * 60)} className={BTN_GHOST} title="Adiar 1 dia"><Clock className="w-3.5 h-3.5" /> 1d</button>
              <button onClick={() => update(r, { status: "cancelado" })} className={BTN_GHOST} title="Cancelar"><X className="w-3.5 h-3.5" /></button>
            </>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Financeiro ──────────────────────────────────────────────────────────────
function Financeiro() {
  const { toast } = useToast();
  const [month, setMonth] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7));
  const [entries, setEntries] = useState<GerenteEntry[]>([]);
  const [bills, setBills] = useState<GerenteBill[]>([]);
  const [allBills, setAllBills] = useState(false);
  const [ef, setEf] = useState({ kind: "gasto" as "gasto" | "receita", amount: "", description: "", category: "", scope: "empresa" as GerenteScope, paymentMethod: "", entryDate: "" });
  const [bf, setBf] = useState({ kind: "pagar" as "pagar" | "receber", amount: "", description: "", dueDate: "", counterparty: "" });

  const load = useCallback(async () => {
    try {
      const [e, b] = await Promise.all([api.gerente.entries.list(month), api.gerente.bills.list(allBills)]);
      setEntries(e.rows); setBills(b);
    } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  }, [toast, month, allBills]);
  useEffect(() => { void load(); }, [load]);

  const addEntry = async () => {
    const cents = centsFromInput(ef.amount);
    if (!Number.isFinite(cents) || cents <= 0 || !ef.description.trim()) { toast({ title: "Valor e descrição são obrigatórios", variant: "destructive" }); return; }
    try {
      await api.gerente.entries.create({ kind: ef.kind, amountCents: cents, description: ef.description, category: ef.category || undefined, scope: ef.scope, paymentMethod: ef.paymentMethod || undefined, entryDate: ef.entryDate || undefined });
      setEf({ ...ef, amount: "", description: "", category: "" }); await load();
    } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };
  const removeEntry = async (id: number) => {
    try { await api.gerente.entries.remove(id); await load(); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };
  const addBill = async () => {
    const cents = centsFromInput(bf.amount);
    if (!Number.isFinite(cents) || cents <= 0 || !bf.description.trim() || !bf.dueDate) { toast({ title: "Valor, descrição e vencimento são obrigatórios", variant: "destructive" }); return; }
    try {
      await api.gerente.bills.create({ kind: bf.kind, amountCents: cents, description: bf.description, dueDate: bf.dueDate, counterparty: bf.counterparty || undefined });
      setBf({ ...bf, amount: "", description: "", counterparty: "" }); await load();
    } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };
  const setBill = async (b: GerenteBill, status: GerenteBill["status"]) => {
    try { await api.gerente.bills.update(b.id, { status }); await load(); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };

  const total = (kind: "gasto" | "receita") => entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountCents, 0);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const BILL_STATUS: Record<GerenteBill["status"], string> = { aberta: "bg-amber-100 text-amber-700", paga: "bg-green-100 text-green-700", cancelada: "bg-slate-100 text-slate-500" };

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm">Gastos e receitas</h3>
          <input type="month" className="px-2 py-1 rounded-lg border border-border text-xs" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="shk-card p-3 grid grid-cols-3 gap-2 text-xs text-center">
          <div><div className="text-muted-foreground">Receitas</div><div className="font-bold text-green-700">{brl(total("receita"))}</div></div>
          <div><div className="text-muted-foreground">Gastos</div><div className="font-bold text-red-700">{brl(total("gasto"))}</div></div>
          <div><div className="text-muted-foreground">Saldo</div><div className="font-bold">{brl(total("receita") - total("gasto"))}</div></div>
        </div>
        <div className="shk-card p-3 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs items-end">
          <label>Tipo<select className={INPUT} value={ef.kind} onChange={(e) => setEf({ ...ef, kind: e.target.value as "gasto" | "receita" })}><option value="gasto">Gasto</option><option value="receita">Receita</option></select></label>
          <label>Valor (R$)<input className={INPUT} value={ef.amount} onChange={(e) => setEf({ ...ef, amount: e.target.value })} placeholder="0,00" /></label>
          <label>Data<input type="date" className={INPUT} value={ef.entryDate} onChange={(e) => setEf({ ...ef, entryDate: e.target.value })} /></label>
          <label className="md:col-span-2">Descrição<input className={INPUT} value={ef.description} onChange={(e) => setEf({ ...ef, description: e.target.value })} /></label>
          <label>Categoria<input className={INPUT} value={ef.category} onChange={(e) => setEf({ ...ef, category: e.target.value })} /></label>
          <label>Âmbito<select className={INPUT} value={ef.scope} onChange={(e) => setEf({ ...ef, scope: e.target.value as GerenteScope })}><option value="empresa">Empresa</option><option value="pessoal">Pessoal</option></select></label>
          <label>Pagamento<input className={INPUT} value={ef.paymentMethod} onChange={(e) => setEf({ ...ef, paymentMethod: e.target.value })} placeholder="pix, cartão..." /></label>
          <button onClick={addEntry} className={`${BTN_PRIMARY} h-9`} data-testid="gerente-new-entry"><Plus className="w-3 h-3 inline mr-1" />Lançar</button>
        </div>
        <div className="shk-card divide-y divide-border max-h-[420px] overflow-auto">
          {entries.length === 0 && <p className="p-4 text-xs text-muted-foreground">Nenhum lançamento no mês.</p>}
          {entries.map((e) => (
            <div key={e.id} className="p-2.5 flex items-center gap-2 text-xs">
              <span className="font-mono text-muted-foreground w-12 shrink-0">{fmtD(e.entryDate).slice(0, 5)}</span>
              <span className="flex-1 truncate">{e.description}<span className="text-muted-foreground"> · {e.scope}{e.category ? ` · ${e.category}` : ""}{e.paymentMethod ? ` · ${e.paymentMethod}` : ""}{e.installments > 1 ? ` · ${e.installments}x` : ""}{e.reimbursementPending ? " · reembolso" : ""}</span></span>
              <span className={`font-semibold ${e.kind === "gasto" ? "text-red-700" : "text-green-700"}`}>{e.kind === "gasto" ? "-" : "+"}{brl(e.amountCents)}</span>
              <button onClick={() => removeEntry(e.id)} className={BTN_GHOST} title="Excluir"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm">Contas a pagar e receber</h3>
          <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={allBills} onChange={(e) => setAllBills(e.target.checked)} /> Mostrar pagas/canceladas</label>
        </div>
        <div className="shk-card p-3 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs items-end">
          <label>Tipo<select className={INPUT} value={bf.kind} onChange={(e) => setBf({ ...bf, kind: e.target.value as "pagar" | "receber" })}><option value="pagar">A pagar</option><option value="receber">A receber</option></select></label>
          <label>Valor (R$)<input className={INPUT} value={bf.amount} onChange={(e) => setBf({ ...bf, amount: e.target.value })} placeholder="0,00" /></label>
          <label>Vencimento<input type="date" className={INPUT} value={bf.dueDate} onChange={(e) => setBf({ ...bf, dueDate: e.target.value })} /></label>
          <label className="md:col-span-2">Descrição<input className={INPUT} value={bf.description} onChange={(e) => setBf({ ...bf, description: e.target.value })} /></label>
          <label>De quem / para quem<input className={INPUT} value={bf.counterparty} onChange={(e) => setBf({ ...bf, counterparty: e.target.value })} /></label>
          <button onClick={addBill} className={`${BTN_PRIMARY} h-9 md:col-start-3`} data-testid="gerente-new-bill"><Plus className="w-3 h-3 inline mr-1" />Registrar</button>
        </div>
        <div className="shk-card divide-y divide-border max-h-[520px] overflow-auto">
          {bills.length === 0 && <p className="p-4 text-xs text-muted-foreground">Nenhuma conta em aberto.</p>}
          {bills.map((b) => (
            <div key={b.id} className="p-2.5 flex items-center gap-2 text-xs">
              <span className={`font-mono w-12 shrink-0 ${b.status === "aberta" && b.dueDate < today ? "text-red-700 font-bold" : "text-muted-foreground"}`}>{fmtD(b.dueDate).slice(0, 5)}</span>
              <span className="flex-1 truncate">{b.kind === "pagar" ? "📤" : "📥"} {b.description}{b.counterparty ? <span className="text-muted-foreground"> · {b.counterparty}</span> : null} <span className={`px-1.5 py-0.5 rounded ${BILL_STATUS[b.status]}`}>{b.status}</span></span>
              <span className="font-semibold">{brl(b.amountCents)}</span>
              {b.status === "aberta" && (<>
                <button onClick={() => setBill(b, "paga")} className={BTN_GHOST} title="Dar baixa"><Check className="w-3.5 h-3.5" /></button>
                <button onClick={() => setBill(b, "cancelada")} className={BTN_GHOST} title="Cancelar"><X className="w-3.5 h-3.5" /></button>
              </>)}
              {b.status !== "aberta" && allBills && <button onClick={() => setBill(b, "aberta")} className={BTN_GHOST} title="Reabrir"><RefreshCw className="w-3.5 h-3.5" /></button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Conversar (caixa de teste — mesmas frases do WhatsApp) ──────────────────
function Conversar() {
  const { toast } = useToast();
  const [msgs, setMsgs] = useState<GerenteMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try { setMsgs(await api.gerente.messages(120)); } catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setText("");
    try { await api.gerente.chat(t); await load(); }
    catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
    finally { setSending(false); }
  };

  const SRC: Record<GerenteMessage["source"], string> = { whatsapp: "WhatsApp", painel: "painel", sistema: "aviso" };
  return (
    <div className="shk-card flex flex-col" style={{ height: "min(70vh, 640px)" }}>
      <div className="flex items-center justify-between p-3 border-b border-border text-xs">
        <span className="text-muted-foreground">As mesmas frases do WhatsApp funcionam aqui — bom pra testar sem gastar mensagem. Mande <b>ajuda</b> pra ver exemplos.</span>
        <button onClick={load} className={BTN_GHOST} title="Atualizar"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {msgs.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma conversa ainda.</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "in" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-xs whitespace-pre-wrap ${m.direction === "in" ? "bg-primary text-white rounded-br-sm" : "bg-muted rounded-bl-sm"}`}>
              {m.content}
              <div className={`text-[9px] mt-1 ${m.direction === "in" ? "text-white/70" : "text-muted-foreground"}`}>{fmtDT(m.createdAt)} · {SRC[m.source] ?? m.source}{m.intent ? ` · ${m.intent}` : ""}</div>
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="p-3 border-t border-border flex gap-2">
        <input className="flex-1 px-3 py-2 rounded-xl border border-border text-sm bg-background" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Ex.: lembra de ligar pro contador amanhã às 9h" disabled={sending} data-testid="gerente-chat-input" />
        <button onClick={send} disabled={sending || !text.trim()} className={BTN_PRIMARY} data-testid="gerente-chat-send"><Send className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

// ─── Configurações ───────────────────────────────────────────────────────────
function Config({ settings, onSaved }: { settings: GerenteSettings; onSaved: (s: GerenteSettings) => void }) {
  const { toast } = useToast();
  const [s, setS] = useState(settings);
  const [newPhone, setNewPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [wipeText, setWipeText] = useState("");
  useEffect(() => setS(settings), [settings]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.gerente.settings.update({ enabled: s.enabled, assistantName: s.assistantName, authorizedPhones: s.authorizedPhones, quietStart: s.quietStart, quietEnd: s.quietEnd, dailyDigestTime: s.dailyDigestTime });
      onSaved({ ...s, ...updated, lines: s.lines }); toast({ title: "Configurações salvas ✅" });
    } catch (err) { toast({ title: "Erro ao salvar", description: errMsg(err), variant: "destructive" }); }
    finally { setSaving(false); }
  };
  const addPhone = () => {
    const d = newPhone.replace(/\D/g, "");
    if (d.length < 10) { toast({ title: "Número inválido", description: "Use DDD + número, ex.: 33 99140-8604", variant: "destructive" }); return; }
    setS({ ...s, authorizedPhones: [...new Set([...s.authorizedPhones, d])] }); setNewPhone("");
  };
  const wipe = async () => {
    if (wipeText !== "APAGAR") return;
    try { await api.gerente.wipe(); setWipeText(""); toast({ title: "Dados de teste apagados" }); }
    catch (err) { toast({ title: "Erro", description: errMsg(err), variant: "destructive" }); }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start text-xs">
      <div className="shk-card p-4 space-y-3">
        <label className="flex items-center gap-2 font-bold text-sm">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} data-testid="toggle-gerente-enabled" /> Gerente IA ligado
        </label>
        <label>Nome do assistente<input className={INPUT} value={s.assistantName} onChange={(e) => setS({ ...s, assistantName: e.target.value })} /></label>
        <div>
          <p className="font-semibold flex items-center gap-1"><Smartphone className="w-3.5 h-3.5" /> Números autorizados</p>
          <p className="text-[10px] text-muted-foreground">Só mensagens vindas destes celulares (em qualquer linha de WhatsApp da loja) são tratadas pelo Gerente IA. Elas nunca aparecem no Atendimento.</p>
          <div className="mt-2 space-y-1">
            {s.authorizedPhones.map((p) => (
              <div key={p} className="flex items-center justify-between bg-muted/40 rounded-lg px-2 py-1">
                <span className="font-mono">{fmtPhone(p)}</span>
                <button onClick={() => setS({ ...s, authorizedPhones: s.authorizedPhones.filter((x) => x !== p) })} className={BTN_GHOST}><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <input className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs bg-background" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="33 99140-8604" onKeyDown={(e) => { if (e.key === "Enter") addPhone(); }} />
            <button onClick={addPhone} className={BTN_GHOST}><Plus className="w-3 h-3" /></button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label>Descanso: de<input type="time" className={INPUT} value={s.quietStart} onChange={(e) => setS({ ...s, quietStart: e.target.value })} /></label>
          <label>até<input type="time" className={INPUT} value={s.quietEnd} onChange={(e) => setS({ ...s, quietEnd: e.target.value })} /></label>
          <label>Resumo "Meu dia"<input type="time" className={INPUT} value={s.dailyDigestTime ?? ""} onChange={(e) => setS({ ...s, dailyDigestTime: e.target.value || null })} /></label>
        </div>
        <p className="text-[10px] text-muted-foreground">No horário de descanso, só lembretes urgentes são enviados. Deixe o resumo em branco pra desligar.</p>
        <button onClick={save} disabled={saving} className={BTN_PRIMARY} data-testid="button-save-gerente">{saving ? "Salvando..." : "Salvar"}</button>
      </div>
      <div className="space-y-4">
        <div className="shk-card p-4 space-y-2">
          <p className="font-semibold">Por onde os avisos saem</p>
          <p className="text-muted-foreground">Os lembretes voltam pela última linha de WhatsApp por onde você falou com o Gerente IA.</p>
          <p>Última linha: <b>{s.lastSessionKey ? (s.lines.find((l) => l.sessionKey === s.lastSessionKey)?.displayName ?? s.lastSessionKey) : "— mande uma mensagem pelo WhatsApp primeiro"}</b>{s.lastPhone ? ` · do número ${fmtPhone(s.lastPhone)}` : ""}</p>
          {s.lines.length > 0 && (
            <div className="text-muted-foreground">Linhas da loja: {s.lines.map((l) => `${l.displayName ?? l.sessionKey}${l.phoneNumber ? ` (${fmtPhone(l.phoneNumber)})` : ""} — ${l.status}`).join("; ")}</div>
          )}
        </div>
        <div className="shk-card p-4 space-y-2 border-red-200">
          <p className="font-semibold text-red-700">Apagar tudo que testei</p>
          <p className="text-muted-foreground">Remove conversa, lembretes, agenda, lançamentos e contas do Gerente IA desta loja. Tarefas criadas no quadro ficam. Digite APAGAR pra confirmar.</p>
          <div className="flex gap-2">
            <input className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs bg-background" value={wipeText} onChange={(e) => setWipeText(e.target.value)} placeholder="APAGAR" />
            <button onClick={wipe} disabled={wipeText !== "APAGAR"} className={`${BTN} bg-red-600 text-white`}><Trash2 className="w-3 h-3 inline mr-1" />Apagar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
