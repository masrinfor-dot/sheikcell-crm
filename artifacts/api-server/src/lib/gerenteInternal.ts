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
import { and, eq, asc, inArray, desc, ne } from "drizzle-orm";
import {
  db, usersTable, storesTable, internalConversationsTable, internalConversationMembersTable, internalMessagesTable,
  gerenteChatRoomsTable, gerenteSettingsTable, tasksTable, taskAssigneesTable, gerenteTaskDispatchesTable,
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
async function post(tenantId: number, convId: number, senderId: number, content: string, media?: { url: string; type: "image" | "doc" | "audio" } | null): Promise<void> {
  const text = content.trim() || (media ? (media.type === "image" ? "📷 Foto" : media.type === "audio" ? "🎵 Áudio" : "📎 Arquivo") : "");
  if (!text) return;
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
}

const first = (n: string) => n.trim().split(" ")[0] ?? n;
/** O chat interno não usa *negrito* do WhatsApp — tira os asteriscos. */
const plain = (t: string) => t.replace(/\*([^*\n]+)\*/g, "$1");

async function gerenteRoom(tenantId: number): Promise<number | null> {
  const owner = await ownerId(tenantId);
  if (!owner) return null;
  return ensureRoom(tenantId, "gerente", 0, BOT_NAME, [owner]);
}

async function personRoom(tenantId: number, userId: number): Promise<number | null> {
  const owner = await ownerId(tenantId);
  const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.tenantId, tenantId))).limit(1);
  if (!owner || !u || userId === owner) return null;
  return ensureRoom(tenantId, "pessoa", userId, `📋 Gerente · ${first(u.name)}`, [owner, userId]);
}

// ─── Saídas do Gerente pro chat ──────────────────────────────────────────────

/** Mensagem do bot (ou do dono) na sala do Gerente — espelho do WhatsApp e avisos. */
export async function mirrorToGerenteRoom(tenantId: number, direction: "in" | "out", content: string): Promise<void> {
  try {
    if (!(await enabled(tenantId))) return;
    const room = await gerenteRoom(tenantId);
    if (!room) return;
    const sender = direction === "in" ? (await ownerId(tenantId))! : await botUserId(tenantId);
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
  try {
    if (!(await enabled(tenantId))) return false;
    const room = await personRoom(tenantId, userId);
    if (!room) return false;
    await post(tenantId, room, await botUserId(tenantId), plain(text), media);
    return true;
  } catch (err) { logger.warn({ err, tenantId }, "Gerente IA: falha ao postar no chat da pessoa"); return false; }
}

/** Recado pra loja: sala da loja com todos que trabalham nela. */
export async function postToStore(tenantId: number, storeName: string, memberIds: number[], text: string, media?: { url: string; type: "image" | "doc" | "audio" } | null): Promise<boolean> {
  try {
    if (!(await enabled(tenantId))) return false;
    const owner = await ownerId(tenantId);
    if (!owner) return false;
    const [st] = await db.select({ id: storesTable.id }).from(storesTable).where(and(eq(storesTable.tenantId, tenantId), eq(storesTable.name, storeName))).limit(1);
    if (!st) return false;
    const room = await ensureRoom(tenantId, "loja", st.id, `📣 Gerente · ${storeName.replace(/\s*-\s*\d+\s*$/, "")}`, [owner, ...memberIds]);
    await post(tenantId, room, await botUserId(tenantId), plain(text), media);
    return true;
  } catch (err) { logger.warn({ err, tenantId }, "Gerente IA: falha ao postar no chat da loja"); return false; }
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

    // Dono falando com o Gerente pelo chat.
    if (room.kind === "gerente" && p.senderId === owner) {
      const text = p.text.trim();
      if (!text) { await say("Por aqui eu entendo texto. Pra encaminhar foto/arquivo, mande pelo WhatsApp do ADM. 🙂"); return; }
      const { handleChatMessage } = await import("./gerente");
      const replies = await handleChatMessage(p.tenantId, text);
      for (const r of replies) await say(r);
      return;
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
        await notifyTeamLeads(p.tenantId, `💬 *${first(u?.name ?? "Equipe")}* no chat do CRM:\n“${p.text.trim().slice(0, 600)}”\nPra responder: *avisa ${first(u?.name ?? "")}: …*`);
      }
    }
  } catch (err) {
    logger.warn({ err, tenantId: p.tenantId }, "Gerente IA: falha ao tratar mensagem do chat interno");
  }
}
