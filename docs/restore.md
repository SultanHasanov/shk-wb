# Восстановление после аварии

Что делать, если умер VPS сайта, узел бота, Supabase или ПК с бэкапами. Бэкапы делает
`C:\Users\HONOR\shk-backup\backup.ps1` (вне репозитория) — описание ниже, в разделе «Бэкапы».

**Проверено ли.** Бэкап создаётся и проверяется автоматически: архив открывается, в дампе базы есть
`auth.users` и `app_devices`, git-бандл проходит `git bundle verify`. **Само восстановление ни разу
не прогонялось.** Шаги для VPS собраны из `selfhost/setup.sh` и того, как сервер настроен сейчас; шаги
для Supabase — по документации Postgres и не опробованы. Если есть время — сначала тренировка на
тестовом VPS или тестовом проекте Supabase, а не сразу в бою.

## Бэкапы: где и что

| | Полная копия | База |
|---|---|---|
| Когда | воскресенье 13:00 (задача «SHK-WB weekly backup») | каждый день 12:00 («SHK-WB daily database backup») |
| Где | `C:\Users\HONOR\shk-backup\archives\shk-backup-*.7z` | `…\archives\daily\db-*.7z` |
| Хранится | 8 последних | 14 последних |
| Итог | `LAST-RESULT.txt` | `LAST-DB-RESULT.txt` |

Если ПК был выключен в нужное время — задача запустится при включении. Журнал — `backup.log`.
Пропуски теряемых данных: Supabase — до суток, архив пунктов (свой Postgres на VPS) — до суток
(дамп делается на сервере в 00:30), всё остальное — до недели.

Архивы — 7-Zip, AES-256, имена файлов тоже зашифрованы. **Пароль архива записан у владельца на бумаге**;
скрипту он доступен через DPAPI (`archive-pass.xml`), т. е. только с этой учётной записи на этом ПК.
Открыть: `"C:\Program Files\7-Zip\7z.exe" x shk-backup-….7z -oC:\restore` (спросит пароль).

Внутри полной копии:

| Файл | Что это |
|---|---|
| `supabase.dump` | база Supabase, схемы `public` и `auth` (формат `pg_dump -Fc`) |
| `pvz_archive-YYYYMMDD.dump` | архив и зеркало пунктов из своего Postgres на VPS |
| `secrets\vps.env`, `secrets\bot-node.env` | `/srv/shk-wb/.env` сайта и узла бота |
| `secrets\shk-wb_ed25519(.pub)` | SSH-ключ к обоим серверам |
| `secrets\repo.env.local` | `.env.local` репозитория (нужен `deploy.sh` для локальной сборки) |
| `servers\shk-serverconf.tgz` | с VPS: `/etc/nginx/sites-available` (все сайты, в т. ч. `pvzprint`, которого нет в репозитории), `/etc/cron.d`, `/etc/postgresql/16/main/conf.d`, юнит `shk-wb.service`, `/etc/letsencrypt` |
| `servers\shk-botconf.tgz` | с узла бота: `/etc/caddy` (релей и VPN), юниты `shk-wb`, `tg-watchdog`, `caddy.service.d` |
| `servers\shk-appupdates.tgz` | текущие установщики: `latest.json` обеих программ, файл и `.sig` из них, `/dl/` текущих версий |
| `repo.bundle` | весь git со всеми ветками, включая неотправленные коммиты |
| `_local-only\pvz-tauri`, `_local-only\cell-print-tauri` | исходники программ; `pvz-tauri\keys\updater.key` — ключ подписи обновлений (общий для обеих программ), `lease-private.pem` — ключ аренды |

**Чего в бэкапе нет:** настройки Supabase в панели (Auth: Site URL, redirect URLs, провайдеры, SMTP и шаблоны
писем; секреты Edge Function `tg-relay`), DNS у регистратора, кабинеты ЮKassa/Resend/Яндекс ID/VK ID,
данные сайтов `wbdav.ru` и `wb-vpn.ru` (есть только их nginx-конфиги), старые версии установщиков,
остальное содержимое `_local-only` (52 ГБ, в основном сборки).

