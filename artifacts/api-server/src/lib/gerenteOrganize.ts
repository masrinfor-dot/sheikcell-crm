// Gerente IA — "arrumar tarefas": olha as tarefas abertas e propõe uma
// categoria pra quem não tem e um prazo realista pra quem está atrasada ou
// sem prazo, espalhando a carga pelos próximos dias úteis (no máximo
// PER_DAY por dia, sem domingo). Nada muda até o dono aprovar ("sim" no
// WhatsApp ou o botão no link/painel).
import { and, eq, ne, inArray, asc } from "drizzle-orm";
import { db, tasksTable, gerenteTaskMetaTable, gerenteTaskDispatchesTable } from "@workspace/db";
import { norm, spDate, spDateISO, spParts, fmtWhen } from "./gerenteRules";
import { logger } from "./logger";

export type OrganizeItem = {
  taskId: number; title: string; priority: string;
  category?: string | null; oldCategory?: string | null;
  dueAt?: string | null; oldDue?: string | null; reason?: string;
};

const PER_DAY = 4;

// Palavra-chave → categoria (o fallback quando a IA não responde).
const KEYWORDS: [RegExp, string][] = [
  [/\b(loja )?pp\b|ponte preta|avenida/, "Loja PP"],
  [/\b(loja )?sj\b|sao jacinto|s\.? jacinto/, "Loja SJ"],
  [/\b(loja )?sc\b|sao cristovao|cristovao/, "Loja SC"],
  [/atacad|revend|distribuid/, "Atacado"],
  [/pedido|comprar|compra|fornecedor|cotar|cotacao|frontal|lcd|oled|tela|bateria|peca|estoque|mercadoria/, "Compras"],
  [/banco|sicoob|sicredi|pagar|boleto|conta|imposto|contador|financ|cobrar|cobranca|pix|maquininha|taxa|emprestimo|negociar/, "Financeiro"],
  [/sistema|app|crm|erp|site|whatsapp bot|automacao|integra|cadastro no sistema|opcao de/, "Sistema"],
  [/letreiro|lona|banner|instagram|post|video|youtube|marketing|campanha|anuncio|panfleto|adesivo|selo|etiqueta|vitrine/, "Marketing"],
  [/uniforme|funcionari|colaborador|contrat|ferias|treinamento|reuniao de equipe|rh|vale|salario|ponto/, "Equipe/RH"],
  [/curso|toastmaster|cdl|pessoal|medico|academia|familia|casa/, "Pessoal"],
];

export function guessCategory(title: string, description?: string | null): string | null {
  const t = ` ${norm(`${title} ${description ?? ""}`)} `;
  for (const [re, cat] of KEYWORDS) if (re.test(t)) return cat;
  return null;
}

async function aiCategories(tenantId: number, items: { id: number; title: string; description: string | null }[], categories: string[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!items.length) return out;
  try {
    const { getOpenAiClientForTenant } = await import("./aiClient");
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", max_tokens: 1200, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Você organiza tarefas de uma rede de lojas de celular (Sheikcell: lojas PP, SJ e SC, atacado, compras de peças, financeiro, marketing, sistema próprio, RH). Para cada tarefa escolha UMA categoria desta lista: ${categories.join(", ")}. Responda só JSON {"<id>": "<categoria>"}.` },
        { role: "user", content: items.map((i) => `${i.id}: ${i.title}${i.description ? ` — ${i.description.slice(0, 160)}` : ""}`).join("\n") },
      ],
    }, { timeout: 20_000 });
    const j = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
    for (const [k, v] of Object.entries(j)) if (typeof v === "string" && categories.includes(v)) out.set(Number(k), v);
  } catch (err) {
    logger.info({ err: (err as Error).message }, "Gerente IA: categorias pela IA indisponíveis — usando palavras-chave");
  }
  return out;
}

/** Próximos dias úteis (seg–sáb) a partir de amanhã, "YYYY-MM-DD". */
function nextWorkdays(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < n && i < n * 2 + 7; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    if (spParts(d).weekday !== 0) out.push(spDateISO(d));
  }
  return out;
}

