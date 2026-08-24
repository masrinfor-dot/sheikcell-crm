# Instalação no EasyPanel (VPS Hostinger)

O sistema tem 4 serviços dentro de um mesmo projeto do EasyPanel:

| Serviço    | Tipo     | Build                              | Porta | Domínio/Path |
|------------|----------|------------------------------------|-------|--------------|
| `db`       | Postgres | (template do EasyPanel)            | 5432  | — (interno)  |
| `api`      | App      | `deploy/easypanel/Dockerfile.api`      | 8080  | seu domínio, path `/api` |
| `whatsapp` | App      | `deploy/easypanel/Dockerfile.whatsapp` | 3002  | — (interno)  |
| `web`      | App      | `deploy/easypanel/Dockerfile.web`      | 80    | seu domínio, path `/` |

## Variáveis de ambiente

### Serviço `api`
- `DATABASE_URL` — copie do serviço Postgres (formato `postgres://usuario:senha@sheikcell_db:5432/banco`)
- `SESSION_SECRET` — valor forte (ex.: `openssl rand -hex 32`)
- `OPENAI_API_KEY` — sua chave da OpenAI (recursos de IA)
- `WHATSAPP_BRIDGE_URL` — `http://sheikcell_whatsapp:3002`
- `LOG_LEVEL` — `info` (opcional)

### Serviço `whatsapp`
- `DATABASE_URL` — o MESMO do serviço api
- `SESSION_SECRET` — o MESMO do serviço api (assina a comunicação interna)

> O nome interno dos serviços segue o padrão `<projeto>_<serviço>`
> (ex.: projeto `sheikcell`, serviço `whatsapp` → host `sheikcell_whatsapp`).

## Persistência de arquivos (mídias do WhatsApp e documentos)

O código grava mídias e documentos enviados em disco (não no Postgres). Sem
volume persistente configurado, cada rebuild da imagem (`COPY . .` no
`Dockerfile.api`) apaga tudo que foi enviado — os links antigos param de abrir
("arquivo não encontrado no servidor").

No serviço **`api`**:
1. Em **Volumes**, adicione um volume montado em `/app/storage` (caminho
   dentro do container — pode escolher qualquer nome/tamanho no EasyPanel,
   só o path de montagem importa).
2. Em **Variáveis de ambiente**, defina:
   - `MEDIA_DIR=/app/storage/media`
   - `DOCS_DIR=/app/storage/documents`

Sem essas duas variáveis o código cai no padrão antigo (caminho relativo ao
diretório de trabalho do processo, que é `/app` no container) — funciona
enquanto o container não for recriado, mas não sobrevive a um redeploy a
menos que o volume esteja montado EXATAMENTE em `/app/media` e
`/app/documents`. Definir `MEDIA_DIR`/`DOCS_DIR` explicitamente remove essa
ambiguidade.

## Ordem de criação
1. Criar projeto `sheikcell`
2. Criar serviço Postgres (`db`)
3. Criar app `whatsapp` (GitHub + Dockerfile.whatsapp) — sem domínio
4. Criar app `api` (GitHub + Dockerfile.api) — domínio com path `/api`, porta 8080
5. Criar app `web` (GitHub + Dockerfile.web) — domínio com path `/`, porta 80

Cada push na branch `main` pode reconstruir automaticamente
(ative "Auto Deploy" nos três apps).
