import { Router, type IRouter } from "express";
import { requireAuth, requireTenant } from "../middlewares/auth";
import { logger } from "../lib/logger";

// Proxy simples pra Google Places Autocomplete (API "legada", Essentials).
// Usada pra sugerir cidade/bairro em campos de texto já existentes no CRM e
// na nota de compra de usado (Avaliação) — não muda a estrutura do banco,
// só ajuda a digitar mais rápido e com menos erro de digitação/acentuação.
//
// A chave (GOOGLE_PLACES_API_KEY) fica só no backend, restrita por IP no
// Google Cloud Console — o frontend nunca vê a chave, só chama essa rota.
const router: IRouter = Router();

type AutocompleteSuggestion = { description: string; mainText: string; secondaryText: string };

router.get("/geo/autocomplete", requireAuth, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  void tenantId;

  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) {
    res.status(501).json({ error: "Autocomplete de endereço não configurado neste servidor." });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 150) : "";
  if (!q) { res.json({ results: [] }); return; }

  // kind=city restringe a cidades (usado no campo "Cidade" do CRM); qualquer
  // outro valor (ou ausente) faz busca geral de endereço/bairro (campo
  // "Bairro" da Avaliação).
  const kind = req.query.kind === "city" ? "city" : "address";

  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", q);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("components", "country:br");
  url.searchParams.set("types", kind === "city" ? "(cities)" : "(regions)");

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      logger.warn({ status: r.status, body: body.slice(0, 300), q }, "Geo autocomplete: Google respondeu erro");
      res.json({ results: [] });
      return;
    }
    const json = (await r.json()) as {
      status?: string;
      predictions?: { description?: string; structured_formatting?: { main_text?: string; secondary_text?: string } }[];
    };
    if (json.status && json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      logger.warn({ status: json.status, q }, "Geo autocomplete: Google retornou status de erro");
    }
    const results: AutocompleteSuggestion[] = (json.predictions ?? []).slice(0, 6).map((p) => ({
      description: typeof p.description === "string" ? p.description : "",
      mainText: typeof p.structured_formatting?.main_text === "string" ? p.structured_formatting.main_text : (p.description ?? ""),
      secondaryText: typeof p.structured_formatting?.secondary_text === "string" ? p.structured_formatting.secondary_text : "",
    })).filter((r) => r.mainText);
    res.json({ results });
  } catch (err) {
    req.log.error({ err }, "Geo autocomplete failed");
    res.json({ results: [] });
  }
});

export default router;
