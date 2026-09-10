import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { api } from "@/lib/api";
import { CheckCircle2, Upload, Loader2, FileText, AlertTriangle } from "lucide-react";

// Página PÚBLICA (sem login) — link gerado pelo RH em "Iniciar contratação"
// (RH.tsx) e enviado pro candidato/colaborador (WhatsApp, e-mail etc.), pra
// ele mesmo subir os próprios documentos de admissão em vez do RH ter que
// digitalizar/digitar tudo. Token secreto na URL é a única credencial —
// backend em GET/POST /rh-dp/public/:token (employeeHiring.ts).
const DOC_TYPES: { key: string; label: string }[] = [
  { key: "foto_3x4", label: "Foto 3x4" },
  { key: "rg", label: "RG (frente e verso)" },
  { key: "cpf", label: "CPF" },
  { key: "ctps", label: "Carteira de Trabalho (CTPS)" },
  { key: "comprovante_residencia", label: "Comprovante de residência" },
  { key: "titulo_eleitor", label: "Título de eleitor" },
  { key: "pis_nit", label: "PIS/NIT" },
  { key: "certidao_civil", label: "Certidão de nascimento/casamento" },
  { key: "carteira_vacinacao", label: "Carteira de vacinação (dependentes)" },
  { key: "exame_admissional", label: "Exame admissional (ASO)" },
  { key: "reservista", label: "Certificado de reservista" },
];

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Erro ao ler arquivo"));
    reader.readAsDataURL(file);
  });
}

export default function HiringDocumentsUpload() {
  const { token } = useParams<{ token: string }>();
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [outroLabel, setOutroLabel] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = () => {
    if (!token) { setError("Link inválido"); setLoading(false); return; }
    api.rhDp.public.get(token)
      .then((r) => { setEmployeeName(r.employeeName); setUploaded(new Set(r.uploadedDocTypes)); })
      .catch((e) => setError(e instanceof Error ? e.message : "Link inválido ou expirado"))
      .finally(() => setLoading(false));
  };
  useEffect(load, [token]);

  const upload = async (docType: string, file: File, label?: string) => {
    if (!token) return;
    setUploadingKey(docType);
    setUploadError(null);
    try {
      const base64 = await readFileAsBase64(file);
      await api.rhDp.public.uploadDocument(token, {
        docType, label, fileName: file.name, mimeType: file.type || "application/octet-stream", data: base64,
      });
      setUploaded((prev) => new Set(prev).add(docType));
      if (docType === "outro") setOutroLabel("");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Erro ao enviar arquivo");
    } finally {
      setUploadingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="w-8 h-8 rounded-full border-4 border-neutral-300 border-t-neutral-600 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 px-4">
        <div className="text-center text-neutral-500 max-w-sm">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
          <p className="font-semibold text-neutral-700">{error}</p>
          <p className="text-sm mt-1">Peça um novo link para quem está cuidando da sua contratação.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 pb-16">
      <header className="bg-white border-b border-neutral-200">
        <div className="max-w-lg mx-auto px-4 py-4">
          <h1 className="font-bold text-neutral-900">Envio de documentos</h1>
          <p className="text-sm text-neutral-500">{employeeName ? `Olá, ${employeeName.split(" ")[0]}!` : ""} Envie os documentos abaixo pra seguir com sua contratação.</p>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-5 space-y-3">
        {uploadError && (
          <div className="bg-red-50 border border-red-100 text-red-600 text-sm rounded-xl px-3 py-2">{uploadError}</div>
        )}

        {DOC_TYPES.map(({ key, label }) => {
          const done = uploaded.has(key);
          const isUploading = uploadingKey === key;
          return (
            <div key={key} className="bg-white rounded-2xl border border-neutral-200 p-4 flex items-center gap-3" data-testid={`hiring-doc-${key}`}>
              <FileText className="w-4 h-4 text-neutral-400 shrink-0" />
              <span className="flex-1 text-sm font-medium text-neutral-800">{label}</span>
              {done && <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />}
              <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold cursor-pointer shrink-0 ${isUploading ? "bg-neutral-100 text-neutral-400" : done ? "bg-neutral-100 text-neutral-600 hover:bg-neutral-200" : "bg-neutral-900 text-white hover:bg-neutral-800"}`}>
                {isUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                {isUploading ? "Enviando..." : done ? "Enviar outra" : "Enviar"}
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={isUploading}
                  onChange={(ev) => { const f = ev.target.files?.[0]; if (f) upload(key, f); ev.target.value = ""; }} />
              </label>
            </div>
          );
        })}

        <div className="bg-white rounded-2xl border border-dashed border-neutral-300 p-4 space-y-2">
          <p className="text-sm font-medium text-neutral-800">Outro documento</p>
          <div className="flex gap-2">
            <input value={outroLabel} onChange={(e) => setOutroLabel(e.target.value)} placeholder="Nome do documento"
              className="flex-1 px-3 py-2 rounded-xl border border-neutral-300 text-sm" />
            <label className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-bold cursor-pointer shrink-0 ${uploadingKey === "outro" || !outroLabel.trim() ? "bg-neutral-100 text-neutral-400" : "bg-neutral-900 text-white hover:bg-neutral-800"}`}>
              {uploadingKey === "outro" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              Enviar
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploadingKey === "outro" || !outroLabel.trim()}
                onChange={(ev) => { const f = ev.target.files?.[0]; if (f) upload("outro", f, outroLabel.trim()); ev.target.value = ""; }} />
            </label>
          </div>
        </div>

        <p className="text-xs text-neutral-400 text-center pt-2">Só você e a equipe de RH têm acesso a estes arquivos.</p>
      </main>
    </div>
  );
}
