// Gerente IA dentro do chat interno do CRM.
//
//   🤖 Gerente IA          — sala do dono com o bot: ele escreve ali como no
//                            WhatsApp ("tarefa pro Alan…", "avisa a loja SC…",
//                            "resumo") e o Gerente responde ali. Também
//                            espelha a conversa do WhatsApp e os avisos.
//   📋 Gerente · <Pessoa>  — dono + pessoa + bot: tarefas e recados chegam
//                            aqui também (mesmo pra quem não tem WhatsApp); a
//                            pessoa responde 1/2/3, "feito" ou manda a foto.
//   📣 Gerente · <Loja>    — dono + todos da loja + bot: recados pra loja.
//
// O bot é um usuário INATIVO (não faz login, não aparece nas listas da
// equipe) que só existe pra assinar as mensagens.
import { randomBytes } from "node:crypto";
import { and, eq, asc, inArray, desc, ne, gte, lt, isNull } from "drizzle-orm";
import {
  db, usersTable, storesTable, internalConversationsTable, internalConversationMembersTable, internalMessagesTable,
  gerenteChatRoomsTable, gerenteSettingsTable, gerenteChatFollowupsTable, tasksTable, taskAssigneesTable, gerenteTaskDispatchesTable, gerenteMembersTable,
} from "@workspace/db";
import { broadcastInternal } from "./sseEmitter";
import { norm } from "./gerenteRules";
import { logger } from "./logger";

const BOT_NAME = "🤖 Gerente IA";
const botCache = new Map<number, number>();

async function enabled(tenantId: number): Promise<boolean> {
  const [s] = await db.select({ on: gerenteSettingsTable.internalChatEnabled, enabled: gerenteSettingsTable.enabled })
    .from(gerenteSettingsTable).where(eq(gerenteSettingsTable.tenantId, tenantId)).limit(1);
  return !!s && s.enabled && s.on;
}

export async function botUserId(tenantId: number): Promise<number> {
  const hit = botCache.get(tenantId);
  if (hit) return hit;
  const email = `gerente-ia+${tenantId}@bot.sheikcell.local`;
  const [found] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  let id = found?.id;
  if (!id) {
    const [u] = await db.insert(usersTable).values({
      tenantId, name: BOT_NAME, email, passwordHash: `!bot-${randomBytes(16).toString("hex")}`, role: "vendedor", isActive: false,
    }).onConflictDoNothing().returning({ id: usersTable.id });
    id = u?.id ?? (await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1))[0]?.id;
  }
  if (!id) throw new Error("Gerente IA: não consegui criar o usuário do bot");
  botCache.set(tenantId, id);
  return id;
}

async function ownerId(tenantId: number): Promise<number | null> {
  const [u] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true), eq(usersTable.role, "admin"))).orderBy(asc(usersTable.id)).limit(1);
  return u?.id ?? null;
}

/** Acha ou cria a sala; garante que todos os membros estão nela. */
async function ensureRoom(tenantId: number, kind: "gerente" | "pessoa" | "loja", refId: number, name: string, memberIds: number[]): Promise<number> {
  const bot = await botUserId(tenantId);
  const members = [...new Set([...memberIds, bot])];
  const [room] = await db.select().from(gerenteChatRoomsTable)
    .where(and(eq(gerenteChatRoomsTable.tenantId, tenantId), eq(gerenteChatRoomsTable.kind, kind), eq(gerenteChatRoomsTable.refId, refId))).limit(1);
  let convId: number | null = room?.conversationId ?? null;
  if (convId) {
    const [c] = await db.select({ id: internalConversationsTable.id }).from(internalConversationsTable).where(eq(internalConversationsTable.id, convId)).limit(1);
    if (!c) { await db.delete(gerenteChatRoomsTable).where(eq(gerenteChatRoomsTable.id, room!.id)); convId = null; }
  }
  if (!convId) {
    const [created] = await db.insert(internalConversationsTable).values({ tenantId, kind: "group", name: name.slice(0, 80) }).returning();
    convId = created!.id;
    const [r] = await db.insert(gerenteChatRoomsTable).values({ tenantId, kind, refId, conversationId: convId }).onConflictDoNothing().returning();
    if (!r) {
      // Corrida: outra chamada criou ao mesmo tempo — usa a dela e descarta a nossa.
      await db.delete(internalConversationsTable).where(eq(internalConversationsTable.id, convId));
      const [other] = await db.select().from(gerenteChatRoomsTable)
        .where(and(eq(gerenteChatRoomsTable.tenantId, tenantId), eq(gerenteChatRoomsTable.kind, kind), eq(gerenteChatRoomsTable.refId, refId))).limit(1);
      convId = other!.conversationId;
    } else {
      await db.insert(internalConversationMembersTable).values(members.map((userId) => ({ tenantId, conversationId: convId!, userId }))).onConflictDoNothing();
      broadcastInternal("internal_conversation_new", {
        id: convId, kind: "group", name, otherUser: null, lastMessage: null, lastMessageAt: null, unreadCount: 0,
        queueMode: false, activeHandlerId: null, activeHandlerName: null, activeHandlerSince: null,
      }, tenantId, members);
      return convId;
    }
  }
  const have = new Set((await db.select({ userId: internalConversationMembersTable.userId }).from(internalConversationMembersTable)
    .where(eq(internalConversationMembersTable.conversationId, convId))).map((m) => m.userId));
  const missing = members.filter((m) => !have.has(m));
  if (missing.length) await db.insert(internalConversationMembersTable).values(missing.map((userId) => ({ tenantId, conversationId: convId!, userId }))).onConflictDoNothing();
  return convId;
}