export async function buildOrganizePlan(tenantId: number, now: Date = new Date()): Promise<OrganizeItem[]> {
  const { TASK_CATEGORIES } = await import("./gerente");
  const open = await db.select({ id: tasksTable.id, title: tasksTable.title, description: tasksTable.description, priority: tasksTable.priority, dueDate: tasksTable.dueDate })
    .from(tasksTable)
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done")))
    .orderBy(asc(tasksTable.id)).limit(300);
  if (!open.length) return [];
  const metas = await db.select().from(gerenteTaskMetaTable).where(inArray(gerenteTaskMetaTable.taskId, open.map((t) => t.id)));
  const catOf = new Map(metas.map((m) => [m.taskId, m.category]));

  const noCat = open.filter((t) => !catOf.get(t.id));
  const ai = await aiCategories(tenantId, noCat, [...TASK_CATEGORIES]);

  // Carga já marcada nos próximos dias (tarefas com prazo no futuro).
  const days = nextWorkdays(now, 30);
  const load = new Map<string, number>(days.map((d) => [d, 0]));
  for (const t of open) if (t.dueDate && t.dueDate.getTime() >= now.getTime()) {
    const k = spDateISO(t.dueDate); if (load.has(k)) load.set(k, load.get(k)! + 1);
  }
  const startIdx: Record<string, number> = { alta: 0, media: 0, baixa: 2 };
  const prioRank: Record<string, number> = { alta: 0, media: 1, baixa: 2 };
  const toMove = open.filter((t) => !t.dueDate || t.dueDate.getTime() < now.getTime())
    .sort((a, b) => (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1) || (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity));
  const newDue = new Map<number, Date>();
  for (const t of toMove) {
    for (let i = startIdx[t.priority] ?? 0; i < days.length; i++) {
      const d = days[i]!;
      if ((load.get(d) ?? 0) < PER_DAY) {
        load.set(d, (load.get(d) ?? 0) + 1);
        const [y, m, dd] = d.split("-").map(Number);
        newDue.set(t.id, spDate(y!, m!, dd!, 18, 0));
        break;
      }
    }
  }

  const items: OrganizeItem[] = [];
  for (const t of open) {
    const category = catOf.get(t.id) ? null : (ai.get(t.id) ?? guessCategory(t.title, t.description));
    const due = newDue.get(t.id);
    if (!category && !due) continue;
    items.push({
      taskId: t.id, title: t.title, priority: t.priority,
      category: category ?? null, oldCategory: catOf.get(t.id) ?? null,
      dueAt: due ? due.toISOString() : null, oldDue: t.dueDate ? t.dueDate.toISOString() : null,
      reason: due ? (t.dueDate ? "atrasada" : "sem prazo") : undefined,
    });
  }
  return items;
}

export function describePlan(items: OrganizeItem[]): string {
  if (!items.length) return "👌 Suas tarefas já estão organizadas: todas com categoria e prazo em dia.";
  const lines = items.slice(0, 40).map((i) => {
    const parts = [i.category ? `📁 ${i.category}` : null, i.dueAt ? `⏰ ${fmtWhen(new Date(i.dueAt))}${i.reason ? ` (${i.reason})` : ""}` : null].filter(Boolean);
    return `• *${i.taskId}* ${i.title.slice(0, 50)} → ${parts.join(" · ")}`;
  });
  const moved = items.filter((i) => i.dueAt).length, cats = items.filter((i) => i.category).length;
  return [
    `🧹 *Plano pra arrumar suas tarefas* — ${cats} sem categoria, ${moved} com prazo novo (no máx. ${PER_DAY} por dia, sem domingo):`,
    ...lines,
    items.length > 40 ? `…e mais ${items.length - 40}.` : null,
  ].filter(Boolean).join("\n");
}

export async function applyOrganizePlan(tenantId: number, items: OrganizeItem[]): Promise<number> {
  let n = 0;
  for (const i of items) {
    const [t] = await db.select({ id: tasksTable.id }).from(tasksTable)
      .where(and(eq(tasksTable.id, i.taskId), eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done"))).limit(1);
    if (!t) continue;
    if (i.category) {
      await db.insert(gerenteTaskMetaTable).values({ taskId: t.id, tenantId, category: i.category.slice(0, 40) })
        .onConflictDoUpdate({ target: gerenteTaskMetaTable.taskId, set: { category: i.category.slice(0, 40), updatedAt: new Date() } });
    }
    if (i.dueAt) {
      const d = new Date(i.dueAt);
      if (!Number.isNaN(d.getTime())) {
        await db.update(tasksTable).set({ dueDate: d, updatedAt: new Date() }).where(eq(tasksTable.id, t.id));
        // Prazo novo: a cobrança de atraso pode voltar a valer.
        await db.update(gerenteTaskDispatchesTable).set({ overdueNotifiedAt: null }).where(eq(gerenteTaskDispatchesTable.taskId, t.id));
      }
    }
    n++;
  }
  return n;
}

/** Valida itens vindos do navegador (só taskId, categoria e prazo). */
export function sanitizeItems(raw: unknown): OrganizeItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 300).flatMap((r) => {
    const o = r as Record<string, unknown>;
    const taskId = Number(o["taskId"]);
    if (!Number.isInteger(taskId) || taskId <= 0) return [];
    const category = typeof o["category"] === "string" && o["category"].trim() ? o["category"].trim().slice(0, 40) : null;
    const dueAt = typeof o["dueAt"] === "string" && !Number.isNaN(new Date(o["dueAt"]).getTime()) ? new Date(o["dueAt"]).toISOString() : null;
    return category || dueAt ? [{ taskId, title: "", priority: "media", category, dueAt }] : [];
  });
}
