/**
 * Regras de persistência das linhas de whatsapp_sessions (conexões WhatsApp).
 *
 * Bug 13/10 ("mesmo excluindo a conexão do WhatsApp ela continua
 * aparecendo"): a listagem do painel (polling a cada 2,5s) e o bridge
 * gravavam o status ao vivo com UPSERT. Se a exclusão acontecia entre a
 * leitura das linhas e a gravação do status, o UPSERT reinseria a conexão
 * apagada — sem nome (o card voltava como "t1-..."), e a listagem seguinte
 * pedia ao bridge pra iniciá-la de novo → "Aguardando QR" para sempre.
 *
 * Regra: só o cadastro explícito (POST /whatsapp/sessions) cria linha.
 * Gravação de status apenas ATUALIZA linha existente — com a única exceção
 * da conexão principal legada "default" da loja 1, que nunca é excluída.
 */
export const DEFAULT_SESSION_KEY = "default";

export function mayInsertOnStatusPersist(tenantId: number, sessionKey: string): boolean {
  return tenantId === 1 && sessionKey === DEFAULT_SESSION_KEY;
}
