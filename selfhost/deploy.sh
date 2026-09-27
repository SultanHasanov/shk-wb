#!/usr/bin/env bash
# Выкладка с локального компьютера (Git Bash): собирает сайт и отправляет на VPS.
#   bash selfhost/deploy.sh root@IP_СЕРВЕРА
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
ssh ${SSH_OPTS:-} "$host" bash -s -- "$release" <<'REMOTE'
set -euo pipefail
release="$1"
dir="/srv/shk-wb/releases/$release"
mkdir -p "$dir"
tar -xzf /tmp/shk-wb.tar.gz -C "$dir"
rm /tmp/shk-wb.tar.gz
cd "$dir"
npm ci --omit=dev --no-audit --no-fund
npm cache clean --force >/dev/null 2>&1
chown -R shkwb:shkwb "$dir"
ln -sfn "$dir" /srv/shk-wb/current
systemctl restart shk-wb
sleep 2
systemctl is-active --quiet shk-wb || { journalctl -u shk-wb -n 30 --no-pager; exit 1; }
# Диск маленький: храним текущий релиз и один предыдущий для отката.
ls -1dt /srv/shk-wb/releases/* | tail -n +3 | xargs -r rm -rf
echo "Выложен релиз $release"
REMOTE
