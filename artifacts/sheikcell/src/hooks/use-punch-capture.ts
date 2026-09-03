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
    } catch {
      setCam({ status: "error", error: "Não foi possível acessar a câmera. Libere a permissão de câmera no navegador e tente de novo." });
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
