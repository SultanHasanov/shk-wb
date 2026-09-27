#!/usr/bin/env bash
# Первичная настройка чистого Ubuntu 22.04/24.04. Запускать один раз от root:
#   bash setup.sh
set -euo pipefail

# 1 ГБ RAM мало для генерации PDF — добавляем подкачку.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
fi

apt-get update
apt-get install -y ca-certificates curl nginx certbot python3-certbot-nginx ufw
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Диск всего 5 ГБ: ограничиваем журналы и чистим кэш пакетов.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald
apt-get clean

id shkwb >/dev/null 2>&1 || useradd --system --home /srv/shk-wb --shell /usr/sbin/nologin shkwb
mkdir -p /srv/shk-wb/releases
if [ ! -f /srv/shk-wb/.env ]; then
  cp "$(dirname "$0")/env.example" /srv/shk-wb/.env
fi
chown -R shkwb:shkwb /srv/shk-wb
chmod 600 /srv/shk-wb/.env

cp "$(dirname "$0")/shk-wb.service" /etc/systemd/system/shk-wb.service
systemctl daemon-reload
systemctl enable shk-wb

cp "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/shk-wb
ln -sf /etc/nginx/sites-available/shk-wb /etc/nginx/sites-enabled/shk-wb
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Замена crons из vercel.json: ежедневно в 06:00 UTC.
cat > /etc/cron.d/shk-wb <<'CRON'
CRON_TZ=UTC
0 6 * * * shkwb . /srv/shk-wb/.env && curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/notifications >/dev/null
CRON
chmod 644 /etc/cron.d/shk-wb

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo
echo 'Готово. Дальше: заполнить /srv/shk-wb/.env и выложить сайт через deploy.sh.'
