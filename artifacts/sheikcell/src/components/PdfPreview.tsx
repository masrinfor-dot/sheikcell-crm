import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Download } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
// Vite resolve isso pra uma URL do arquivo publicado — pdf.js roda o parsing
// pesado num worker separado, senão trava a thread principal a cada PDF.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const THUMB_WIDTH = 220;

/** Miniatura da 1ª página do PDF, renderizada num <canvas> via pdf.js. Se o
 * PDF não carregar (arquivo indisponível, corrompido), some silenciosamente
 * e sobra só a linha de nome/tamanho — igual ao comportamento de antes. */
function PdfThumbnail({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjsLib.getDocument({ url: src });
    task.promise
      .then((doc) => doc.getPage(1))
      .then((page) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = THUMB_WIDTH / baseViewport.width;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        return page.render({ canvasContext: ctx, viewport, canvas }).promise;
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; task.destroy(); };
  }, [src]);

  if (failed) return null;
  return <canvas ref={canvasRef} className="rounded-lg border border-black/10 max-w-full block" />;
}

/** Modal de pré-visualização do PDF inteiro — usa o visualizador nativo do
 * navegador dentro de um iframe (sem reimplementar paginação/zoom do pdf.js). */
function PdfModal({ src, fileName, onClose }: { src: string; fileName: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/80 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between gap-2 px-4 py-2 bg-black/60 text-white shrink-0" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm truncate">{fileName}</p>
        <div className="flex items-center gap-3 shrink-0">
          <a href={`${src}?download=1`} download title="Baixar" className="hover:text-primary">
            <Download className="w-5 h-5" />
          </a>
          <button onClick={onClose} title="Fechar" data-testid="button-close-pdf-preview">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <iframe src={src} title={fileName} className="flex-1 w-full bg-white" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}

export function PdfBubble({ src, fileName, sizeLabel, icon }: {
  src: string;
  fileName: string;
  sizeLabel?: string;
  icon: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(true)}
        className="block w-fit"
        data-testid="button-open-pdf-preview"
      >
        <PdfThumbnail src={src} />
      </button>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 mt-1 bg-black/5 rounded-xl px-3 py-2 hover:bg-black/10 transition w-full text-left"
      >
        {icon}
        <div className="min-w-0">
          <p className="text-xs text-gray-700 break-all">{fileName}</p>
          {sizeLabel && <p className="text-[10px] text-gray-500">{sizeLabel}</p>}
        </div>
      </button>
      {open && <PdfModal src={src} fileName={fileName} onClose={() => setOpen(false)} />}
    </div>
  );
}
