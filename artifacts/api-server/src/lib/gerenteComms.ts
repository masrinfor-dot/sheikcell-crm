// Gerente IA → equipe: o dono direciona recados e encaminha o que acabou de
// mandar (contato, foto, documento, áudio transcrito, texto) para uma pessoa,
// várias, ou "todos da loja SC". Também monta o status da equipe ("como está
// a equipe?") e entende apelidos ("Lu" = Lucelia, "Gabi" = Gabrielly,
// "Cris" = Christian).
import { and, eq, ne, desc, lt, gte, asc } from "drizzle-orm";
import {
  db, usersTable, storesTable, gerenteMessagesTable, tasksTable, taskAssigneesTable, gerenteTaskDispatchesTable,
} from "@workspace/db";
import { norm } from "./gerenteRules";
import { logger } from "./logger";

export type Person = { id: number; name: string; storeId: number | null; storeName?: string | null };

/** Forma canônica pra comparar nomes: sem acento, ch→c, y→i, ph→f. */
function canonName(s: string): string {
  return norm(s).replace(/ph/g, "f").replace(/ch/g, "c").replace(/y/g, "i").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

export async function teamPeople(tenantId: number): Promise<Person[]> {
  return db.select({ id: usersTable.id, name: usersTable.name, storeId: usersTable.storeId, storeName: usersTable.storeName }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), ne(usersTable.role, "superadmin"), ne(usersTable.role, "admin")))
    .orderBy(asc(usersTable.name));
}

/** Acha uma pessoa por nome, sobrenome ou apelido. null se não achar ou ambíguo. */
export function matchPerson(people: Person[], raw: string): Person | null {
  const q = canonName(raw).replace(/^(o|a|os|as) /, "");
  if (q.length < 2) return null;
  const full = people.filter((p) => canonName(p.name) === q);
  if (full.length === 1) return full[0]!;
  const words = (p: Person) => canonName(p.name).split(" ").filter(Boolean);
  const byWord = people.filter((p) => words(p).includes(q));
  if (byWord.length === 1) return byWord[0]!;
  const prefix = people.filter((p) => (words(p)[0] ?? "").startsWith(q));
  if (prefix.length === 1) return prefix[0]!;
  // Apelido: mesmas 3 primeiras letras do primeiro nome ("gabi" ≈ "gabrielly").
  if (q.length >= 3) {
    const nick = people.filter((p) => (words(p)[0] ?? "").slice(0, 3) === q.slice(0, 3));
    if (nick.length === 1) return nick[0]!;
  }
  return null;
}

/** Iniciais e nome da loja ("São Cristóvão" → sc / sao cristovao). */
function storeKeys(name: string): string[] {
  const n = canonName(name).replace(/^loja /, "");
  const initials = n.split(" ").filter((w) => !["de", "da", "do", "das", "dos", "e"].includes(w)).map((w) => w[0]).join("");
  return [n, initials, `loja ${n}`, `loja ${initials}`];
}

export async function resolveRecipients(tenantId: number, names: string[], loja: string | null): Promise<{ people: Person[]; notFound: string[]; storeName: string | null }> {
  const people = await teamPeople(tenantId);
  const out = new Map<number, Person>();
  const notFound: string[] = [];
  let storeName: string | null = null;
  const wantsAll = names.some((n) => /^(todos|todo mundo|equipe|a equipe|geral|pessoal)$/.test(norm(n)));
  if (wantsAll && !loja) for (const p of people) out.set(p.id, p);
  if (loja) {
    const stores = await db.select({ id: storesTable.id, name: storesTable.name }).from(storesTable)
      .where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.isActive, true)));
    const q = canonName(loja).replace(/^(os meninos|as meninas|o pessoal|a equipe|todos) (de|da|do) /, "").replace(/^loja /, "");
    const st = stores.find((s) => storeKeys(s.name).includes(q) || storeKeys(s.name).includes(`loja ${q}`))
      ?? (stores.filter((s) => canonName(s.name).includes(q)).length === 1 ? stores.find((s) => canonName(s.name).includes(q)) : undefined);
    if (st) {
      storeName = st.name;
      const sc = canonName(st.name).replace(/^loja /, "");
      for (const p of people) {
        const uc = canonName(p.storeName ?? "").replace(/^loja /, "");
        if (p.storeId === st.id || (uc && (uc.startsWith(sc) || sc.startsWith(uc)))) out.set(p.id, p);
      }
    } else notFound.push(`loja ${loja}`);
  }
  for (const n of names) {
    if (/^(todos|todo mundo|equipe|a equipe|geral|pessoal)$/.test(norm(n))) continue;
    const p = matchPerson(people, n);
    if (p) out.set(p.id, p); else notFound.push(n);
  }
  return { people: [...out.values()], notFound, storeName };
}

