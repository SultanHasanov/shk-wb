#!/usr/bin/env bash
# Сторож бота @shkwb_bot на немецком сервере (tg.shk-wb.ru). Раз в минуту (systemd-таймер tg-watchdog.timer)
# дёргает вебхук сервера shk-wb.ru: GET /api/telegram/webhook должен ответить 200 быстрее 10 с.
# Два провала подряд — сообщение админу напрямую в api.telegram.org (отсюда он доступен), повтор раз в 30 минут,
# после двух удачных проверок — «снова отвечает». Нужен для случая, когда сам процесс на VPS лёг:
# встроенный монитор (server/_bot-health.js) тогда ничего не пришлёт.
# Настройки — /etc/tg-watchdog.env (chmod 600): TG_BOT_TOKEN, TG_ADMIN_IDS (через запятую), TARGET_URL.
set -u
ENV_FILE=${ENV_FILE:-/etc/tg-watchdog.env}
STATE_DIR=${STATE_DIR:-/var/lib/tg-watchdog}
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${TG_BOT_TOKEN:?}" "${TG_ADMIN_IDS:?}"
# С узлом бота на этом же сервере цель — его вебхук через Caddy (tg.shk-wb.ru:88/webhook → 127.0.0.1:3001),
# пока бот обрабатывался на VPS — https://shk-wb.ru/api/telegram/webhook.
TARGET_URL=${TARGET_URL:-https://tg.shk-wb.ru:88/webhook}
TIMEOUT_S=${TIMEOUT_S:-10}
REPEAT_S=$((30 * 60))
mkdir -p "$STATE_DIR"
FAILS_FILE=$STATE_DIR/fails; OKS_FILE=$STATE_DIR/oks; DOWN_FILE=$STATE_DIR/down; SENT_FILE=$STATE_DIR/sent_at
fails=$(cat "$FAILS_FILE" 2>/dev/null || echo 0); oks=$(cat "$OKS_FILE" 2>/dev/null || echo 0)
now=$(date +%s)

send() {
  local text=$1 id
  IFS=',' read -ra ids <<< "$TG_ADMIN_IDS"
  for id in "${ids[@]}"; do
    curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "$(printf '{"chat_id":"%s","text":%s,"parse_mode":"HTML","disable_web_page_preview":true}' "$id" "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
  done
}

code=$(curl -s -m "$TIMEOUT_S" -o /dev/null -w '%{http_code}' "$TARGET_URL" || echo 000)
elapsed=$(( $(date +%s) - now ))
if [ "$code" = "200" ]; then
  fails=0; oks=$((oks + 1))
else
  fails=$((fails + 1)); oks=0
fi
echo "$fails" > "$FAILS_FILE"; echo "$oks" > "$OKS_FILE"
logger -t tg-watchdog "code=$code elapsed=${elapsed}s fails=$fails oks=$oks"

if [ "$fails" -ge 2 ]; then
  sent_at=$(cat "$SENT_FILE" 2>/dev/null || echo 0)
  if [ ! -f "$DOWN_FILE" ] || [ $((now - sent_at)) -ge "$REPEAT_S" ]; then
    send "🔴 <b>Сервер бота не отвечает</b>
$TARGET_URL → HTTP $code (${elapsed} с), $fails проверки подряд.
Бот @shkwb_bot сейчас не работает: узел в Германии — ssh root@109.120.140.116, systemctl status shk-wb caddy; если бот обрабатывается на VPS — root@212.193.59.72, systemctl status shk-wb nginx."
    touch "$DOWN_FILE"; echo "$now" > "$SENT_FILE"
  fi
elif [ -f "$DOWN_FILE" ] && [ "$oks" -ge 2 ]; then
  send "✅ Сервер бота снова отвечает: $TARGET_URL → HTTP 200."
  rm -f "$DOWN_FILE"
fi
