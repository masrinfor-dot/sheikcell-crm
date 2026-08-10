import { Resend } from "resend";

// Inicialização preguiçosa: diferente da integração de IA, e-mail não é
// crítico pro boot do servidor. Se RESEND_API_KEY não estiver setada, o
// servidor sobe normalmente e só falha (com erro capturável) na hora de
// efetivamente enviar um e-mail.
let client: Resend | null = null;
function getClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY não configurada — envio de e-mail desabilitado.");
  }
  if (!client) client = new Resend(apiKey);
  return client;
}

export async function sendEmail(params: { to: string; subject: string; html: string }): Promise<void> {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) {
    throw new Error("EMAIL_FROM não configurado — defina o remetente verificado no Resend.");
  }
  const { error } = await getClient().emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
  });
  if (error) throw new Error(`Falha ao enviar e-mail: ${error.message}`);
}
