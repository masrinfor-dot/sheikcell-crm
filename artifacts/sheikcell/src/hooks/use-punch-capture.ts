import { useState, useEffect, useCallback, useRef } from "react";

export type CamState = { status: "idle" | "loading" | "ok" | "error"; error?: string };
export type GeoState = { status: "idle" | "loading" | "ok" | "error"; lat?: number; lng?: number; accuracyMeters?: number; error?: string };

// Câmera (selfie) + geolocalização exigidas na batida de ENTRADA (source
// "self") — ver requirePhotoAndGeo / POST /rh-dp/me/punch em rhDp.ts.
// Compartilhado entre PontoGate.tsx (gate obrigatório ao abrir o sistema) e
// MeuPonto.tsx (quando a própria entrada é batida por ali, ex.: colaborador
// de escala flexível ou admin, que não passam pelo gate mas ainda mandam
// kind="in" — o backend exige os dois do mesmo jeito).
export function usePunchCapture(active: boolean) {
  const [cam, setCam] = useState<CamState>({ status: "idle" });
  const [geo, setGeo] = useState<GeoState>({ status: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Mensagem de erro específica por causa (antes era um texto genérico só de
  // "permissão" pra qualquer falha — mas getUserMedia falha por vários
  // motivos bem diferentes, e cada um pede uma ação diferente do usuário/loja:
  // permissão negada no navegador, câmera inexistente no aparelho, câmera já
  // em uso por outro programa/aba, contexto inseguro (http sem ser
  // localhost), ou nenhuma câmera satisfaz as restrições pedidas.
  function cameraErrorMessage(err: unknown): string {
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      return "A página precisa ser aberta em HTTPS para usar a câmera. Confira o endereço no navegador.";
    }
    const name = err instanceof Error ? err.name : "";
    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Permissão de câmera negada. Clique no ícone de cadeado/câmera ao lado do endereço no navegador, libere a câmera para este site e clique em \"Tentar acessar a câmera de novo\".";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "Nenhuma câmera foi encontrada neste computador/dispositivo. Conecte uma webcam (ou use um celular/notebook com câmera) para bater o ponto.";
      case "NotReadableError":
      case "TrackStartError":
        return "A câmera não pôde ser aberta — provavelmente está sendo usada por outro programa ou aba (ex.: Teams, Zoom, outra aba do navegador). Feche esses programas e tente de novo.";
      case "OverconstrainedError":
      case "ConstraintNotSatisfiedError":
        return "A câmera deste dispositivo não é compatível com a captura pedida. Tente outro navegador ou dispositivo.";
      case "SecurityError":
        return "O navegador bloqueou o acesso à câmera por segurança nesta página. Confira se o endereço começa com https://.";
      default:
        return "Não foi possível acessar a câmera. Libere a permissão de câmera no navegador e tente de novo.";
    }
  }

  const startCamera = useCallback(async () => {
    setCam({ status: "loading" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 480 }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        await videoRef.current.play().catch(() => {});
      }
      setCam({ status: "ok" });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[ponto] getUserMedia falhou:", err instanceof Error ? `${err.name}: ${err.message}` : err);
      setCam({ status: "error", error: cameraErrorMessage(err) });
    }
  }, []);

  const startGeo = useCallback(() => {
    if (!navigator.geolocation) {
      setGeo({ status: "error", error: "Seu navegador não suporta geolocalização." });
      return;
    }
    setGeo({ status: "loading" });
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({
        status: "ok",
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy,
      }),
      () => setGeo({ status: "error", error: "Não foi possível obter sua localização. Libere a permissão de localização no navegador e tente de novo." }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }, []);

  useEffect(() => {
    if (!active) return;
    startCamera();
    startGeo();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const ready = cam.status === "ok" && geo.status === "ok";

  // Tira a foto do frame atual do <video> e monta o payload pro POST /rh-dp/me/punch.
  // Retorna null se algo não estiver pronto (chamador não deveria chegar aqui
  // com o botão de bater ponto desabilitado, mas confere de novo por segurança).
  const capture = useCallback((): { photoBase64: string; mimetype: string; lat: number; lng: number; accuracyMeters: number | null } | null => {
    if (!ready || !videoRef.current || geo.lat == null || geo.lng == null) return null;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 480;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const photoBase64 = dataUrl.split(",")[1] ?? "";
    if (!photoBase64) return null;
    return { photoBase64, mimetype: "image/jpeg", lat: geo.lat, lng: geo.lng, accuracyMeters: geo.accuracyMeters ?? null };
  }, [ready, geo]);

  return { cam, geo, videoRef, ready, startCamera, startGeo, capture, stop };
}