/** Grava a mensagem na sala e avisa em tempo real quem está nela. */
async function post(tenantId: number, convId: number, senderId: number, content: string, media?: { url: string; type: "image" | "doc" | "audio" } | null): Promise<{ messageId: number; at: Date } | null> {
  const text = content.trim() || (media ? (media.type === "image" ? "📷 Foto" : media.type === "audio" ? "🎵 Áudio" : "📎 Arquivo") : "");
  if (!text) return null;
  // Mesmo diretório de mídia; o chat interno serve pelo próprio caminho (com controle de acesso).
  if (media) media = { ...media, url: `/api/internal-chat/media/${media.url.split("/").pop()}` };
  const [m] = await db.insert(internalMessagesTable).values({
    tenantId, conversationId: convId, senderId, content: text, type: media?.type ?? "text", mediaUrl: media?.url ?? null,
  }).returning();
  await db.update(internalConversationsTable).set({ lastMessage: text.slice(0, 300), lastMessageAt: m!.createdAt }).where(eq(internalConversationsTable.id, convId));
  const [sender] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, senderId)).limit(1);
  const recipients = (await db.select({ userId: internalConversationMembersTable.userId }).from(internalConversationMembersTable)
    .where(eq(internalConversationMembersTable.conversationId, convId))).map((r) => r.userId);
  broadcastInternal("internal_message", {
    conversationId: convId, kind: "group",
    message: { id: m!.id, conversationId: convId, senderId, senderName: sender?.name ?? BOT_NAME, content: text, type: media?.type ?? "text", mediaUrl: media?.url ?? null, transcript: null, forwarded: false, replyToId: null, replyTo: null, createdAt: m!.createdAt },
  }, tenantId, recipients);
  return { messageId: m!.id, at: m!.createdAt };
}

const first = (n: string) => n.trim().split(" ")[0] ?? n;
/** O chat interno não usa *negrito* do WhatsApp — tira os asteriscos. */
const plain = (t: string) => t.replace(/\*([^*\n]+)\*/g, "$1");

/** Gestores (2º número) ligados a um usuário do CRM — entram nas salas da equipe. */
async function gestores(tenantId: number): Promise<{ userId: number; name: string; phone: string }[]> {
  const rows = await db.select({ userId: gerenteMembersTable.userId, name: gerenteMembersTable.name, phone: gerenteMembersTable.phone }).from(gerenteMembersTable)
    .where(and(eq(gerenteMembersTable.tenantId, tenantId), eq(gerenteMembersTable.isActive, true)));
  return rows.filter((r): r is { userId: number; name: string; phone: string } => r.userId != null);
}
/** Quem lidera: dono + gestores. */
async function leaderIds(tenantId: number): Promise<number[]> {
  const owner = await ownerId(tenantId);
  return [...new Set([...(owner ? [owner] : []), ...(await gestores(tenantId)).map((g) => g.userId)])];
}