## Код из бэкапа

```bash
git clone repo.bundle shk-wb && cd shk-wb && git checkout main
cp /путь/к/secrets/repo.env.local .env.local
```
GitHub тоже подходит, если коммиты отправлены (`git rev-list --count origin/main..main` = 0).

---

## А. Умер VPS сайта (212.193.59.72)

Supabase и узел бота это не задевает: аккаунты, оплаты и бот на месте, пока нет сайта и API программ.

1. **Новый VPS** — Ubuntu 22.04/24.04, лучше от 2 ГБ RAM и 20 ГБ диска. Положить SSH-ключ из
   `secrets\shk-wb_ed25519.pub` в `/root/.ssh/authorized_keys`. Дальше `NEW=root@<новый IP>`,
   `K="-i ~/.ssh/shk-wb_ed25519"`.
2. **Базовая настройка** (nginx, Node 22, пользователь `shkwb`, systemd, cron уведомлений, ufw):
   ```bash
   scp $K -r selfhost $NEW:/root/ && ssh $K $NEW 'bash /root/selfhost/setup.sh'
   ```
3. **.env:**
   ```bash
   scp $K secrets/vps.env $NEW:/srv/shk-wb/.env
   ssh $K $NEW 'chown shkwb:shkwb /srv/shk-wb/.env && chmod 600 /srv/shk-wb/.env'
   ```
   Если меняется IP — в `.env` его нет, но он есть в Caddy узла бота (шаг 9).
4. **Конфигурация и сертификаты из бэкапа** (до nginx-sync, иначе `nginx -t` не найдёт сертификаты):
   ```bash
   scp $K servers/shk-serverconf.tgz $NEW:/root/
   ssh $K $NEW 'mkdir -p /root/old && tar -xzf /root/shk-serverconf.tgz -C /root/old \
     && cp -a /root/old/etc/letsencrypt /etc/ \
     && cp /root/old/etc/cron.d/pvz-archive-backup /etc/cron.d/'
   ```
   Конфиги остальных сайтов (`pvzprint`, `wbdav.ru`, `wb-vpn.ru`) — в `/root/old/etc/nginx/sites-available/`,
   переносить по необходимости (`ln -s` в `sites-enabled`, `nginx -t`, `systemctl reload nginx`).
5. **Свой Postgres с архивом пунктов:**
   ```bash
   ssh $K $NEW 'apt-get install -y postgresql-16 \
     && cp /root/old/etc/postgresql/16/main/conf.d/shk-wb.conf /etc/postgresql/16/main/conf.d/ \
     && systemctl restart postgresql \
     && sudo -u postgres createuser shkwb && sudo -u postgres createdb -O shkwb pvz_archive \
     && mkdir -p /srv/shk-wb/backups && chown shkwb:shkwb /srv/shk-wb/backups'
   scp $K pvz_archive-*.dump $NEW:/tmp/archive.dump
   ssh $K $NEW 'sudo -u shkwb pg_restore -d pvz_archive --no-owner /tmp/archive.dump && rm /tmp/archive.dump'
   ```
   Без `ARCHIVE_DATABASE_URL` в `.env` сервер писал бы архив в Supabase и переполнил бы его (так было 24.10) —
   строка в `vps.env` уже есть, проверить. Схема на всякий случай: `selfhost/archive-schema.sql` (идемпотентна).
6. **Установщики программ** (без них не работают автообновление и `/dl/`):
   ```bash
   scp $K servers/shk-appupdates.tgz $NEW:/root/
   ssh $K $NEW 'mkdir -p /srv/shk-wb/app-updates && tar -xzf /root/shk-appupdates.tgz -C /srv/shk-wb/app-updates \
     && chown -R shkwb:shkwb /srv/shk-wb/app-updates'
   ```
