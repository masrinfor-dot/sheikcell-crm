import { Router, type IRouter } from "express";
import { db, queueEntriesTable, sectorsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";

const router: IRouter = Router();

// Keywords to sector mapping (case-insensitive)
const SECTOR_KEYWORDS: Array<{ keywords: string[]; sectorName: string }> = [
  { keywords: ["assistência", "assistencia", "técnica", "tecnica", "reparo", "conserto", "quebrou", "problema", "não liga", "tela", "bateria"], sectorName: "Assistência Técnica" },
  { keywords: ["acessório", "acessorio", "capa", "capinha", "fone", "carregador", "película", "pelicula", "cabo"], sectorName: "Venda de Acessórios" },
  { keywords: ["celular", "smartphone", "aparelho", "comprar", "quero", "preço", "preco", "modelo", "iphone", "samsung", "motorola"], sectorName: "Vendas de Celulares" },
  { keywords: ["pagamento", "parcela", "crédito", "credito", "financeiro", "financiamento", "caixa", "boleto", "pix"], sectorName: "Financeiro / Caixa" },
  { keywords: ["emprego", "trabalho", "vaga", "currículo", "curriculo", "rh", "compras", "fornecedor"], sectorName: "RH / Administrativo / Compras" },
];

function detectSectorFromMessage(message: string): string {
  const lower = message.toLowerCase();
  for (const { keywords, sectorName } of SECTOR_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return sectorName;
    }
  }
  return "Vendas de Celulares"; // default
}

router.post("/webhook/inbound", (req, res, next): void => {
  const secret = process.env["WEBHOOK_SECRET"];

  if (process.env["NODE_ENV"] === "production" && !secret) {
    res.status(403).json({ error: "Webhook not configured" });
    return;
  }

  if (secret) {
    const provided =
      req.headers["x-webhook-secret"] ??
      (typeof req.headers["authorization"] === "string" &&
      req.headers["authorization"].startsWith("Bearer ")
        ? req.headers["authorization"].slice(7)
        : undefined);

    if (provided !== secret) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  next();
}, async (req, res): Promise<void> => {
  const body = req.body as {
    clientName?: string;
    clientContact?: string;
    message?: string;
    sectorName?: string;
    sectorId?: number;
    channel?: string;
    // ManyChat / Z-API compatible fields
    first_name?: string;
    last_name?: string;
    phone?: string;
    text?: string;
    from?: string;
  };

  // Normalize fields from various integrations
  const clientName =
    body.clientName ??
    (body.first_name ? `${body.first_name} ${body.last_name ?? ""}`.trim() : null) ??
    "Cliente Desconhecido";

  const clientContact = body.clientContact ?? body.phone ?? body.from ?? null;
  const message = body.message ?? body.text ?? "";
  const channel = body.channel ?? "whatsapp";

  let sectorId = body.sectorId ?? null;

  if (!sectorId) {
    const targetSectorName = body.sectorName ?? detectSectorFromMessage(message);
    const [sector] = await db
      .select()
      .from(sectorsTable)
      .where(and(eq(sectorsTable.name, targetSectorName), eq(sectorsTable.isActive, true)));

    if (sector) {
      sectorId = sector.id;
    } else {
      // fallback to first active sector
      const [first] = await db.select().from(sectorsTable).where(eq(sectorsTable.isActive, true));
      sectorId = first?.id ?? 1;
    }
  }

  const [lastInQueue] = await db
    .select({ position: queueEntriesTable.position })
    .from(queueEntriesTable)
    .where(and(eq(queueEntriesTable.sectorId, sectorId), sql`${queueEntriesTable.status} IN ('waiting', 'in_progress')`))
    .orderBy(desc(queueEntriesTable.position))
    .limit(1);

  const nextPosition = (lastInQueue?.position ?? 0) + 1;

  const [entry] = await db
    .insert(queueEntriesTable)
    .values({
      clientName,
      clientContact,
      sectorId,
      channel,
      status: "waiting",
      notes: message || null,
      position: nextPosition,
    })
    .returning();

  res.status(201).json({ ok: true, entryId: entry?.id });
});

export default router;
