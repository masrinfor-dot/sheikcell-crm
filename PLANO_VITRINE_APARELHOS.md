# Vitrine Aparelhos — o que foi construído (Fase 1)

**Status:** código escrito, aplicado no repo local (`sheikcell-crm` em `C:\Users\masri\Desktop\sheikcell-crm`) e **testado de ponta a ponta** (ver seção "O que foi testado" abaixo). Falta só 1 passo manual antes de produção: configurar 1 variável de ambiente no EasyPanel.

## O que o vídeo mostrava (referência: app "iMoove | Vitrine para iPhone")

1. Vitrine pública de aparelhos (link compartilhável) com foto, modelo, preço e botão de WhatsApp.
2. Importação de lista de fornecedor: cola o texto bagunçado, a IA organiza em Modelo/Armazenamento/Condição/Preço, com tela de revisão (Aprovados/Pendências) antes de confirmar.
3. Mensagem formatada pra mandar no WhatsApp (📱 modelo / 🎨 cores / 💰 preço).

## O que foi pedido a mais nesta conversa

Uma tabela de preço: a partir do **custo**, aplicar **margem de lucro bruto (%)**, **taxa de parcelamento no cartão (%)** e **custo de nota fiscal (%)** pra formar o **preço de venda** automaticamente.

## O que foi construído

### Módulo novo: "Vitrine Aparelhos"
Aparece como aba (Atendimento → Vitrine Aparelhos) pra admin, supervisor e vendedor com o módulo liberado — mesmo mecanismo de "Avaliação de Usados" (contratação por loja em `enabled_modules` + acesso por usuário view/edit).

### Banco de dados (`lib/db/src/schema/catalog.ts` + migration `0051_catalog_vitrine.sql`)
- `catalog_products`: modelo, armazenamento, condição (lacrado/seminovo/CPO/usado), cores, custo, margem própria (opcional), preço de venda, estoque, status, fotos.
- `catalog_product_photos`: fotos do aparelho (arquivo em disco, só metadado no banco).
- `tenants.catalog_slug`: endereço da vitrine pública (`/vitrine/minha-loja`).
- Migration libera o módulo "vitrine" pra todas as lojas já existentes por padrão (o superadmin desliga por loja se não quiser oferecer).

### Formação de preço (`artifacts/api-server/src/lib/catalogPricing.ts`)
```
preço de venda = (custo + nota fiscal%) ÷ (1 − margem% − taxa do cartão%)
```
Método padrão de varejo (markup divisor): garante a margem de lucro bruto **depois** de descontar a taxa do cartão e o custo de nota fiscal, em vez de aplicar a margem só em cima do custo puro. Configurável em Vitrine Aparelhos → "Preço e cartão": margem padrão, custo de nota fiscal e a taxa de cada quantidade de parcelas (1x a 18x). Cada produto pode ter margem própria (sobrescreve a padrão) e o preço final sempre pode ser ajustado na mão.

### Backend (`artifacts/api-server/src/routes/catalog.ts`)
- CRUD de produtos + fotos (JPEG/PNG/WEBP, valida o conteúdo real do arquivo, não só a extensão).
- Configurações de preço (GET/PUT) + simulador de preço (usado pela calculadora ao vivo no formulário).
- Endereço da vitrine pública (GET/PUT do slug).
- Importação por IA: `POST /catalog/import/parse` (cola a lista → a IA devolve os itens estruturados, com `status: approved | pending` quando falta modelo ou preço) e `POST /catalog/import/confirm` (grava os produtos revisados).
- Rotas públicas sem login, num prefixo separado (`/catalog-public/...`) pra nunca exigir sessão: listagem da vitrine por slug (nunca expõe custo/margem, só preço de venda) e o arquivo da foto.

### Frontend
- `VitrineAparelhos.tsx`: lista de produtos, cadastro/edição com calculadora de preço ao vivo, upload de fotos, importação por IA (tela de revisão com abas Aprovados/Pendências, igual ao vídeo), configurações de preço, endereço público editável, botão "copiar catálogo pro WhatsApp" (mensagem formatada com emoji, igual ao vídeo) e botão de copiar mensagem por produto.
- `VitrinePublica.tsx`: página pública (`/vitrine/:slug`, sem login) — grade de aparelhos com foto, preço e botão "Falar no WhatsApp" (abre `wa.me` já com a mensagem preenchida).
- Aba "Vitrine Aparelhos" cadastrada no painel do admin/supervisor e do vendedor, com o ícone de celular.

## O que foi testado (rodei tudo de verdade, não só revisão visual)

Como o bridge remoto não conseguia rodar `pnpm`/`tsc` direto na pasta montada do Windows (erro de I/O no `node_modules` do pnpm), copiei o código-fonte (sem `node_modules`/`dist`) para um ambiente Linux isolado, instalei as dependências do zero e rodei o projeto de verdade lá:

1. **`pnpm run typecheck` completo do monorepo** (mesmo comando que você rodaria) — **0 erros**, incluindo `catalog.ts`, `VitrineAparelhos.tsx`, `VitrinePublica.tsx`, o schema novo e a lib de preço.
2. **Build de produção do backend** (`node build.mjs`, esbuild) — gerou o bundle sem erro.
3. **Build de produção do frontend** (`vite build`) — gerou o bundle sem erro, com as duas telas novas incluídas (1893 módulos).
4. **Migration num Postgres real**: subi um Postgres 16 do zero, apliquei o schema base + as 51 migrations na ordem exata que o boot aplica — todas passaram, incluindo a `0051_catalog_vitrine.sql`. Rodei de novo pra confirmar que é idempotente (não quebra rodando 2x, como acontece a cada boot). Conferi a tabela resultante (`catalog_products`, `catalog_product_photos`, `tenants.catalog_slug`) e o backfill do módulo "vitrine" no `enabled_modules` — tudo correto.
5. **Fórmula de preço**: testei `calcularPrecoVenda` com números reais (custo 3000, margem 20%, cartão 4,5%, nota 6% → R$ 4.211,92) e bateu com a conta na mão. Testei também o "trava de segurança" pra quando alguém salva margem+cartão somando 100% ou mais (não deixa o preço explodir).

Isso cobre tudo que dá pra testar sem subir o servidor de verdade com WhatsApp/OpenAI conectados. O que eu **não** testei (precisa do ambiente real): clicar pela interface, mandar uma lista de fornecedor real pra IA organizar, e upload de foto de verdade.

## Antes de usar em produção — 1 passo manual

**Configurar `CATALOG_MEDIA_DIR` no EasyPanel** — mesmíssimo problema que já foi diagnosticado pra mídia do WhatsApp e documentos (ver `claude/diagnostico-arquivos-nao-abrem.md`): sem essa variável, as fotos dos aparelhos gravam num caminho que some no próximo redeploy. No serviço **api** do EasyPanel:
- usar o mesmo volume já montado em `/app/storage` (ver o diagnóstico anterior);
- adicionar a variável `CATALOG_MEDIA_DIR=/app/storage/catalog`.

Se isso não for feito, o cadastro de aparelhos funciona normalmente, só as fotos que desaparecem no próximo deploy.

## Ficou de fora da Fase 1 (próximos passos, se quiser)

- Enviar o catálogo automaticamente **dentro da conversa do WhatsApp** (hoje é "copiar e colar" manual) — dá pra integrar com `lib/outbound.ts` depois.
- Catálogo por loja (hoje é por loja-tenant inteira, não por unidade física quando a rede tem mais de uma loja).
- Botão "Ver detalhes" com página individual do aparelho (hoje a vitrine pública é só a grade).