export type OwnerItem = { id: number; content: string; mediaUrl: string | null; msgType: string | null };

/**
 * O "isso" do dono: a mensagem dele imediatamente anterior (até 30 min) —
 * contato, foto, documento, áudio transcrito ou texto. Se a mensagem atual
 * tem anexo, é ela mesma.
 */
export async function ownerItem(tenantId: number, phone: string, currentId: number, includeCurrent: boolean): Promise<OwnerItem | null> {
  const since = new Date(Date.now() - 30 * 60_000);
  const rows = await db.select({ id: gerenteMessagesTable.id, content: gerenteMessagesTable.content, payload: gerenteMessagesTable.payload })
    .from(gerenteMessagesTable)
    .where(and(eq(gerenteMessagesTable.tenantId, tenantId), eq(gerenteMessagesTable.phone, phone), eq(gerenteMessagesTable.direction, "in"),
      includeCurrent ? lt(gerenteMessagesTable.id, currentId + 1) : lt(gerenteMessagesTable.id, currentId), gte(gerenteMessagesTable.createdAt, since)))
    .orderBy(desc(gerenteMessagesTable.id)).limit(3);
  for (const r of rows) {
    const p = (r.payload ?? {}) as { mediaUrl?: string | null; msgType?: string | null };
    if (r.id === currentId && !p.mediaUrl && p.msgType !== "contact" && p.msgType !== "location") continue;
    return { id: r.id, content: r.content.replace(/^🎵\s*/, ""), mediaUrl: p.mediaUrl ?? null, msgType: p.msgType ?? null };
  }
  return null;
}

