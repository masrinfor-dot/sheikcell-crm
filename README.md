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
