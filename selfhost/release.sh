#!/usr/bin/env bash
# Выполняется на сервере: разворачивает /tmp/shk-wb.tar.gz как новый релиз.
# Запускается из deploy.sh и из GitHub Actions: ssh host bash -s -- RELEASE < release.sh
set -euo pipefail

release="${1:?release name required}"
dir="/srv/shk-wb/releases/$release"
previous="$(readlink -f /srv/shk-wb/current 2>/dev/null || true)"

mkdir -p "$dir"
tar -xzf /tmp/shk-wb.tar.gz -C "$dir"
rm /tmp/shk-wb.tar.gz
# Неизменившиеся установщики pack-release.sh в архив не кладёт — берём их из текущего релиза.
if [ -n "$previous" ] && [ -d "$previous/api/_private" ]; then
  mkdir -p "$dir/api/_private"
  for file in "$previous"/api/_private/*.exe; do
    [ -f "$file" ] || continue
    [ -f "$dir/api/_private/$(basename "$file")" ] || cp -p "$file" "$dir/api/_private/"
  done
fi
for name in program-installer.exe cell-print-installer.exe; do
  [ -f "$dir/api/_private/$name" ] || echo "ВНИМАНИЕ: в релизе нет api/_private/$name — кнопка «Скачать» не сработает" >&2
done
cd "$dir"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
npm cache clean --force >/dev/null 2>&1
chown -R shkwb:shkwb "$dir"

ln -sfn "$dir" /srv/shk-wb/current
systemctl restart shk-wb

healthy=false
for _ in $(seq 1 15); do
  sleep 1
  if curl -fsS -o /dev/null -H 'Host: shk-wb.ru' http://127.0.0.1:3000/; then healthy=true; break; fi
done

if [ "$healthy" != true ]; then
  journalctl -u shk-wb -n 30 --no-pager || true
  if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$dir" ]; then
    echo "Релиз $release не поднялся — откат на $(basename "$previous")"
    ln -sfn "$previous" /srv/shk-wb/current
    systemctl restart shk-wb
    rm -rf "$dir"
  fi
  exit 1
fi

# Диск маленький: храним текущий релиз и один предыдущий для отката.
ls -1dt /srv/shk-wb/releases/* | tail -n +3 | xargs -r rm -rf
echo "Выложен релиз $release"