7. **DNS:** A-записи `shk-wb.ru` и `www.shk-wb.ru` (и `pvzprint.ru`, если он здесь) → новый IP.
8. **Сайт и nginx** (из чистого `main`, с `.env.local` в корне репозитория):
   ```bash
   SSH_OPTS="$K" bash selfhost/deploy.sh $NEW > deploy.log 2>&1; echo $?
   SSH_OPTS="$K" bash selfhost/nginx-sync.sh $NEW
   ssh $K $NEW 'certbot renew --dry-run'
   ```
   Если сертификаты не восстановились — `certbot --nginx -d shk-wb.ru -d www.shk-wb.ru`.
9. **Узел бота должен узнать новый IP.** В `selfhost/caddy/Caddyfile.tg-relay` строка `@site remote_ip 212.193.59.72`
   пускает к Supabase (`/sb/*`) и внутреннему RPC только старый VPS — без правки сайт **не достучится до Supabase**.
   Поправить IP в репозитории и в `/etc/caddy/Caddyfile.tg-relay` на узле, затем
   `caddy validate --config /etc/caddy/Caddyfile` (с переменными из `systemctl show caddy -p Environment`) и
   `systemctl restart caddy` (VPN-релей на узле прервётся на секунду). Старый IP также упомянут в `CLAUDE.md`,
   `docs/site.md`, `docs/pvz-helper.md`, `selfhost/nginx-sync.sh` — заменить.
10. **Проверка:**
    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" https://shk-wb.ru/                         # 200
    curl -s "https://shk-wb.ru/api/app/update?current=1.0.0&target=windows&arch=x86_64" | head -c 200   # JSON с подписью
    curl -s -o /dev/null -w "%{http_code}\n" https://shk-wb.ru/api/app/plans             # 200
    ssh $K $NEW 'systemctl is-active shk-wb; journalctl -u shk-wb --since "5 min ago" | grep -ci error'
    ```
    Затем вход в кабинет на сайте и вход в «Помощник ПВЗ» на любом ПК.

## Б. Пропал Supabase (проект удалён, заблокирован, данные испорчены)

**Не проверялось.** Порядок важен: таблицы `public` ссылаются на `auth.users`, поэтому сначала данные `auth`.

1. **Если проект жив, а испорчены данные** — восстанавливать в тот же проект нельзя вслепую: сначала снять свежий дамп
   (`backup.ps1 -DatabaseOnly`), потом решать, какие таблицы возвращать. Точечно: `pg_restore -t <таблица> --data-only`.
2. **Новый проект** — регион `eu-central-1`, Postgres 17. Пароль базы — в Settings → Database.
   Строка подключения — кнопка **Connect → Session pooler**.
3. **Восстановление** (клиент лежит в `C:\Users\HONOR\shk-backup\pgsql\bin`):
   ```powershell
   $env:PGPASSWORD = "<пароль нового проекта>"
   $db = "postgresql://postgres.<новый ref>@<хост pooler>:5432/postgres"
   & C:\Users\HONOR\shk-backup\pgsql\bin\pg_restore.exe -d $db --data-only -n auth --no-owner supabase.dump
   & C:\Users\HONOR\shk-backup\pgsql\bin\pg_restore.exe -d $db -n public --no-owner --no-privileges supabase.dump
   Remove-Item Env:PGPASSWORD
   ```
   Ошибки про уже существующие объекты в `auth` (схема в новом проекте есть заранее) — ожидаемы; ошибки про
   данные — нет. После — сверить число строк: `select count(*) from auth.users; select count(*) from app_devices;`
   с тем, что было (в дампе: `pg_restore --list supabase.dump`).
4. **Новые ключи** — везде, где старый `ouxsvlfaszsaykzpnkwh`:
   - `/srv/shk-wb/.env` на VPS и на узле бота: `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, адрес проекта;
   - `selfhost/caddy/Caddyfile.tg-relay` (блок `/sb/*`, upstream и `Host`) — на узле бота, затем restart caddy;
   - `.env.local` и секреты GitHub Actions (`VITE_SUPABASE_PUBLISHABLE_KEY`), затем выложить сайт заново;
   - `supabase link --project-ref <новый ref>` для миграций.
