import { createContext, useContext, useState, type ReactNode } from "react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Video from "yet-another-react-lightbox/plugins/video";
import "yet-another-react-lightbox/styles.css";

type MediaLightboxSlide =
  | { type: "image"; src: string }
  | { type: "video"; src: string; mimeType?: string };

const MediaLightboxContext = createContext<((slide: MediaLightboxSlide) => void) | null>(null);

/** Provedor do lightbox de foto/vídeo — envolve a tela de conversa uma vez;
 * qualquer bolha de mídia abre o mesmo modal via useMediaLightbox(), sem
 * precisar passar callback por prop por toda a árvore de componentes. */
export function MediaLightboxProvider({ children }: { children: ReactNode }) {
  const [slide, setSlide] = useState<MediaLightboxSlide | null>(null);

  return (
    <MediaLightboxContext.Provider value={setSlide}>
      {children}
      {slide && (
        <Lightbox
          open
          close={() => setSlide(null)}
          plugins={slide.type === "video" ? [Zoom, Video] : [Zoom]}
          slides={[
            slide.type === "image"
              ? { src: slide.src }
              : {
                  type: "video" as const,
                  sources: [{ src: slide.src, type: slide.mimeType ?? "video/mp4" }],
                  autoPlay: true,
                },
          ]}
        />
      )}
    </MediaLightboxContext.Provider>
  );
}

/** Retorna a função pra abrir o lightbox com uma foto ou vídeo. Precisa estar
 * dentro de um <MediaLightboxProvider>. */
export function useMediaLightbox(): (slide: MediaLightboxSlide) => void {
  const open = useContext(MediaLightboxContext);
  if (!open) throw new Error("useMediaLightbox precisa estar dentro de um MediaLightboxProvider");
  return open;
}
