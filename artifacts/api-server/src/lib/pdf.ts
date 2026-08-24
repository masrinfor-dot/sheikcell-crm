import PDFDocument from "pdfkit";

// Infra genérica de geração de PDF (base para as notas de fechamento de
// negócio etc.). O layout definitivo dos documentos vem depois, a partir de
// um modelo — isso aqui só prova que a geração funciona.
export function generateSimplePdf(title: string, lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(title, { align: "center" });
    doc.moveDown();
    doc.fontSize(11);
    for (const line of lines) {
      doc.text(line);
    }

    doc.end();
  });
}
