// "Redirecionar a vitrine pública para o ERP" (17/10/2026) — ver
// lib/vitrineRedirect.ts. Desligado por padrão: o Samuel liga depois de
// testar a página /loja/<slug> do ERP.
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin, requireTenant } from "../middlewares/auth";
import { setVitrineRedirect, vitrineRedirectBySlug, vitrineRedirectStatus } from "../lib/vitrineRedirect";

const router: IRouter = Router();

router.get("/catalog/erp-redirect", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  res.json(await vitrineRedirectStatus(tenantId));
});

router.put("/catalog/erp-redirect", requireAdmin, async (req, res): Promise<void> => {
  const tenantId = requireTenant(req, res); if (tenantId == null) return;
  const enabled = (req.body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "Informe se a opção fica ligada ou desligada" }); return; }
  if (enabled && !(await vitrineRedirectStatus(tenantId)).erpWebUrl) {
    res.status(400).json({ error: "O CRM ainda não sabe o endereço do ERP. Em Configurações › Integração com o ERP, clique em Testar." });
    return;
  }
  await setVitrineRedirect(tenantId, enabled);
  res.json(await vitrineRedirectStatus(tenantId));
});

export default router;

// Sem login: o nginx manda /vitrine/<slug> e /avaliar/<slug> pra cá. Com a
// opção ligada responde 302 para o ERP; senão 404 e o nginx serve a página
// de sempre (SPA).
export const vitrineRedirectPublicRouter: IRouter = Router();

vitrineRedirectPublicRouter.get("/public-redirect/:kind/:slug", async (req: Request, res: Response): Promise<void> => {
  const kind = String(req.params.kind ?? "");
  if (kind !== "vitrine" && kind !== "avaliar") { res.status(404).json({ error: "Não encontrado" }); return; }
  const to = await vitrineRedirectBySlug(String(req.params.slug ?? ""), kind);
  if (!to) { res.status(404).json({ error: "Sem redirecionamento" }); return; }
  // Mantém o ?troca=1 (e outros parâmetros) da página de avaliação.
  const q = req.originalUrl.indexOf("?");
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, q >= 0 ? `${to}${req.originalUrl.slice(q)}` : to);
});
