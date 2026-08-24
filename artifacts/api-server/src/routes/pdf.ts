import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { generateSimplePdf } from "../lib/pdf";

const router: IRouter = Router();

// Rota de teste da infraestrutura de PDF — só prova que a geração funciona.
// O layout definitivo (nota de fechamento de negócio etc.) vem depois, a
// partir de um modelo.
router.get("/pdf/test", requireAuth, async (req, res): Promise<void> => {
  try {
    const buffer = await generateSimplePdf("Documento de teste", [
      "Este é um PDF de teste gerado pela infraestrutura básica (pdfkit).",
      `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
    ]);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=teste.pdf");
    res.send(buffer);
  } catch (err) {
    req.log.error({ err }, "PDF test generation failed");
    res.status(500).json({ error: "Falha ao gerar PDF de teste" });
  }
});

export default router;
