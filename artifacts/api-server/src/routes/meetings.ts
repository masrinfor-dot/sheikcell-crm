import { Router, type IRouter } from "express";
import { db, meetingsTable, documentsTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireAdminOrSupervisor, requireTenant } from "../middlewares/auth";
import path from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import { toFile } from "@workspace/integrations-openai-ai";
import { getOpenAiClientForTenant } from "../lib/aiClient";
import { DOCS_DIR } from "./documents";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Gravações de reunião ficam junto dos documentos, em subpasta própria.
const REC_DIR = path.join(DOCS_DIR, "meeting-recordings");

// Áudio comprimido (opus ~32kbps): 20MB dá ~1h30 de reunião. Precisa caber no
// limite global do express.json (30MB) já contando a expansão do base64 (~33%).
const MAX_RECORDING = 20 * 1024 * 1024;

const REC_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

// Assinatura (magic bytes) precisa bater com o tipo declarado.
function looksLikeAudio(buf: Buffer, mime: string): boolean {
  if (mime === "audio/webm") return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3; // EBML
  if (mime === "audio/ogg") return buf.toString("ascii", 0, 4) === "OggS";
  return false;
}

type DocKind = "ata" | "resumo" | "tarefas";
const DOC_PROMPTS: Record<DocKind, { label: string; prompt: string }> = {
  ata: {
    label: "Ata da reunião",
    prompt: "Escreva a ATA formal desta reunião em português: cabeçalho com título e data, pauta identificada, principais discussões, decisões tomadas e encaminhamentos. Formato de ata profissional, texto corrido organizado em seções.",
  },
  resumo: {
    label: "Resumo da reunião",
    prompt: "Escreva um RESUMO executivo curto desta reunião em português: os pontos principais em tópicos, decisões e próximos passos. Direto e fácil de ler.",
  },
  tarefas: {
    label: "Tarefas da reunião",
    prompt: "Extraia a LISTA DE TAREFAS/encaminhamentos desta reunião em português: para cada tarefa, o que fazer, responsável (se citado) e prazo (se citado). Em tópicos numerados.",
  },
};

// Uma transcrição por vez por reunião (evita pagar 2x).
const inFlight = new Set<number>();

async function getMeeting(id: number, tenantId: number) {
  const [m] = await db.select().from(meetingsTable)
    .where(and(eq(meetingsTable.id, id), eq(meetingsTable.tenantId, tenantId)));
  return m;
}

// ─── Listar reuniões ─────────────────────────────────────────────────────────
router.get("/meetings", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const rows = await db
    .select({
      id: meetingsTable.id,
      title: meetingsTable.title,
      roomCode: meetingsTable.roomCode,
      status: meetingsTable.status,
      transcript: meetingsTable.transcript,
      recordingBytes: meetingsTable.recordingBytes,
      createdAt: meetingsTable.createdAt,
      endedAt: meetingsTable.endedAt,
      creatorName: usersTable.name,
    })
    .from(meetingsTable)
    .leftJoin(usersTable, eq(meetingsTable.createdBy, usersTable.id))
    .where(eq(meetingsTable.tenantId, tenantId))
    .orderBy(desc(meetingsTable.createdAt))
    .limit(50);
  res.json(rows);
});

// ─── Criar reunião (qualquer membro da equipe) ───────────────────────────────
router.post("/meetings", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 150) : "";
  if (!title) { res.status(400).json({ error: "Dê um nome à reunião" }); return; }
  const roomCode = `sheikcell-${tenantId}-${randomUUID().slice(0, 13)}`;
  const [meeting] = await db.insert(meetingsTable).values({
    tenantId, title, roomCode, createdBy: req.session.userId ?? null,
  }).returning();
  res.status(201).json(meeting);
});

