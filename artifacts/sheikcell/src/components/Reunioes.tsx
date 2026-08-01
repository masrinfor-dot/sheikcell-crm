import { useState, useEffect, useRef, useCallback } from "react";
import { api, type MeetingItem, type DocumentItem } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Video, Plus, X, Mic, Square, Loader2, FileText, ListChecks, ScrollText, Trash2, Eye,
} from "lucide-react";

/**
 * Reuniões online da equipe: sala de vídeo (Jitsi), gravação do áudio no
 * navegador de quem grava, transcrição por IA e geração de documentos
 * (ata/resumo/tarefas) que caem direto na área de Documentos.
 */
export default function Reunioes({ onDocumentCreated }: { onDocumentCreated: (doc: DocumentItem) => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [openMeeting, setOpenMeeting] = useState<MeetingItem | null>(null);
  const [showTranscript, setShowTranscript] = useState<MeetingItem | null>(null);
  const [generating, setGenerating] = useState<string | null>(null); // "id-kind"

  // Gravação
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Dona da gravação: fixada ao APERTAR gravar, para não se perder se o
  // usuário fechar/trocar de sala enquanto a transcrição roda.
  const recMeetingRef = useRef<MeetingItem | null>(null);

  const canManage = user?.role === "admin" || user?.role === "supervisor";

  useEffect(() => {
    api.meetings.list().then(setMeetings).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const stopAllTracks = useCallback(() => {
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
  }, []);

  useEffect(() => () => { // desmontou no meio: solta microfone/aba
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
    stopAllTracks();
  }, [stopAllTracks]);

  const createMeeting = async () => {
    const title = newTitle.trim();
    if (!title) { toast({ title: "Dê um nome à reunião", variant: "destructive" }); return; }
    setCreating(true);
    try {
      const m = await api.meetings.create(title);
      setMeetings((prev) => [{ ...m, creatorName: user?.name ?? null }, ...prev]);
      setShowNew(false); setNewTitle("");
      setOpenMeeting(m);
    } catch (err) {
      toast({ title: "Erro ao criar reunião", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setCreating(false); }
  };

  // ── Gravação: microfone + (se o usuário permitir) áudio da aba da reunião ──
  const startRecording = async () => {
    if (recording || processing || !openMeeting) return;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamsRef.current.push(mic);
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(mic).connect(dest);
      // Tenta capturar também o áudio da aba (vozes dos outros participantes).
      try {
        const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        streamsRef.current.push(disp);
        if (disp.getAudioTracks().length > 0) {
          ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(dest);
        } else {
          toast({ title: "Sem áudio da aba — gravando só o seu microfone", description: "Para gravar todo mundo: compartilhe ESTA guia e marque \"Compartilhar áudio da guia\"." });
        }
        disp.getVideoTracks().forEach((t) => { t.onended = () => stopRecording(); });
      } catch {
        toast({ title: "Gravando só o seu microfone", description: "Para gravar todo mundo, aceite compartilhar a guia com áudio." });
      }
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 32000 });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => void handleRecordingReady();
      rec.start(1000);
      recorderRef.current = rec;
      recMeetingRef.current = openMeeting;
      setRecording(true);
      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (err) {
      stopAllTracks();
      toast({ title: "Não consegui acessar o microfone", description: err instanceof Error ? err.message : "Verifique a permissão do navegador", variant: "destructive" });
    }
  };

  const stopRecording = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setRecording(false);
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop(); // onstop → handleRecordingReady
    stopAllTracks();
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  };

  const handleRecordingReady = async () => {
    const meeting = recMeetingRef.current;
    recMeetingRef.current = null;
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    recorderRef.current = null;
    if (!meeting || blob.size < 2000) { toast({ title: "Gravação muito curta", variant: "destructive" }); return; }
    if (blob.size > 20 * 1024 * 1024) { toast({ title: "Gravação muito grande (máx. 20MB / ~1h30)", variant: "destructive" }); return; }
    setProcessing(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Falha ao ler a gravação"));
        reader.readAsDataURL(blob);
      });
      const { transcript } = await api.meetings.uploadRecording(meeting.id, { mimeType: "audio/webm", data: base64 });
      setMeetings((prev) => prev.map((m) => m.id === meeting.id ? { ...m, status: "transcrita", transcript, recordingBytes: blob.size } : m));
      setOpenMeeting((m) => m && m.id === meeting.id ? { ...m, status: "transcrita", transcript } : m);
      toast({ title: "Reunião transcrita! 🎉", description: "Agora você pode gerar a ata, o resumo ou as tarefas." });
    } catch (err) {
      toast({ title: "Falha ao transcrever a gravação", description: err instanceof Error ? err.message : "Tente de novo", variant: "destructive" });
    } finally { setProcessing(false); }
  };

  const generateDoc = async (m: MeetingItem, kind: "ata" | "resumo" | "tarefas") => {
    const key = `${m.id}-${kind}`;
    if (generating) return;
    setGenerating(key);
    try {
      const doc = await api.meetings.generate(m.id, kind);
      onDocumentCreated(doc);
      toast({ title: "Documento pronto! 📄", description: `"${doc.title}" foi salvo na lista de documentos abaixo.` });
    } catch (err) {
      toast({ title: "Erro ao gerar documento", description: err instanceof Error ? err.message : "Erro", variant: "destructive" });
    } finally { setGenerating(null); }
  };

  const deleteMeeting = async (m: MeetingItem) => {
    if (!confirm(`Excluir a reunião "${m.title}"? A gravação e a transcrição serão apagadas (documentos já gerados ficam).`)) return;
    try {
      await api.meetings.remove(m.id);
      setMeetings((prev) => prev.filter((x) => x.id !== m.id));
    } catch { toast({ title: "Erro ao excluir", variant: "destructive" }); }
  };

  const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const statusBadge = (s: string) =>
    s === "transcrita" ? { label: "Transcrita", cls: "bg-emerald-100 text-emerald-700" }
    : s === "gravada" ? { label: "Gravada", cls: "bg-amber-100 text-amber-700" }
    : { label: "Sala aberta", cls: "bg-blue-100 text-blue-700" };

  const genButtons = (m: MeetingItem) => (
    <div className="flex gap-1.5 flex-wrap">
      {([["ata", "Gerar ata", ScrollText], ["resumo", "Resumo", FileText], ["tarefas", "Tarefas", ListChecks]] as const).map(([kind, label, Icon]) => (
        <button key={kind} onClick={() => generateDoc(m, kind)} disabled={!!generating}
          data-testid={`button-generate-${kind}-${m.id}`}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/20 rounded-lg px-2 py-1 transition disabled:opacity-50">
          {generating === `${m.id}-${kind}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />} {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Video className="w-5 h-5 text-primary" />
          <h2 className="text-base font-bold">Reuniões online</h2>
          <span className="text-xs text-muted-foreground hidden sm:inline">grave, transcreva e gere a ata com IA</span>
        </div>
        <button onClick={() => { setNewTitle(""); setShowNew(true); }} data-testid="button-new-meeting"
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-xl text-xs font-semibold hover:bg-primary/90 transition">
          <Plus className="w-3.5 h-3.5" /> Nova reunião
        </button>
      </div>

      {loading ? (
        <div className="h-16 rounded-xl bg-secondary animate-pulse" />
      ) : meetings.length === 0 ? (
        <p className="text-xs text-muted-foreground bg-white border border-border rounded-xl px-4 py-3">
          Nenhuma reunião ainda. Crie uma sala, chame a equipe pelo link e grave — a IA transforma a conversa em ata, resumo e lista de tarefas. 🎙️
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {meetings.map((m) => {
            const b = statusBadge(m.status);
            return (
              <div key={m.id} data-testid={`meeting-card-${m.id}`} className="bg-white rounded-xl border border-border p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-sm truncate">{m.title}</p>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${b.cls}`}>{b.label}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(m.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                  {m.creatorName ? ` · por ${m.creatorName}` : ""}
                </p>
                <div className="flex gap-1.5 flex-wrap items-center">
                  <button onClick={() => setOpenMeeting(m)} data-testid={`button-join-meeting-${m.id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-white bg-primary hover:bg-primary/90 rounded-lg px-2.5 py-1.5 transition">
                    <Video className="w-3.5 h-3.5" /> Entrar na sala
                  </button>
                  {m.transcript && (
                    <button onClick={() => setShowTranscript(m)} data-testid={`button-view-transcript-${m.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:bg-secondary rounded-lg px-2 py-1.5 transition">
                      <Eye className="w-3.5 h-3.5" /> Transcrição
                    </button>
                  )}
                  {canManage && (
                    <button onClick={() => deleteMeeting(m)} data-testid={`button-delete-meeting-${m.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg px-2 py-1.5 transition ml-auto">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {m.transcript && genButtons(m)}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal: nova reunião */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3" onClick={() => setShowNew(false)}>
          <div className="bg-card rounded-xl w-full max-w-sm shadow-xl border p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="font-semibold text-sm flex items-center gap-2"><Video className="w-4 h-4 text-primary" /> Nova reunião</p>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus
              onKeyDown={(e) => e.key === "Enter" && createMeeting()}
              data-testid="input-meeting-title" placeholder="Ex.: Reunião de metas — agosto"
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
            <button onClick={createMeeting} disabled={creating} data-testid="button-create-meeting"
              className="w-full py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition">
              {creating ? "Criando..." : "Criar e entrar na sala"}
            </button>
          </div>
        </div>
      )}

      {/* Modal: sala de reunião (Jitsi) */}
      {openMeeting && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#111]">
            <p className="text-white text-sm font-semibold truncate">🎥 {openMeeting.title}</p>
            <div className="flex items-center gap-2">
              {processing ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                  <Loader2 className="w-4 h-4 animate-spin" /> Transcrevendo…
                </span>
              ) : recording ? (
                <button onClick={stopRecording} data-testid="button-stop-recording"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold animate-pulse">
                  <Square className="w-3.5 h-3.5" /> Parar gravação · {fmtDur(recSeconds)}
                </button>
              ) : (
                <button onClick={startRecording} data-testid="button-start-recording"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-500 transition">
                  <Mic className="w-3.5 h-3.5" /> Gravar reunião
                </button>
              )}
              <button onClick={() => { if (recording) stopRecording(); setOpenMeeting(null); }}
                data-testid="button-close-meeting"
                title={processing ? "Pode fechar — aviso quando a transcrição terminar" : "Fechar"}
                className="p-1.5 rounded-lg text-white hover:bg-white/10 transition">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          {recording && (
            <p className="text-[11px] text-amber-200 bg-amber-900/60 px-3 py-1">
              🔴 Gravando. Dica: ao compartilhar, escolha <b>esta guia</b> e marque <b>"Compartilhar áudio da guia"</b> para gravar a voz de todos.
            </p>
          )}
          <iframe
            title="Sala de reunião"
            src={`https://meet.jit.si/${encodeURIComponent(openMeeting.roomCode)}#userInfo.displayName="${encodeURIComponent(user?.name ?? "Equipe")}"&config.prejoinConfig.enabled=false`}
            allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write"
            className="flex-1 w-full border-0"
          />
        </div>
      )}

      {/* Modal: transcrição */}
      {showTranscript && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-3" onClick={() => setShowTranscript(null)}>
          <div className="bg-card rounded-xl w-full max-w-lg shadow-xl border overflow-hidden flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm truncate">Transcrição — {showTranscript.title}</span>
              <button onClick={() => setShowTranscript(null)} className="p-1 rounded hover:bg-muted/60"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 overflow-y-auto text-sm whitespace-pre-wrap text-foreground/90">{showTranscript.transcript}</div>
            <div className="px-4 py-3 border-t">{genButtons(showTranscript)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