async function gerenteRoom(tenantId: number, gestorUserId: number | null = null): Promise<number | null> {
  if (gestorUserId) {
    const g = (await gestores(tenantId)).find((x) => x.userId === gestorUserId);
    if (!g) return null;
    return ensureRoom(tenantId, "gerente", gestorUserId, `${BOT_NAME} · ${first(g.name)}`, [gestorUserId]);
  }
  const owner = await ownerId(tenantId);
  if (!owner) return null;
  return ensureRoom(tenantId, "gerente", 0, BOT_NAME, [owner]);
}

async function personRoom(tenantId: number, userId: number): Promise<number | null> {
  const owner = await ownerId(tenantId);
  const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!owner || !u || userId === owner) return null;
  return ensureRoom(tenantId, "pessoa", userId, `📋 Gerente · ${first(u.name)}`, [...await leaderIds(tenantId), userId]);
}

// ─── Saídas do Gerente pro chat ──────────────────────────────────────────────

/** Mensagem do bot (ou do dono) na sala do Gerente — espelho do WhatsApp e avisos. */
export async function mirrorToGerenteRoom(tenantId: number, direction: "in" | "out", content: string, gestorPhone: string | null = null): Promise<void> {
  try {
    if (!(await enabled(tenantId))) return;
    const { normalizePhone } = await import("./phone");
    const g = gestorPhone ? (await gestores(tenantId)).find((x) => normalizePhone(x.phone) === normalizePhone(gestorPhone)) : null;
    if (gestorPhone && !g) return;
    const room = await gerenteRoom(tenantId, g?.userId ?? null);
    if (!room) return;
    const sender = direction === "in" ? (g ? g.userId : (await ownerId(tenantId))!) : await botUserId(tenantId);
    await post(tenantId, room, sender, direction === "in" ? `📱 ${content}` : plain(content));
  } catch (err) { logger.warn({ err, tenantId }, "Gerente IA: falha ao espelhar no chat interno"); }
}

/** Resposta do Gerente a uma mensagem escrita NO chat (sem espelhar de novo). */
export async function replyInGerenteRoom(tenantId: number, text: string): Promise<void> {
  const room = await gerenteRoom(tenantId);
  if (room) await post(tenantId, room, await botUserId(tenantId), plain(text));
}

/** Tarefa/recado pra uma pessoa: vai pra sala dela. true = entregue. */
export async function postToPerson(tenantId: number, userId: number, text: string, media?: { url: string; type: "image" | "doc" | "audio" } | null): Promise<boolean> {
  return !!(await postToPersonTracked(tenantId, userId, text, media));
}

/** Igual ao postToPerson, mas devolve a sala (pra acompanhar se a pessoa viu). */
export async function postToPersonTracked(tenantId: number, userId: number, text: string, media?: { url: string; type: "image" | "doc" | "audio" } | null): Promise<{ conversationId: number } | null> {
  try {
    if (!(await enabled(tenantId))) return null;
    const room = await personRoom(tenantId, userId);
    if (!room) return null;
    const r = await post(tenantId, room, await botUserId(tenantId), plain(text), media);
    return r ? { conversationId: room } : null;
  } catch (err) { logger.warn({ err, tenantId }, "Gerente IA: falha ao postar no chat da pessoa"); return null; }
}

// ─── Chat primeiro; sem retorno → WhatsApp pessoal + alerta ──────────────────

/** true = a equipe recebe primeiro só pelo chat interno (WhatsApp só se não abrir). */
export async function chatFirst(tenantId: number): Promise<{ on: boolean; minutes: number }> {
  const [s] = await db.select({ ch: gerenteSettingsTable.teamChannel, min: gerenteSettingsTable.chatFallbackMinutes, on: gerenteSettingsTable.internalChatEnabled, enabled: gerenteSettingsTable.enabled })
    .from(gerenteSettingsTable).where(eq(gerenteSettingsTable.tenantId, tenantId)).limit(1);
  return { on: !!s && s.enabled && s.on && s.ch === "chat_first", minutes: Math.max(5, Math.min(24 * 60, s?.min ?? 30)) };
}

