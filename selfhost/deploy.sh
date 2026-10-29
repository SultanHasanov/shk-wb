#!/usr/bin/env bash
# Ручная выкладка с локального компьютера (Git Bash). Обычно не нужна:
# каждый push в main выкладывает сайт через .github/workflows/deploy.yml.
#   SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@IP_СЕРВЕРА
set -euo pipefail

host="${1:?Укажите сервер: bash selfhost/deploy.sh root@IP}"
cd "$(dirname "$0")/.."

# Защита: ручная выкладка собирает ТЕКУЩЕЕ рабочее дерево как есть. Чтобы случайно
# не выложить на прод неслитую ветку (напр. site-redesign) или грязное дерево —
# отказываемся, если ветка не main. Осознанный обход: ALLOW_NON_MAIN=1.
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$branch" != "main" ] && [ "${ALLOW_NON_MAIN:-}" != "1" ]; then
  echo "Отказ: ветка '$branch', а не main. Деплой только из main (обход: ALLOW_NON_MAIN=1)." >&2
  exit 1
fi
if [ -n "$(git status --porcelain 2>/dev/null)" ] && [ "${ALLOW_NON_MAIN:-}" != "1" ]; then
  echo "Отказ: в рабочем дереве есть незакоммиченные изменения (обход: ALLOW_NON_MAIN=1)." >&2
  exit 1
fi

# Браузер ходит в Supabase через прокси nginx на нашем домене (см. nginx.conf).
# Переменная окружения перекрывает значение из .env.local.
VITE_SUPABASE_URL=https://shk-wb.ru/supabase npm run build

release="$(date +%Y%m%d-%H%M%S)"
archive="$(mktemp -d)/shk-wb-$release.tar.gz"
tar -czf "$archive" dist api server selfhost vercel.json package.json package-lock.json

scp ${SSH_OPTS:-} "$archive" "$host:/tmp/shk-wb.tar.gz"
ssh ${SSH_OPTS:-} "$host" bash -s -- "$release" < selfhost/release.sh
