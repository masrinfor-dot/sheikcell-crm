import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "wouter";
import { api, type RhStage } from "@/lib/api";
import { Video, CheckCircle, Circle, StopCircle, RotateCcw, Send } from "lucide-react";

const DEFAULT_MAX_VIDEO_SECONDS = 60;

// Página PÚBLICA do candidato (sem login): responde as etapas configuradas
// pelo admin (pré-entrevista, teste de perfil, prova escrita, vídeo) e envia.
export default function Candidatura() {
  const { token } = useParams<{ token: string }>();
  const [stages, setStages] = useState<RhStage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(-1); // -1 = dados pessoais
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!token) { setError("Link inválido"); return; }
    api.rh.publicProcess(token)
      .then((r) => setStages(r.stages))
      .catch((e) => setError(e instanceof Error ? e.message : "Link inválido ou expirado"));
  }, [token]);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);
  useEffect(() => () => { stopStream(); if (videoUrl) URL.revokeObjectURL(videoUrl); }, [stopStream, videoUrl]);

  // Etapa atual e duração máxima do vídeo dela — configurável por empresa
  // (etapas antigas sem o campo caem no padrão de 60s; `null` = sem limite).
  const current = step >= 0 ? stages?.[step] ?? null : null;
  const maxSeconds = current?.type === "video"
    ? (current.maxVideoSeconds === undefined ? DEFAULT_MAX_VIDEO_SECONDS : current.maxVideoSeconds)
    : DEFAULT_MAX_VIDEO_SECONDS;

  const startRecording = async () => {
    setSubmitError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 }, audio: true });
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        previewRef.current.muted = true;
        previewRef.current.play().catch(() => {});
      }
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus"
        : MediaRecorder.isTypeSupported("video/webm") ? "video/webm"
        : MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 900_000 } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" });
        setVideoBlob(blob);
        setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
        stopStream();
        setRecording(false);
      };
      mediaRef.current = rec;
      rec.start();
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed((e) => {
          if (maxSeconds !== null && e + 1 >= maxSeconds) mediaRef.current?.state === "recording" && mediaRef.current.stop();
          return e + 1;
        });
      }, 1000);
    } catch {
      setSubmitError("Não foi possível acessar a câmera. Libere a permissão de câmera e microfone no navegador.");
    }
  };

  const stopRecording = () => { if (mediaRef.current?.state === "recording") mediaRef.current.stop(); };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="shk-card p-8 text-center max-w-sm">
          <p className="font-bold text-sm">Link inválido ou expirado</p>
          <p className="text-xs text-muted-foreground mt-1">Peça um novo link para a loja.</p>
        </div>
      </div>
    );
  }
  if (!stages) {
    return <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
    </div>;
  }
  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="shk-card p-8 text-center max-w-sm">
          <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-3" />
          <p className="font-bold">Candidatura enviada!</p>
          <p className="text-xs text-muted-foreground mt-1">Obrigado, {name.split(" ")[0]}. Se o seu perfil for selecionado, entraremos em contato pelo telefone informado.</p>
        </div>
      </div>
    );
  }

  const setAns = (sid: string, qid: string, v: string) =>
    setAnswers((a) => ({ ...a, [sid]: { ...(a[sid] ?? {}), [qid]: v } }));
  const stageComplete = (s: RhStage) =>
    s.type === "video" ? !!videoBlob : s.questions.every((q) => (answers[s.id]?.[q.id] ?? "").trim());

  const handleSubmit = async () => {
    if (sending || !token) return;
    setSending(true);
    setSubmitError(null);
    try {
      let videoData: string | undefined;
      let videoMime: string | undefined;
      if (videoBlob) {
        const buf = new Uint8Array(await videoBlob.arrayBuffer());
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
        videoData = btoa(bin);
        videoMime = videoBlob.type || "video/webm";
      }
      await api.rh.publicApply(token, { name, phone, email: email || undefined, answers, videoData, videoMime });
      setDone(true);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Erro ao enviar. Tente novamente.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="text-center mb-2">
          <h1 className="text-xl font-extrabold">Trabalhe Conosco</h1>
          <p className="text-xs text-muted-foreground">Preencha as etapas abaixo para se candidatar.</p>
        </div>

        {/* progresso */}
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${step === -1 ? "bg-primary text-white" : "bg-green-100 text-green-700"}`}>Seus dados</span>
          {stages.map((s, i) => (
            <span key={s.id} className={`text-[10px] font-bold px-2 py-1 rounded-full ${
              i === step ? "bg-primary text-white" : i < step ? "bg-green-100 text-green-700" : "bg-secondary text-muted-foreground"
            }`}>{s.title}</span>
          ))}
        </div>

        <div className="shk-card p-6">
          {step === -1 ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Nome completo *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-cand-name"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Telefone / WhatsApp *</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(00) 00000-0000" data-testid="input-cand-phone"
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">E-mail (opcional)</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
              </div>
              <button onClick={() => setStep(0)} disabled={!name.trim() || !phone.trim()} data-testid="button-cand-start"
                className="w-full px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-40">
                Começar
              </button>
            </div>
          ) : current ? (
            <div className="space-y-4">
              <div>
                <h2 className="font-bold text-sm">{current.title}</h2>
                {current.description && <p className="text-xs text-muted-foreground mt-0.5">{current.description}</p>}
              </div>

              {current.type === "form" ? (
                <div className="space-y-4">
                  {current.questions.map((q, qi) => (
                    <div key={q.id}>
                      <p className="text-xs font-bold mb-1.5">{qi + 1}. {q.label}</p>
                      {q.type === "options" ? (
                        <div className="space-y-1">
                          {(q.options ?? []).map((opt) => (
                            <button key={opt} onClick={() => setAns(current.id, q.id, opt)}
                              className={`w-full text-left px-3 py-2 rounded-xl text-xs font-medium border transition flex items-center gap-2 ${
                                answers[current.id]?.[q.id] === opt ? "bg-primary text-white border-primary" : "bg-white border-border hover:bg-secondary"
                              }`}>
                              {answers[current.id]?.[q.id] === opt ? <CheckCircle className="w-3.5 h-3.5 shrink-0" /> : <Circle className="w-3.5 h-3.5 shrink-0 opacity-40" />}
                              {opt}
                            </button>
                          ))}
                        </div>
                      ) : q.type === "longtext" ? (
                        <textarea rows={4} value={answers[current.id]?.[q.id] ?? ""} onChange={(e) => setAns(current.id, q.id, e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm resize-none" />
                      ) : (
                        <input value={answers[current.id]?.[q.id] ?? ""} onChange={(e) => setAns(current.id, q.id, e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-border text-sm" />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {!videoUrl ? (
                    <>
                      <div className="aspect-video bg-black rounded-xl overflow-hidden flex items-center justify-center">
                        <video ref={previewRef} className="w-full h-full object-cover" playsInline />
                      </div>
                      {recording ? (
                        <button onClick={stopRecording} data-testid="button-stop-recording"
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-red-600 text-white text-sm font-bold">
                          <StopCircle className="w-4 h-4" /> Parar {maxSeconds !== null ? `(${Math.max(0, maxSeconds - elapsed)}s restantes)` : "(gravando)"}
                        </button>
                      ) : (
                        <button onClick={startRecording} data-testid="button-start-recording"
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-white text-sm font-bold">
                          <Video className="w-4 h-4" /> Gravar vídeo {maxSeconds !== null ? `(até ${maxSeconds}s)` : "(sem limite de tempo)"}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <video src={videoUrl} controls playsInline className="w-full aspect-video bg-black rounded-xl" />
                      <button onClick={() => { setVideoBlob(null); if (videoUrl) URL.revokeObjectURL(videoUrl); setVideoUrl(null); }}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border text-xs font-bold text-muted-foreground">
                        <RotateCcw className="w-3.5 h-3.5" /> Regravar
                      </button>
                    </>
                  )}
                </div>
              )}

              {submitError && <p className="text-xs font-semibold text-red-600">{submitError}</p>}

              <div className="flex gap-2">
                <button onClick={() => setStep((s) => s - 1)}
                  className="px-4 py-2.5 rounded-xl border border-border text-xs font-bold text-muted-foreground">Voltar</button>
                {step < stages.length - 1 ? (
                  <button onClick={() => setStep((s) => s + 1)} disabled={!stageComplete(current)} data-testid="button-cand-next"
                    className="flex-1 px-4 py-2.5 rounded-xl bg-primary text-white text-xs font-bold disabled:opacity-40">
                    Próxima etapa
                  </button>
                ) : (
                  <button onClick={handleSubmit} disabled={!stageComplete(current) || sending} data-testid="button-cand-submit"
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-green-600 text-white text-xs font-bold disabled:opacity-40">
                    <Send className="w-3.5 h-3.5" /> {sending ? "Enviando..." : "Enviar candidatura"}
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
