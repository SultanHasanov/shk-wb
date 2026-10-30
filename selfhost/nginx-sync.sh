#!/usr/bin/env bash
# Выкладка боевого конфига nginx: selfhost/nginx-live.conf → сервер.
#   bash selfhost/nginx-sync.sh root@212.193.59.72
#   SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/nginx-sync.sh root@212.193.59.72
#
# С --check только показывает расхождение и ничего не меняет.
#
# Зачем отдельный скрипт: deploy.sh выкладывает приложение и nginx не трогает,
# а setup.sh ставит nginx.conf только на чистой машине, до сертификатов. Без
# этого шага живой конфиг правился руками и расходился с репозиторием.
set -euo pipefail

target="${1:-}"
mode="${2:-}"
if [ -z "$target" ]; then
  echo "Использование: bash selfhost/nginx-sync.sh root@<host> [--check]" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")" && pwd)"
local_conf="$here/nginx-live.conf"
remote_conf=/etc/nginx/sites-available/shk-wb
# shellcheck disable=SC2086
ssh_cmd() { ssh ${SSH_OPTS:-} "$target" "$@"; }

live="$(ssh_cmd "cat $remote_conf")"
if [ "$live" = "$(cat "$local_conf")" ]; then
  echo "Конфиг на сервере совпадает с nginx-live.conf."
  exit 0
fi

echo "Расхождение с сервером (слева репозиторий, справа сервер):"
diff <(cat "$local_conf") <(printf '%s\n' "$live") || true

if [ "$mode" = "--check" ]; then
  echo "Режим проверки: ничего не менял." >&2
  exit 1
fi

# Бэкап обязателен: сюда же смотрит откат, если nginx -t не пройдёт.
backup="/root/shk-wb.nginx.bak-$(date +%s)"
ssh_cmd "cp $remote_conf $backup && echo 'бэкап: $backup'"
# shellcheck disable=SC2086
ssh ${SSH_OPTS:-} "$target" "cat > $remote_conf" < "$local_conf"
ssh_cmd "ln -sf $remote_conf /etc/nginx/sites-enabled/shk-wb"

if ! ssh_cmd 'nginx -t'; then
  echo "nginx -t не прошёл — возвращаю бэкап." >&2
  ssh_cmd "cp $backup $remote_conf && nginx -t && systemctl reload nginx"
  exit 1
fi

ssh_cmd 'systemctl reload nginx && echo "nginx перезагружен"'
