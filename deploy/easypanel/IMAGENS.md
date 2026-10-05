# Deploy por imagem pronta (sem build no servidor)

Desde 05/10/2026, a cada push em `producao` com os testes verdes (workflow
"Testes"), o GitHub Actions (`.github/workflows/imagens.yml`) monta e publica
as imagens prontas no GitHub Container Registry (GHCR):

| Serviço  | Imagem                                               |
| -------- | ---------------------------------------------------- |
| api      | `ghcr.io/masrinfor-dot/sheikcell-crm-api:producao`      |
| web      | `ghcr.io/masrinfor-dot/sheikcell-crm-web:producao`      |
| whatsapp | `ghcr.io/masrinfor-dot/sheikcell-crm-whatsapp:producao` |

Cada versão também ganha a tag com os 7 primeiros caracteres do commit
(ex.: `:d225b2d`), para voltar atrás quando precisar.

Antes, o "Gatilho de Implantação" fazia o EasyPanel **compilar** os três
serviços no próprio servidor (minutos de CPU em 100% a cada deploy, deixando
o CRM e o ERP lentos — e o WhatsApp caindo no meio do expediente). Com a
origem em **Docker Image**, o mesmo gatilho só **baixa** a imagem e reinicia
o container: segundos, não minutos.

## Trocar a origem no EasyPanel (uma vez só)

1. **Token de leitura do GitHub** (só baixa imagens; não dá acesso ao código):
   github.com → sua foto → **Settings** → **Developer settings** →
   **Personal access tokens** → **Tokens (classic)** → **Generate new token**.
   - Note: `EasyPanel - imagens do CRM`
   - Expiration: **No expiration** (ou 1 ano — anote para renovar)
   - Marque **só** `read:packages`
   - **Generate token** e copie (só aparece uma vez). Cole direto no
     EasyPanel; não mande por chat.
   - Se já criou um token igual para o ERP, pode usar o mesmo.
2. Confira que as imagens já existem: github.com → seu perfil → **Packages**
   → `sheikcell-crm-api`, `-web`, `-whatsapp` (aparecem depois do primeiro
   push em `producao` com este workflow).
3. Serviço **api** → **Fonte** (Source) → **Docker Image**:
   - Image: `ghcr.io/masrinfor-dot/sheikcell-crm-api:producao`
   - Username: `masrinfor-dot`
   - Password: o token do passo 1
   - **Salvar** e depois **Implantar**.
4. Serviço **web**: igual, com `ghcr.io/masrinfor-dot/sheikcell-crm-web:producao`.
5. Serviço **whatsapp**: igual, com `ghcr.io/masrinfor-dot/sheikcell-crm-whatsapp:producao`.
   Reconectar o WhatsApp não é necessário: a sessão fica no banco, não na imagem.
6. Conferir:
   - `https://crm.sheikcell.com.br/api/health` (ou abrir o CRM e entrar);
   - no serviço `api`, aba Logs, a linha de migrations no boot sem erro.

Variáveis de ambiente, domínios, volumes (`/app/storage` com `MEDIA_DIR`,
`DOCS_DIR`, `CATALOG_MEDIA_DIR`) e o gatilho de deploy de cada serviço
continuam os mesmos — o GitHub Actions segue chamando o gatilho depois dos
testes, como hoje.

## Segredos no GitHub

Settings → Secrets and variables → Actions → New repository secret, com a URL
do "Gatilho de Implantação" (aba Implantações de cada serviço no EasyPanel):
`EASYPANEL_DEPLOY_HOOK_API`, `EASYPANEL_DEPLOY_HOOK_WEB`,
`EASYPANEL_DEPLOY_HOOK_WHATSAPP`. Sem o segredo, o deploy daquele serviço
só avisa no log do workflow.

## Voltar uma versão

Serviço → Fonte → troque `:producao` pela tag do commit anterior (as versões
ficam em github.com → seu perfil → **Packages**) → **Salvar** → **Implantar**.
Para voltar ao jeito antigo (compilar no servidor), troque a Fonte para
**GitHub** de novo e desative o workflow `Imagens Docker` na aba Actions.

## Limpeza

O workflow `Limpar imagens antigas` roda toda segunda e mantém as 60 versões
mais recentes de cada imagem.