export async function trackFollowup(tenantId: number, p: { userId: number; conversationId: number; kind: "tarefa" | "recado"; taskId?: number | null; whatsappText: string; summary: string }): Promise<void> {
  await db.insert(gerenteChatFollowupsTable).values({ tenantId, userId: p.userId, conversationId: p.conversationId, kind: p.kind, taskId: p.taskId ?? null, whatsappText: p.whatsappText, summary: p.summary.slice(0, 200) });
}

/** A pessoa abriu a sala (leu) ou respondeu depois do envio? Tarefa já andou? */
async function followupResolved(f: typeof gerenteChatFollowupsTable.$inferSelect): Promise<boolean> {
  const [mem] = await db.select({ lastReadAt: internalConversationMembersTable.lastReadAt }).from(internalConversationMembersTable)
    .where(and(eq(internalConversationMembersTable.conversationId, f.conversationId), eq(internalConversationMembersTable.userId, f.userId))).limit(1);
  if (mem?.lastReadAt && mem.lastReadAt.getTime() >= f.createdAt.getTime()) return true;
  const [reply] = await db.select({ id: internalMessagesTable.id }).from(internalMessagesTable)
    .where(and(eq(internalMessagesTable.conversationId, f.conversationId), eq(internalMessagesTable.senderId, f.userId), gte(internalMessagesTable.createdAt, f.createdAt))).limit(1);
  if (reply) return true;
  if (f.taskId) {
    const [t] = await db.select({ status: tasksTable.status, isArchived: tasksTable.isArchived }).from(tasksTable).where(eq(tasksTable.id, f.taskId)).limit(1);
    if (!t || t.isArchived || t.status !== "todo") return true;
  }
  return false;
}

/**
 * Job (1 min): o que foi só pelo chat e a pessoa não abriu em X min vai pro
 * WhatsApp pessoal dela, e os gerentes recebem o alerta. Uma vez por envio.
 */
export async function runChatFollowups(tenantId: number, now: Date = new Date()): Promise<number> {
  const { minutes } = await chatFirst(tenantId);
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = await db.select().from(gerenteChatFollowupsTable)
    .where(and(eq(gerenteChatFollowupsTable.tenantId, tenantId), isNull(gerenteChatFollowupsTable.resolvedAt), isNull(gerenteChatFollowupsTable.escalatedAt), lt(gerenteChatFollowupsTable.createdAt, cutoff)))
    .limit(30);
  let n = 0;
  const late = new Map<number, { name: string; items: string[]; sent: boolean }>();
  for (const f of rows) {
    if (await followupResolved(f)) { await db.update(gerenteChatFollowupsTable).set({ resolvedAt: now }).where(eq(gerenteChatFollowupsTable.id, f.id)); continue; }
    await db.update(gerenteChatFollowupsTable).set({ escalatedAt: now }).where(eq(gerenteChatFollowupsTable.id, f.id));
    const { sendWhatsAppToTeamMember } = await import("./gerenteDispatch");
    const sent = await sendWhatsAppToTeamMember(tenantId, f.userId, f.whatsappText, f.taskId);
    const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, f.userId)).limit(1);
    const e = late.get(f.userId) ?? { name: first(u?.name ?? "Equipe"), items: [], sent };
    e.items.push(`${f.kind === "tarefa" ? "📋" : "📣"} ${f.summary}`);
    e.sent = e.sent && sent;
    late.set(f.userId, e);
    n++;
  }
  if (late.size) {
    const { notifyTeamLeads } = await import("./gerente");
    for (const e of late.values()) {
      await notifyTeamLeads(tenantId, `🔕 *${e.name} não abriu o chat do CRM em ${minutes} min:*\n${e.items.map((i) => `• ${i}`).join("\n")}\n${e.sent ? `📲 Mandei no WhatsApp pessoal dele(a).` : `⚠️ Não consegui mandar no WhatsApp (sem número cadastrado ou linha caída) — cobre pessoalmente.`}`);
    }
  }
  return n;
}