// ─── Enviar gravação (base64) e transcrever ──────────────────────────────────
router.post("/meetings/:id/recording", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const meeting = await getMeeting(id, tenantId);
  if (!meeting) { res.status(404).json({ error: "Reunião não encontrada" }); return; }
  if (inFlight.has(id)) { res.status(409).json({ error: "Essa gravação já está sendo processada" }); return; }
  // Reunião já transcrita não aceita outra gravação (evita pagar Whisper de
  // novo por engano/abuso). Para regravar, crie uma nova reunião.
  if (meeting.status === "transcrita") { res.status(409).json({ error: "Essa reunião já foi transcrita. Crie uma nova reunião para gravar de novo." }); return; }

  const mime = typeof req.body?.mimeType === "string" ? req.body.mimeType.split(";")[0].trim() : "";
  const ext = REC_MIME[mime];
  if (!ext) { res.status(400).json({ error: "Formato de gravação não suportado" }); return; }
  const data = req.body?.data;
  if (typeof data !== "string" || !data) { res.status(400).json({ error: "Gravação vazia" }); return; }
  const buf = Buffer.from(data, "base64");
  if (buf.length === 0) { res.status(400).json({ error: "Gravação vazia" }); return; }
  if (buf.length > MAX_RECORDING) { res.status(400).json({ error: "Gravação muito grande (máximo 20MB / ~1h30). Grave em partes menores." }); return; }
  if (!looksLikeAudio(buf, mime)) { res.status(400).json({ error: "O arquivo enviado não parece uma gravação de áudio válida" }); return; }

  inFlight.add(id);
  try {
    // Pasta separada por loja: gravações de lojas diferentes não se misturam.
    const tenantDir = path.join(REC_DIR, String(tenantId));
    await mkdir(tenantDir, { recursive: true });
    const storedName = `${tenantId}/${randomUUID()}.${ext}`;
    await writeFile(path.join(REC_DIR, storedName), buf);
    await db.update(meetingsTable).set({
      recordingName: storedName, recordingBytes: buf.length,
      status: "gravada", endedAt: new Date(),
    }).where(eq(meetingsTable.id, id));

    // Transcreve com o Whisper (chave OpenAI da loja, se configurada).
    const file = await toFile(buf, `reuniao.${ext}`, { type: mime });
    const openai = await getOpenAiClientForTenant(tenantId);
    const result = await openai.audio.transcriptions.create({
      file, model: "whisper-1", language: "pt",
    });
    const transcript = (result.text ?? "").trim().slice(0, 200_000);
    if (!transcript) { res.status(422).json({ error: "Não foi possível entender o áudio da gravação" }); return; }
    await db.update(meetingsTable).set({ transcript, status: "transcrita" })
      .where(eq(meetingsTable.id, id));
    res.json({ transcript });
  } catch (err) {
    logger.warn({ err, meetingId: id }, "Falha ao processar gravação de reunião");
    res.status(500).json({ error: "Falha ao transcrever a gravação. Tente enviar de novo." });
  } finally {
    inFlight.delete(id);
  }
});

// ─── Gerar documento (ata/resumo/tarefas) a partir da transcrição ────────────
router.post("/meetings/:id/generate", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const meeting = await getMeeting(id, tenantId);
  if (!meeting) { res.status(404).json({ error: "Reunião não encontrada" }); return; }
  if (!meeting.transcript) { res.status(400).json({ error: "Essa reunião ainda não tem transcrição" }); return; }
  const kind = String(req.body?.kind ?? "ata") as DocKind;
  const spec = DOC_PROMPTS[kind];
  if (!spec) { res.status(400).json({ error: "Tipo de documento inválido" }); return; }

  try {
    const openai = await getOpenAiClientForTenant(tenantId);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2500,
      messages: [
        { role: "system", content: "Você redige documentos internos de uma loja de celulares a partir de transcrições de reuniões de equipe. Responda apenas com o documento pronto, em texto simples (sem markdown)." },
        { role: "user", content: `${spec.prompt}\n\nReunião: "${meeting.title}" em ${meeting.createdAt.toLocaleDateString("pt-BR")}.\n\nTRANSCRIÇÃO:\n${meeting.transcript.slice(0, 60_000)}` },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) { res.status(502).json({ error: "A IA não retornou o documento. Tente de novo." }); return; }

    // Salva como documento .txt no arquivo da loja (aparece na área Documentos).
    await mkdir(DOCS_DIR, { recursive: true });
    const storedName = `${randomUUID()}.txt`;
    const buf = Buffer.from(text, "utf8");
    await writeFile(path.join(DOCS_DIR, storedName), buf);
    const title = `${spec.label} — ${meeting.title}`;
    const [doc] = await db.insert(documentsTable).values({
      tenantId,
      title: title.slice(0, 200),
      category: kind === "ata" ? "ata" : "documento",
      description: `Gerado pela IA a partir da gravação da reunião "${meeting.title}" (${meeting.createdAt.toLocaleDateString("pt-BR")}).`,
      fileName: `${title.slice(0, 120)}.txt`,
      storedName,
      mimeType: "text/plain",
      sizeBytes: buf.length,
      uploadedBy: req.session.userId ?? null,
    }).returning();
    res.status(201).json(doc);
  } catch (err) {
    logger.warn({ err, meetingId: id }, "Falha ao gerar documento da reunião");
    res.status(500).json({ error: "Falha ao gerar o documento. Tente de novo." });
  }
});

// ─── Excluir reunião (admin/supervisor) ──────────────────────────────────────
router.delete("/meetings/:id", requireAdminOrSupervisor, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const id = parseInt(String(req.params.id), 10);
  const meeting = await getMeeting(id, tenantId);
  if (!meeting) { res.status(404).json({ error: "Reunião não encontrada" }); return; }
  await db.delete(meetingsTable).where(eq(meetingsTable.id, id));
  if (meeting.recordingName) {
    // recordingName é "<tenantId>/<uuid>.<ext>"; garante que fica dentro de REC_DIR.
    const fp = path.resolve(REC_DIR, meeting.recordingName);
    if (fp.startsWith(REC_DIR + path.sep) && existsSync(fp)) await unlink(fp).catch(() => {});
  }
  res.json({ ok: true });
});

export default router;
