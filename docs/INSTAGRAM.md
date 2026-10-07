# Instagram Direct no Atendimento

Desde 07/10/2026 as mensagens do Direct da conta profissional da loja entram
no Atendimento como conversas (ícone do Instagram). A resposta do vendedor
volta pelo Direct, e fotos, vídeos, áudios e arquivos vão nos dois sentidos.

Usa a **API do Instagram com login do Instagram**. Não precisa de Página do
Facebook.

## O que precisa antes

- Conta do Instagram **profissional** (Empresa ou Criador de conteúdo):
  app do Instagram → Configurações → Tipo de conta.
- No app do Instagram: Configurações → Mensagens e respostas →
  Ferramentas conectadas → **Permitir acesso às mensagens** ligado.
- Conta em developers.facebook.com, com o mesmo login do Business da loja.

## Passo a passo

1. **Criar o app** em developers.facebook.com → Meus apps → Criar app:
   - caso de uso: "Gerenciar mensagens e conteúdo no Instagram";
   - tipo: **Empresa**.
2. No app, abra **Instagram → Configuração da API com login do Instagram**.
3. **Gerar token**: em "Gerar tokens de acesso", clique em **Adicionar conta**,
   entre com o Instagram da loja e aceite. Depois clique em **Gerar token** e
   copie.
4. Na mesma tela, copie a **Chave secreta do app do Instagram**. São 32
   caracteres e aparecem ao clicar em "Mostrar".
5. No CRM, vá em **Configurações → Integrações → Instagram Direct**:
   - cole o token e a chave secreta e clique em **Salvar**;
   - depois clique em **Testar conexão**. Aparece "@sua_conta", e o CRM já
     inscreve a conta para receber mensagens.
   - **Não mande o token nem a chave por chat**: cole direto na tela. Eles
     ficam criptografados e não aparecem de novo.
6. **Webhook**: de volta à tela da Meta, em "Configurar webhooks":
   - **URL de retorno**: copie do card no CRM
     (`https://…/api/instagram/webhook`);
   - **Verificar token**: copie do card no CRM (`sheikcell-ig-…`);
   - clique em **Verificar e salvar** e ative a assinatura do campo
     **messages**.
7. No CRM, escolha o **setor** que recebe as conversas e marque **Receber e
   responder o Direct no Atendimento**.
8. Teste: de outro Instagram, mande uma mensagem pra loja. Ela aparece no
   Atendimento em segundos.

## Liberar para todos os clientes

Enquanto o app estiver em **modo de desenvolvimento**, só chegam mensagens
de contas que têm papel no app. Para incluir uma conta: Funções do app →
Funções → Adicionar pessoas → Testador do Instagram, e a pessoa aceita em
Instagram → Configurações → Apps e sites.

Para receber de **qualquer** cliente:

1. Envie o app para **Análise do app** pedindo `instagram_business_basic` e
   `instagram_business_manage_messages`, com um vídeo curto mostrando o
   Direct chegando e sendo respondido no CRM.
2. Depois de aprovado, mude o app para **Ao vivo**.

A Meta também pede **Verificação da empresa** (CNPJ).

## Regras da Meta que valem no dia a dia

- **Janela de 24h**: só dá pra responder até 24h depois da última mensagem
  do cliente. Fora disso, o envio fica com ⚠️ e a tela avisa "Fora da janela
  de 24h".
- Não dá pra **iniciar** conversa com quem nunca mandou Direct pra loja.
- O token vale 60 dias. O CRM renova sozinho quando faltam menos de 15 dias.
  Se aparecer "Token expirado", gere outro (passo 3) e cole no CRM.
- Mensagem respondida pelo celular (app do Instagram) também aparece no
  Atendimento, como "Instagram (app)".

## Variável opcional

`PUBLIC_API_URL` (ex.: `https://crm.sheikcell.com.br/api`) fixa o endereço
usado no link do webhook e nos links temporários de mídia que a Meta baixa.
Sem ela, o endereço é montado a partir do domínio da requisição.