async function ownerFirst(tenantId: number): Promise<string> {
  const [u] = await db.select({ name: usersTable.name }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin"))).orderBy(asc(usersTable.id)).limit(1);
  return u?.name.trim().split(" ")[0] ?? "Gestor";
}

/**
 * Manda o recado (e o item encaminhado, se houver) pra cada pessoa.
 * Devolve a resposta pro dono: pra quem foi, quem não tem WhatsApp, quem não achei.
 */
export async function sendToTeam(tenantId: number, p: { names: string[]; loja: string | null; message: string | null; item: OwnerItem | null }): Promise<string> {
  const { people, notFound, storeName } = await resolveRecipients(tenantId, p.names, p.loja);
  if (!people.length) {
    return notFound.length ? `Não achei ${notFound.map((n) => `*${n}*`).join(", ")} na equipe. Quem é? (mande o nome como está no cadastro)` : "Pra quem eu mando? Diga o nome (ex.: *manda pro Alan*) ou a loja (*manda pra loja SC*).";
  }
  if (!p.message && !p.item) return "O que eu mando? Escreva o recado ou mande o contato/foto antes.";
  const { currentActor } = await import("./gerente");
  const actor = currentActor();
  const owner = actor?.role === "gestor" ? actor.name.split(" ")[0]! : await ownerFirst(tenantId);
  const { sendToTeamMember, sendRawWhatsAppMediaToTeam } = await import("./gerenteDispatch");
  const ok: string[] = [], fail: string[] = [];
  const itemText = p.item && !p.item.mediaUrl ? p.item.content : null;
  const text = [`📣 *${owner}:*${p.message ? ` ${p.message}` : ""}`, itemText && itemText !== p.message ? itemText : null].filter(Boolean).join("\n");
  // Recado pra loja: uma mensagem na sala da loja (chat interno) em vez de uma por pessoa.
  let storeChat = false;
  if (storeName) {
    const { postToStore } = await import("./gerenteInternal");
    storeChat = await postToStore(tenantId, storeName, people.map((x) => x.id), text, p.item?.mediaUrl ? { url: p.item.mediaUrl, type: p.item.msgType === "image" ? "image" : "doc" } : null);
  }
  for (const person of people) {
    try {
      let sent = (await sendToTeamMember(tenantId, person.id, text, { chat: !storeName })) || storeChat;
      if (sent && p.item?.mediaUrl) sent = await sendRawWhatsAppMediaToTeam(tenantId, person.id, p.item.mediaUrl, p.message ? null : `📎 Enviado por ${owner}`);
      (sent ? ok : fail).push(person.name.trim().split(" ")[0]!);
    } catch (err) {
      logger.warn({ err, tenantId }, "Gerente IA: falha ao mandar recado pra equipe");
      fail.push(person.name.trim().split(" ")[0]!);
    }
  }
  const what = p.item?.mediaUrl ? (p.item.msgType === "image" ? "a foto" : "o arquivo") : p.item?.msgType === "contact" ? "o contato" : "o recado";
  return [
    ok.length ? `📲 Mandei ${what} pra *${ok.join(", ")}*${storeName ? ` (${storeName})` : ""}.` : null,
    fail.length ? `⚠️ Sem WhatsApp cadastrado: ${fail.join(", ")} (Gerente IA → Configurações → Equipe no WhatsApp).` : null,
    notFound.length ? `❓ Não achei: ${notFound.join(", ")}.` : null,
  ].filter(Boolean).join("\n");
}

/** "Como está a equipe?" — abertas, atrasadas e foto pendente por pessoa. */
export async function teamStatus(tenantId: number): Promise<string> {
  const rows = await db.select({ userId: usersTable.id, name: usersTable.name, role: usersTable.role, taskId: tasksTable.id, dueDate: tasksTable.dueDate })
    .from(taskAssigneesTable)
    .innerJoin(tasksTable, eq(tasksTable.id, taskAssigneesTable.taskId))
    .innerJoin(usersTable, eq(usersTable.id, taskAssigneesTable.userId))
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done")));
  const waiting = await db.select({ userId: gerenteTaskDispatchesTable.userId }).from(gerenteTaskDispatchesTable)
    .innerJoin(tasksTable, eq(tasksTable.id, gerenteTaskDispatchesTable.taskId))
    .where(and(eq(gerenteTaskDispatchesTable.tenantId, tenantId), eq(gerenteTaskDispatchesTable.status, "aguardando_prova"), ne(tasksTable.status, "done")));
  const since = new Date(Date.now() - 7 * 86_400_000);
  const done = await db.select({ userId: taskAssigneesTable.userId }).from(taskAssigneesTable)
    .innerJoin(tasksTable, eq(tasksTable.id, taskAssigneesTable.taskId))
    .where(and(eq(tasksTable.tenantId, tenantId), eq(tasksTable.status, "done"), gte(tasksTable.updatedAt, since)));
  const now = Date.now();
  const m = new Map<number, { name: string; owner: boolean; open: number; late: number; wait: number; done: number }>();
  for (const r of rows) {
    const e = m.get(r.userId) ?? { name: r.name.trim(), owner: r.role === "admin", open: 0, late: 0, wait: 0, done: 0 };
    e.open++; if (r.dueDate && r.dueDate.getTime() < now) e.late++;
    m.set(r.userId, e);
  }
  for (const w of waiting) { const e = m.get(w.userId); if (e) e.wait++; }
  for (const d of done) { const e = m.get(d.userId); if (e) e.done++; }
  const list = [...m.values()].sort((a, b) => Number(a.owner) - Number(b.owner) || b.late - a.late || b.open - a.open);
  if (!list.length) return "👥 Ninguém da equipe com tarefa aberta.";
  return [
    "👥 *Equipe agora*",
    ...list.map((e) => `• ${e.owner ? `${e.name.split(" ")[0]} (você)` : e.name.split(" ")[0]} — ${e.open} aberta(s)${e.late ? ` · ⚠️ ${e.late} atrasada(s)` : ""}${e.wait ? ` · 📸 ${e.wait} aguardando foto` : ""}${e.done ? ` · ✅ ${e.done} na semana` : ""}`),
  ].join("\n");
}


export function parseTargets(raw: string): { names: string[]; loja: string | null } {
  const t = raw.trim().replace(/[.!?]+$/, "").replace(/,?\s*(por favor|pf|pfv|a[ií])$/i, "").trim();
  if (/\b(loja|meninos|meninas|pessoal|galera|povo|equipe)\b/i.test(t)) {
    const loja = t.replace(/^(?:todos|todo mundo|os|as|o|a)?\s*(?:meninos|meninas|pessoal|galera|equipe|povo)?\s*(?:d[aeo]s?\s+)?(?:loja\s+(?:d[aeo]\s+)?)?/i, "").trim();
    if (loja) return { names: [], loja };
  }
  return { names: t.split(/\s*,\s*|\s+e\s+/).map((x) => x.trim().replace(/^(o|a)\s+/i, "")).filter(Boolean), loja: null };
}

/**
 * Atalhos sem IA (rápidos e previsíveis):
 *   "manda isso pro Alan", "encaminha esse contato pra loja SC", "manda pros meninos de SC"
 *   "avisa a Lu que o cliente chega às 15h", "fala pro Alan e Davi: reunião 18h"
 * Se nenhum destinatário bater com a equipe, devolve null (a IA tenta).
 */
export async function tryDirectCommand(tenantId: number, phone: string, inMessageId: number, text: string): Promise<string | null> {
  const t = text.replace(/\s+/g, " ").trim();
  const fwd = t.match(/^(?:manda|mande|mandar|encaminha|encaminhe|encaminhar|envia|envie|enviar|passa|passe)\s+(?:(?:isso|isto|esse|essa|este|esta)(?:\s+(?:contato|foto|arquivo|n[uú]mero|[aá]udio|documento|pdf|imagem|print|endere[cç]o|localiza[cç][aã]o))?\s+)?(?:a[ií]\s+)?(?:pros|pras|pro|pra|para(?:\s+(?:os|as|o|a))?)\b\s*(.+)$/i);
  const say = t.match(/^(?:avisa|avise|avisar|fala|fale|falar|diz|diga|dizer|informa|informe|lembra|lembre)\s+(?:(?:pros|pras|pro|pra|para(?:\s+(?:os|as|o|a))?|aos|ao|à|os|as|o|a)\b)?\s*(.+?)\s*(?::|,|\s+que\s+|\s+pra\s+(?=[a-zà-ú]+r\b))\s*(.+)$/i);
  let targets: { names: string[]; loja: string | null } | null = null;
  let message: string | null = null;
  let forward = false;
  if (say) {
    targets = parseTargets(say[1]!);
    message = say[2]!.trim();
    if (/^lembr/i.test(t)) message = `Lembrete: ${message}`;
  } else if (fwd) {
    // "manda pro Alan: texto" → recado; "manda isso pro Alan" → encaminha.
    const rest = fwd[1]!;
    const split = rest.match(/^(.+?)\s*:\s*(.+)$/);
    targets = parseTargets(split ? split[1]! : rest);
    message = split ? split[2]!.trim() : null;
    forward = !split;
  }
  if (!targets) return null;
  const { people } = await resolveRecipients(tenantId, targets.names, targets.loja);
  if (!people.length) return null;
  const item = await ownerItem(tenantId, phone, inMessageId, true);
  const useItem = forward ? item : item && item.id === inMessageId ? item : null;
  if (forward && !useItem) return "O que eu mando? Não achei nada seu nos últimos 30 min. Mande o contato/foto/texto e depois *manda pro …*.";
  return sendToTeam(tenantId, { names: targets.names, loja: targets.loja, message, item: useItem });
}
