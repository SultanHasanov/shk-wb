#!/usr/bin/env bash
# Ставит вебхук боевого бота на Supabase-релей. Запускать НА СЕРВЕРЕ (читает /srv/shk-wb/.env):
#   bash tg-set-webhook.sh            — переключить на <TELEGRAM_API_BASE>/webhook
#   bash tg-set-webhook.sh <url>      — любой другой url (откат на Vercel: https://tg-relay-three.vercel.app/webhook)
set -euo pipefail
ENV_FILE=${ENV_FILE:-/srv/shk-wb/.env}
get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
TOKEN=$(get TELEGRAM_BOT_TOKEN); SECRET=$(get TELEGRAM_WEBHOOK_SECRET); BASE=$(get TELEGRAM_API_BASE)
URL=${1:-$BASE/webhook}
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"url\":\"$URL\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"]}" \
  "$BASE/api/setWebhook"; echo
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/getWebhookInfo"; echo