5. **Настройки Auth вручную** (их нет в бэкапе): Site URL `https://shk-wb.ru`, Redirect URLs (`/auth/oauth`,
   `/reset-password` и прочие из старого проекта — смотреть `src/` и `server/_oauth-login.js`), SMTP и шаблоны писем.
6. **Edge Function** `tg-relay` (запасной релей): `npx supabase functions deploy tg-relay --no-verify-jwt`
   и секрет `ALLOWED_BOT_IDS` (id ботов через запятую).
7. **Последствие для пользователей:** токены, выданные старым проектом, недействительны — всем придётся войти заново
   на сайте и в программах. Ключи устройств (`app_devices.key_hash`) восстанавливаются из дампа, поэтому фоновые
   функции ПК (сообщения, загрузка с другого ПК) могут заработать и без входа, но на это не рассчитывать.

## В. Умер узел бота в Германии (109.120.140.116, tg.shk-wb.ru)

Без него сайт теряет Supabase (идёт через `/sb/*` релея) и Telegram. Быстрый обход, пока узла нет:
на VPS `SUPABASE_URL=https://ouxsvlfaszsaykzpnkwh.supabase.co` в `.env` и `systemctl restart shk-wb` —
сайт заработает, но из РФ часть запросов будет зависать (см. `docs/site.md`, раздел про релей).

1. Новый сервер **вне РФ** (иначе не достанет до Telegram и Cloudflare). Ключ — как в разделе А.
2. Caddy: `apt-get install -y caddy`, затем из `servers\shk-botconf.tgz` вернуть `/etc/caddy/*` и
   `/etc/systemd/system/caddy.service.d/`, `systemctl daemon-reload && systemctl restart caddy`.
   **В `/etc/caddy/Caddyfile` живёт и чужой VPN-релей** — переносить его или нет, решать отдельно.
3. Узел: `/srv/shk-wb/.env` из `secrets\bot-node.env` (владелец `shkwb`, права 600), юниты `shk-wb.service` и
   `tg-watchdog.*` из архива (`systemctl enable --now …`), затем с ПК:
   `ROLE=bot SSH_OPTS="$K" bash selfhost/deploy.sh root@<новый IP>`.
4. DNS: `tg.shk-wb.ru` → новый IP. Вебхук бота указывает на `tg.shk-wb.ru:88/webhook` и после DNS заработает сам;
   проверить — `bash selfhost/tg-set-webhook.sh` на VPS (печатает `getWebhookInfo`).
5. Подробности узла и отката — `docs/telegram-bot.md`.

## Г. Умер ПК с бэкапами

Копии лежат на единственном диске C: этого ПК — без внешней копии они пропадут вместе с ним. Поэтому
**раз в месяц** копировать `C:\Users\HONOR\shk-backup\archives` на флешку или в облако (архивы зашифрованы,
облаку их содержимое не видно).

Новый ПК: код — из GitHub или `repo.bundle`, ключи и `.env` — из архива (нужен пароль архива с бумаги),
бэкап заново — скопировать `backup.ps1` в `C:\Users\<пользователь>\shk-backup\`, поправить пути в начале
скрипта (`$Repo`, `$SshKey`, `$Root`) и запустить с `-Setup`.

## Бэкапы: обслуживание

```powershell
# полная копия вручную / только база
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\HONOR\shk-backup\backup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\HONOR\shk-backup\backup.ps1 -DatabaseOnly
# сменился пароль базы Supabase
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\HONOR\shk-backup\backup.ps1 -SetDbPassword
# расписание
Get-ScheduledTask -TaskName 'SHK-WB*' | Get-ScheduledTaskInfo
```

Если сменился IP сервера, адрес проекта Supabase или папка репозитория — поправить переменные в начале
`backup.ps1` (`$Vps`, `$BotNode`, `$DbUrl`, `$Repo`). Файл сохранять в UTF-8 **с BOM**, иначе Windows PowerShell 5.1
ломает кириллицу в путях.
