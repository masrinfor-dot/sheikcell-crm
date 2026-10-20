// Documentos da loja passados pro ERP (17/10/2026): depois que o admin
// desliga aqui (Documentos › "Desligar no CRM"), o CRM para de aceitar
// envio/exclusão manual de documentos; a lista continua só para consulta.
import { appSetting } from "./tradeInMoved";

export const DOCUMENTS_MOVED_KEY = "documents_moved_to_erp";
export const DOCUMENTS_ERP_URL_KEY = "documents_erp_url";

export async function documentsMovedToErp(tenantId: number): Promise<boolean> {
  return (await appSetting(tenantId, DOCUMENTS_MOVED_KEY)) === "true";
}
