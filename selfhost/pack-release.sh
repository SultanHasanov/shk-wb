#!/usr/bin/env bash
# Собирает архив релиза для release.sh. Общий для deploy.sh и GitHub Actions.
#   SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/pack-release.sh root@IP out.tar.gz
#
# ПРАВИЛО: установщики программ (api/_private/*.exe, ~44 МБ из ~51 МБ архива) отправляются,
# только если они изменились. Сравниваем sha256 с теми, что лежат в живом релизе; совпали —
# в архив не кладём, и release.sh копирует их из текущего релиза. Канал до VPS медленный
# (~100 КБ/с), так выкладка идёт около минуты вместо 6–7. Новый установщик уедет сам:
# его сумма не совпадёт с серверной.
set -euo pipefail

host="${1:?Укажите сервер: bash selfhost/pack-release.sh root@IP out.tar.gz}"
out="${2:?Укажите файл архива}"
cd "$(dirname "$0")/.."

# Сервер недоступен или релиза ещё нет — отправляем всё, как раньше.
remote="$(ssh ${SSH_OPTS:-} "$host" 'cd /srv/shk-wb/current/api/_private 2>/dev/null && sha256sum -- *.exe' 2>/dev/null || true)"

excludes=()
for file in api/_private/*.exe; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  sum="$(sha256sum "$file" | cut -d' ' -f1)"
  if printf '%s\n' "$remote" | grep -qxF "$sum  $name"; then
    excludes+=("--exclude=$file")
    echo "Установщик $name не изменился — не отправляем"
  else
    echo "Установщик $name изменился — отправляем"
  fi
done

tar ${excludes[@]+"${excludes[@]}"} -czf "$out" dist api server selfhost vercel.json package.json package-lock.json
echo "Архив: $(du -h "$out" | cut -f1)"
