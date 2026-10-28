# sheikcell-crm
CRM de atendimento WhatsApp da Sheikcell 

## Integração com o ERP Prumo

Configurada por loja na tela de configurações (cartão "ERP Prumo"): endereço da
API do ERP e a chave gerada no ERP em Auxiliares › Integrações com o acesso
"Mensagens das OS". A chave fica cifrada no banco (tabela
`tenant_erp_integrations`) — não há variável de ambiente nova.

- **Mensagens das OS**: com o interruptor ligado, o CRM busca a cada minuto as
  mensagens das ordens de serviço no ERP e manda pelo WhatsApp.
- **Situação da OS pelo robô**: com a chave salva, quando o cliente pergunta da
  OS ("Quero falar sobre a OS LJ01-2026-0004", "meu celular já ficou pronto?"),
  o robô consulta `GET /integrations/service-orders/status` com o número de
  WhatsApp de quem escreveu e responde a situação, a previsão, a loja e, se
  estiver pronto, o valor para retirar. O ERP só devolve OS do cliente com esse
  celular. Sem OS no número, ou com o ERP fora do ar (espera até 8 s), o robô
  segue o fluxo normal e passa para um atendente.

## Pontuação do atendimento e fila da TV da loja (ERP Prumo, 27/10/2026)

No cartão "ERP Prumo" (Configurações › Integrações › Conexões), com a ligação salva:

- **Enviar pontuação de atendimento ao ERP** (nasce ligado): a cada minuto o CRM
  olha as conversas e manda à gamificação do ERP
  (`POST /integrations/gamification/v1/events`, contrato v1) a **primeira
  resposta** de cada atendimento (segundos), a conversa **sem resposta além do
  limite do alarme** da Central (Configurar alerta; padrão 5 min) e a **conversa
  que virou venda** (lida do ERP em `GET /integrations/sales/attributed`). Fila
  durável `erp_gamification_events` (eventId único, lotes de até 200, novas
  tentativas com espera crescente; ERP fora do ar não perde nada). Só ids e
  números — nunca texto, nome ou celular do cliente. Conta a partir de quando foi
  ligado. Resultado de cada evento (pontuou, atendente sem usuário, regra
  desligada…) na aba **Trocas com o ERP**.
- **Mostrar "Clientes esperando resposta" na TV da loja** (nasce ligado): a cada
  minuto manda por loja do ERP (`POST /integrations/crm-waiting/v1/snapshot`) só
  primeiro nome + inicial, canal, setor e tempo de espera. Precisa ligar as lojas
  em **Lojas no ERP** (loja daqui → loja do ERP; sem loja, vale a linha de WhatsApp).
- A chave do ERP precisa dos acessos "Eventos de atendimento (gamificação)",
  "Fila de espera do atendimento (TV da loja)", "Lojas" e "Vendas do atendimento".
