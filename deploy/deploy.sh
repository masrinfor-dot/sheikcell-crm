#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy / atualização do Sheikcell na VPS.
# Rodado manualmente (primeira vez) ou automaticamente pelo GitHub Actions a
# cada push na branch main. Idempotente: pode rodar quantas vezes quiser.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/var/www/sheikcell"
cd "$APP_DIR"

echo "==> Atualizando código (git pull)"
git fetch origin
git reset --hard origin/main

echo "==> Carregando variáveis de ambiente (.env)"
if [ ! -f .env ]; then
  echo "ERRO: arquivo .env não encontrado em $APP_DIR (copie de deploy/.env.example)"
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

echo "==> Instalando dependências (pnpm install)"
pnpm install --frozen-lockfile

echo "==> Aplicando mudanças no banco (drizzle push)"
pnpm --filter @workspace/db run push

echo "==> Compilando serviços"
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/whatsapp-bridge run build
BASE_PATH="/" pnpm --filter @workspace/sheikcell run build

echo "==> (Re)iniciando processos no PM2"
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save

echo "==> Deploy concluído com sucesso."
