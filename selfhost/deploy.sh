#!/usr/bin/env bash
# Ручная выкладка с локального компьютера (Git Bash). Обычно не нужна:
# каждый push в main выкладывает сайт через .github/workflows/deploy.yml.
#   SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@IP_СЕРВЕРА
set -euo pipefail

host="${1:?Укажите сервер: bash selfhost/deploy.sh root@IP}"
cd "$(dirname "$0")/.."

# Браузер ходит в Supabase через прокси nginx на нашем домене (см. nginx.conf).
# Переменная окружения перекрывает значение из .env.local.
VITE_SUPABASE_URL=https://shk-wb.ru/supabase npm run build

release="$(date +%Y%m%d-%H%M%S)"
archive="$(mktemp -d)/shk-wb-$release.tar.gz"
tar -czf "$archive" dist api server selfhost vercel.json package.json package-lock.json

scp ${SSH_OPTS:-} "$archive" "$host:/tmp/shk-wb.tar.gz"
ssh ${SSH_OPTS:-} "$host" bash -s -- "$release" < selfhost/release.sh