/** Recado pra loja: sala da loja com todos que trabalham nela. */
export async function postToStore(tenantId: number, storeName: string, memberIds: number[], text: string, media?: { url: string; type: "image" | "doc" | "audio" } | null): Promise<number | null> {
  try {
    if (!(await enabled(tenantId))) return null;
    const owner = await ownerId(tenantId);
    if (!owner) return null;
    const [st] = await db.select({ id: storesTable.id }).from(storesTable).where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.name, storeName))).limit(1);
    if (!st) return null;
    const room = await ensureRoom(tenantId, "loja", st.id, `📣 Gerente · ${storeName.replace(/\s*-\s*\d+\s*$/, "")}`, [...await leaderIds(tenantId), ...memberIds]);
    await post(tenantId, room, await botUserId(tenantId), plain(text), media);
    return room;
  } catch (err) { logger.warn({ err, tenantId }, "Gerente IA: falha ao postar no chat da loja"); return null; }
}

// ─── Entradas: alguém escreveu numa sala do Gerente ──────────────────────────

async function sellerOpenTasks(tenantId: number, userId: number): Promise<{ id: number; title: string; awaiting: boolean }[]> {
  const rows = await db.select({ id: tasksTable.id, title: tasksTable.title }).from(taskAssigneesTable)
    .innerJoin(tasksTable, eq(tasksTable.id, taskAssigneesTable.taskId))
    .where(and(eq(taskAssigneesTable.userId, userId), eq(tasksTable.tenantId, tenantId), eq(tasksTable.isArchived, false), ne(tasksTable.status, "done")))
    .orderBy(desc(tasksTable.id)).limit(30);
  const waiting = rows.length ? new Set((await db.select({ taskId: gerenteTaskDispatchesTable.taskId }).from(gerenteTaskDispatchesTable)
    .where(and(eq(gerenteTaskDispatchesTable.userId, userId), eq(gerenteTaskDispatchesTable.status, "aguardando_prova"), inArray(gerenteTaskDispatchesTable.taskId, rows.map((r) => r.id))))).map((r) => r.taskId)) : new Set<number>();
  return rows.map((r) => ({ ...r, awaiting: waiting.has(r.id) }));
}

const awaitingPhoto = new Map<string, { taskId: number; at: number }>();

/**
 * Chamado depois que uma mensagem é gravada no chat interno. Só age nas
 * salas do Gerente; nunca lança (o envio da pessoa já deu certo).
 */
export async function onInternalMessage(p: { tenantId: number; conversationId: number; senderId: number; text: string; type: string; mediaUrl: string | null }): Promise<void> {
  try {
    const [room] = await db.select().from(gerenteChatRoomsTable)
      .where(and(eq(gerenteChatRoomsTable.tenantId, p.tenantId), eq(gerenteChatRoomsTable.conversationId, p.conversationId))).limit(1);
    if (!room || !(await enabled(p.tenantId))) return;
    const bot = await botUserId(p.tenantId);
    if (p.senderId === bot) return;
    const owner = await ownerId(p.tenantId);
    const say = (t: string) => post(p.tenantId, p.conversationId, bot, plain(t));

    // Dono (sala "🤖 Gerente IA") ou gestor (sala "🤖 Gerente IA · Nome") falando com o Gerente pelo chat.
    const gs = await gestores(p.tenantId);
    const gestor = gs.find((g) => g.userId === p.senderId) ?? null;
    if (room.kind === "gerente" && ((room.refId === 0 && p.senderId === owner) || (room.refId === p.senderId && gestor))) {
      const text = p.text.trim();
      if (!text) { await say("Por aqui eu entendo texto. Pra encaminhar foto/arquivo, mande pelo WhatsApp do ADM. 🙂"); return; }
      const { handleChatMessage } = await import("./gerente");
      const replies = await handleChatMessage(p.tenantId, text, room.refId === 0 ? null : gestor!.phone);
      for (const r of replies) await say(r);
      return;
    }

    // Líder (dono/gestor) escrevendo na sala de um vendedor: "tarefa: …" vira
    // tarefa DELE na hora; "avisa: …" é só recado (ele já vê aqui).
    if (room.kind === "pessoa" && p.senderId !== room.refId && (p.senderId === owner || gestor)) {
      const m = p.text.trim().match(/^(?:nova\s+)?tarefa\s*(?:pra\s+(?:ele|ela|voc[eê])\s*)?[:\-–]?\s+(.{3,})$/i);
      if (!m) return;
      const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, room.refId)).limit(1);
      if (!u) return;
      const { handleChatMessage } = await import("./gerente");
      const replies = await handleChatMessage(p.tenantId, `tarefa pro ${first(u.name)}: ${m[1]!.trim()}`, gestor && p.senderId !== owner ? gestor.phone : null);
      for (const r of replies) await say(r.replace(/\n?💬 Enviada.*$/m, ""));
      return;
    }

    // Gestora na PRÓPRIA sala (ela também é vendedora): o que não for resposta
    // de tarefa (1/2/3, feito, foto) é pedido pro Gerente — vira tarefa etc.
    if (room.kind === "pessoa" && p.senderId === room.refId && gestor && p.type === "text") {
      const t0 = norm(p.text);
      const isReply = /^([123])(\s|$|[-–.:)])/.test(t0) || /^(feito|pronto|concluido|conclui|terminei|finalizei)\b/.test(t0);
      if (!isReply && p.text.trim()) {
        const { handleChatMessage } = await import("./gerente");
        const replies = await handleChatMessage(p.tenantId, p.text.trim(), gestor.phone);
        for (const r of replies) await say(r);
        return;
      }
    }

    // Pessoa respondendo na sala dela: 1/2/3, "feito", foto de prova.
    if (room.kind === "pessoa" && p.senderId === room.refId) {
      const userId = room.refId;
      const open = await sellerOpenTasks(p.tenantId, userId);
      const t = norm(p.text);
      const key = `${p.tenantId}:${userId}`;
      const { sellerAction, sellerProof } = await import("./gerenteDispatch");
      const pick = (n: number | null) => (n ? open.find((o) => o.id === n) : open.length === 1 ? open[0] : undefined);
      const askWhich = (code: string) => say(`Qual tarefa? Responda ${code} + número:\n${open.map((o) => `• ${o.id} — ${o.title}`).join("\n")}`);

      if (p.type === "image" && p.mediaUrl) {
        const n = Number((t.match(/\b(\d{1,7})\b/) ?? [])[1]) || null;
        const w = awaitingPhoto.get(key);
        const target = pick(n) ?? (w && Date.now() - w.at < 2 * 3_600_000 ? open.find((o) => o.id === w.taskId) : undefined) ?? open.find((o) => o.awaiting);
        if (!target) { if (open.length > 1) await askWhich("a foto com a legenda"); return; }
        awaitingPhoto.delete(key);
        await say(await sellerProof(p.tenantId, target.id, userId, p.mediaUrl, p.text.trim() || null));
        return;
      }
      const q = t.match(/^([123])(?:(?:\s+|\s*[-–.:)]\s*)#?(\d{1,7}))?(?:\s+(.+))?$/);
      const feito = t.match(/^(feito|pronto|concluido|conclui|terminei|finalizei)(?:\s*#?\s*(\d+))?\b/);
      if (feito || q?.[1] === "1") {
        const target = pick(Number((feito ?? q)![2]) || null);
        if (!target) { if (open.length) await askWhich("1"); return; }
        awaitingPhoto.set(key, { taskId: target.id, at: Date.now() });
        await say(`👍 Ótimo! Agora manda aqui uma foto como prova da tarefa ${target.id}. 📸`);
        return;
      }
      if (q?.[1] === "2" || q?.[1] === "3") {
        const target = pick(Number(q[2]) || null);
        if (!target) { if (open.length) await askWhich(q[1]); return; }
        if (q[1] === "2") { await say(await sellerAction(p.tenantId, target.id, userId, "postpone")); return; }
        const question = p.text.trim().replace(/^3\s*[-–.:)]?\s*(?:#?\d{1,7})?\s*/, "").trim();
        await say(question ? await sellerAction(p.tenantId, target.id, userId, "question", question) : `Escreva a dúvida junto: 3 ${target.id} sua dúvida`);
        return;
      }
      // Conversa normal com o dono: avisa no WhatsApp dele (ele está na rua).
      if (p.text.trim() && owner) {
        const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
        const { notifyTeamLeads } = await import("./gerente");
        await notifyTeamLeads(p.tenantId, `💬 *${first(u?.name ?? "Equipe")}* no chat do CRM:\n“${p.text.trim().slice(0, 600)}”\nPra responder: *avisa ${first(u?.name ?? "")}: …*`, { skipUserId: userId });
      }
    }
  } catch (err) {
    logger.warn({ err, tenantId: p.tenantId }, "Gerente IA: falha ao tratar mensagem do chat interno");
  }
}
