# Сайт shk-wb.ru — сервер, хранилище, выкладка

React + `api/` + `server/` + `selfhost/`. Один процесс обслуживает сайт, API всех программ и Telegram-бота.

## Доступ и выкладка
- Сервер: `root@212.193.59.72`, ключ `~/.ssh/shk-wb_ed25519`.
- Выкладка: `SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@212.193.59.72` (~3 мин).
- Push в `main` запускает GitHub Actions; для срочной правки быстрее `deploy.sh`.
- **Установщики программ не отправляются, если не изменились.** `selfhost/pack-release.sh` (общий для
  `deploy.sh` и Actions) сверяет sha256 `api/_private/*.exe` с живым релизом и кладёт в архив только
  изменившиеся, а `release.sh` докопирует остальные из текущего релиза. Архив ~7 МБ вместо ~51, канал до
  VPS ~100 КБ/с. Новый установщик уедет сам — его сумма не совпадёт. Не обходить этот скрипт ручным `tar`.
- Картинки сайта — в `images/` (копируются в `dist`, лучше WebP). Исходники и неиспользуемые PNG — в
  `images-src/`, на сервер они не едут.
- Правка одного серверного файла без полной выкладки: `scp` в `/srv/shk-wb/current/server/`, `chown shkwb`, `systemctl restart shk-wb`.
- Миграции: `npx supabase db query --linked -f <файл>` (история миграций в Supabase не ведётся).
- Переменные окружения — `/srv/shk-wb/.env` (бэкап перед правкой: `cp .env .env.bak-$(date +%s)`).
- **Второй сервер — узел Telegram-бота в Германии** (`root@109.120.140.116`, тот же ключ): та же кодовая база в роли
  `BOT_ROLE=bot`, выкладывается отдельно `ROLE=bot … bash selfhost/deploy.sh root@109.120.140.116`, Actions его не
  трогает. Подробности — `docs/telegram-bot.md`.

### Supabase — через релей в Германии (с 05.11.2026)
Привязка кода/лицензии учитывает несколько связанных заказов (пополнения и продления):
миграция `20261121_claim_user_asset_multiple_orders.sql` убирает присваивание нескольких
строк `UPDATE … RETURNING` одной переменной в `claim_user_asset`. Проверка на временных
таблицах без данных пользователей: `node supabase/tests/run-claim-regression.cjs | psql -X -v ON_ERROR_STOP=1 <база>`;
тест заканчивается `ROLLBACK`.

Статистика стикеров кешируется сервером на 30 с; при сетевом сбое можно вернуть последнее
успешное значение не старше 5 минут. Ошибки SQL кешем не скрываются. Тайм-аут загрузки
кабинета возвращает 503 `DATABASE_UNAVAILABLE`; в интерфейсе есть кнопка повторной загрузки.

С 03.11.2026 ~15:00 с VPS в РФ установленные TCP-соединения к Cloudflare (за ним Supabase) молча глушатся через
10–25 с: пакеты уходят, ответа нет, соседние соединения к тому же IP живут. Любой запрос по такому соединению
висит до таймаута (10 с в `_fetch-retry`), в журнале — `fetch retry (supabase): The operation was aborted due to
timeout` по 100–560 в час, плюс `[UFW BLOCK] … SPT=443` в `journalctl -k` (поздние FIN от Supabase уже после того,
как наша сторона закрыла сокет). Российский хост (ya.ru) на одном соединении не рвётся, из Германии Supabase —
ноль обрывов на 120 запросах. Поэтому:
- сервер: `SUPABASE_URL=https://tg.shk-wb.ru:88/sb` в `/srv/shk-wb/.env` (Caddy на узле бота проксирует `/sb/*`
  в `ouxsvlfaszsaykzpnkwh.supabase.co`, только с IP VPS — `selfhost/caddy/Caddyfile.tg-relay`);
- браузер: nginx `location /supabase/` тоже ведёт на `tg.shk-wb.ru:88/sb/…` (`selfhost/nginx-live.conf`).
После переключения таймаутов в журнале 0. Откат: `SUPABASE_URL=https://ouxsvlfaszsaykzpnkwh.supabase.co`
(бэкап `.env.bak-*`), рестарт; nginx — прошлая версия `nginx-live.conf` через `nginx-sync.sh`.
Узел бота в Германии ходит в Supabase напрямую, его это не касается. Если немецкий узел лёг — сайт теряет
Supabase целиком, это осознанная цена; `_bot-health` следит за узлом.

### nginx: два файла, не путать
`deploy.sh` nginx НЕ трогает, поэтому конфиг выкладывается отдельно.
- `selfhost/nginx.conf` — только для чистой машины: порт 80, без TLS. `setup.sh` копирует его и сразу делает
  `nginx -t`, а сертификатов там ещё нет, так что `listen 443` в этом файле жить не может. Дальше TLS дописывает
  `certbot --nginx`.
- `selfhost/nginx-live.conf` — **боевой конфиг, источник истины** для `/etc/nginx/sites-available/shk-wb`.
  Выкладка: `SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/nginx-sync.sh root@212.193.59.72`
  (делает бэкап в `/root/shk-wb.nginx.bak-*`, `nginx -t` и откат, если проверка не прошла).
  Сверить сервер с репозиторием, ничего не меняя: тот же скрипт с `--check` (код выхода 1 при расхождении).

**Руками на сервере конфиг не править** — разойдётся с репозиторием в обе стороны, и это уже было:
редирект `www` внесли по месту (в гите его не было), а `proxy_buffering off` для Realtime из коммита
3001b176 на сервер, наоборот, не попадал месяц. Выровнено 30.10.2026.

## Хранилище облака Помощника: Supabase + свой Postgres (2026-10-24, ВЫЛОЖЕНО, коммиты 5291d746, 27b5ff36, 4401fcf2)
**Что случилось.** Supabase на бесплатном тарифе (лимит БД 500 МБ; платный тариф пользователь брать НЕ хочет)
24.10 ~16:23 МСК ушла в «только чтение»: зеркало `app_point_rows` 1090 МБ + архив `app_archive_goods` 330 МБ за
полдня после выпуска 1.5.0. Сломалось всё, что пишет: вход/refresh, оплаты, бот, бесплатный период в программе
(показывала «Базовый»). Сейчас Supabase ~55 МБ — там только сайт, аккаунты, оплаты, бот, `app_points`, документы.

**Где что лежит теперь.**
- Supabase: всё, кроме архива и зеркала. Колонки `mirror_*` в `app_points` и таблицы `app_archive_*`/`app_point_rows`
  там остались ПУСТЫМИ и не используются (старая копия архива удалена truncate'ом 24.10).
- Postgres 16 на shk-wb (диск 20 ГБ после смены тарифа Simple Cloud на 360 ₽): база `pvz_archive`, роль `shkwb`
  (= пользователь сервиса, peer-auth), только unix-сокет (listen_addresses=''), память урезана —
  `/etc/postgresql/16/main/conf.d/shk-wb.conf`. Таблицы: `app_archive_{goods,clients,reviews,shk}`, `app_point_rows`,
  `app_mirror_points` (схема/время/порог удалений зеркала), функции `app_archive_push`, `app_mirror_push`,
  `app_archive_maintenance` (крон в api/cabinet.js). Схема — `selfhost/archive-schema.sql` (идемпотентна:
  `sudo -u shkwb psql -d pvz_archive -f …`). Внешних ключей на `app_points` нет — пункт проверяет `ownPoint`.
- Код: `server/_archive-db.js` (pg Pool; `ARCHIVE_DATABASE_URL=postgresql:///pvz_archive?host=/var/run/postgresql`
  в /srv/shk-wb/.env; БЕЗ переменной — старый путь через Supabase, так работают тесты и локалка). bigint seq
  отдаётся числом (setTypeParser 20). `last_sync_at` пункта при отправке архива сервер ставит в Supabase сам.
- Бэкап: `/etc/cron.d/pvz-archive-backup` → `/srv/shk-wb/backups/pvz_archive-YYYYMMDD.dump` (00:30 МСК, 7 шт.,
  ~200 МБ). Восстановить: `sudo -u shkwb pg_restore -d pvz_archive --clean <файл>`.
- Перенос делался `selfhost/archive-copy.cjs full` → переключение → `delta <max seq>` (seq сохранены, курсоры
  программ верны). Читать Supabase постранично ТОЛЬКО по пункту (индекс (point_id, seq)), иначе statement timeout.

**Зеркало пункта = платная услуга «Пункт с любого ПК».** Пакеты `mirror_1`/`mirror_3` в `_app-plans.js`
(199 ₽/мес за пункт, 3 шт. = 597, скидка за срок как у пакетов; со Стандарта; в бесплатный период НЕ входит;
безлимит — всегда). `mirrorLimit()` → фича `mirror` в правах/аренде и `mirrorLimit` в /me. Зеркало хранится для
первых N пунктов по порядку подключения; остальным `mirror/push` отвечает `{changed:0, disabled:true}` и не пишет.
ВАЖНО: `/points` неоплаченным отдаёт `mirrorAt = created_at` — пустой mirrorAt программа считает «зеркало
потеряно» и шлёт всё заново по кругу (24.10 было ~130 пачек/мин). Купили → mirrorAt=null → один полный залив.
Смотреть чужой пункт теперь можно без «Архива клиентов». Аварийный выключатель — `APP_MIRROR_DISABLED=1` в .env
(сейчас снят). Миграция Supabase `20261029_app_mirror_addon.sql` (новые пакеты в CHECK) применена.
Кабинет: отдельная карточка `Packs mirror` в SubscriptionPage. Программа 1.5.1 (выпущена 24.10 необязательной):
`cloud.rs` шлёт/тянет зеркало по `lease::has("mirror")`, архив — по `archive`; кнопки в Account.tsx.

**Уведомления админу в бот** (`server/_disk-alert.js`, запускается из `selfhost/server.cjs`, раз в 15 мин):
свободно на / меньше `DISK_ALERT_FREE_GB` (2) или Supabase ≥ `SUPABASE_ALERT_MB` (400) из 500 → сообщение через
`sendToAdmins` (те же `ADMIN_PAYMENT_TELEGRAM_IDS`), повтор раз в сутки, «освободилось» после. Размер Supabase —
rpc `app_db_size` (миграция `20261030_db_size.sql`, применена). Состояние — `/srv/shk-wb/state/disk-alert.json`.

**Как с этим работать (грабли этой сессии).**
- Снять «только чтение» Supabase: в SQL Editor `set default_transaction_read_only = off; begin; set transaction read
  write; …; commit;` (`set session characteristics …` НЕ помогает — весь текст идёт одной транзакцией).
  Размер, посчитанный в той же транзакции после truncate, ещё старый — смотреть отдельным запросом.
- Массовое удаление и деплой в прод классификатор Claude пропускает только после явного «да» пользователя
  (truncate в Supabase — не пропускает вовсе, SQL выполняет пользователь). Чтение/DDL через Management API —
  токен CLI из Credential Manager («Supabase CLI:supabase», `go-keyring-base64:`), `POST /v1/projects/<ref>/database/query`.
- Выкладка сайта: `SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@212.193.59.72` (~3 мин).
  GitHub Actions после push в main грузит архив ~50 МБ на VPS ~50 КБ/с — 15–20 мин, это нормально.
  Правка одного серверного файла: scp в `/srv/shk-wb/current/server/` (с `tr -d '
'`), chown shkwb, restart.
- Фоновое обновление Помощника не работает на ПК, где задана `PVZ_UPDATE_URL` (тестовый файл
  `/dl/test-update.json` = 1.4.18): на ПК разработчика её удалили 24.10. Проверка — в журнале nginx нет запросов
  `/api/app/update` от этого ПК. Сервер видит ПК разработчика как 188.0.179.55 (не ipify).

## Как выложить редизайн сайта (runbook)
Ветка `site-redesign` (worktree `../shk-wb-redesign`), 76 файлов vs main, 2 аддитивные миграции. Слияние в main — по команде владельца.

Предпосылки:
- Дерево `main` ЧИСТОЕ. Незакоммиченную «Печать ячеек» 2.x либо закоммитить (без CSV и `cell-print-tauri/` — они в .gitignore), либо отложить `git stash -u`. `deploy.sh` и `git checkout main` при грязном дереве не сработают.
- `.env.local` в worktree — только для локальной сборки/деплоя через `deploy.sh`. Для деплоя через `git push` (GitHub Actions) не нужен — CI собирает своими секретами.

Шаги:
1. **Пре-флайт** (в worktree, нужен `.env.local`): `npm test` (должно быть 311 зелёных) и `npm run build` (tsc+vite+Chromium-пререндер) — все маршруты пререндерятся, есть sitemap/robots/llms, JSON-LD валиден. Опц. Lighthouse на `node selfhost/server.cjs`.
2. **Миграции на боевую Supabase ДО кода** (только добавления, `require_account` по умолчанию false → старый код и клиенты «Печать ячеек» 2.0/2.1 совместимы):
   ```
   npx supabase db query --linked -f supabase/migrations/20261104_cell_print_devices.sql
   npx supabase db query --linked -f supabase/migrations/20261105_attempt_guard.sql
   ```
   Линк если не сохранён: `supabase link --project-ref <ref>` (токен CLI — в Credential Manager «Supabase CLI:supabase»). История миграций в Supabase не ведётся — применять вручную.
3. **Слияние и хвост безопасности:** в основной папке `git checkout main && git merge --no-ff site-redesign`. Конфликты ожидаются только если «Печать ячеек» уже закоммичена — в `api/cell-print.js` и `vercel.json` (оставить ОБЕ логики). Тогда же доделать отложенную фазу 7 п.4 (`api/payments.js` status) и п.5 (`api/app.js` login-request) — их не делали на ветке, чтобы не конфликтовать.
4. **Деплой** (любой из двух):
   - `git push` → GitHub Actions `deploy.yml` (катит ТОЛЬКО с main; полная сборка на сервере ~15–20 мин). Секреты — на CI.
   - `SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@212.193.59.72` (~3 мин; собирает ЛОКАЛЬНО — нужен `.env.local`; отказывает вне main/при грязном дереве, обход `ALLOW_NON_MAIN=1`).
5. **Живая проверка** (тестовый аккаунт): вход паролем/сайтом/Telegram, оплата подписки и пополнения в тестовом ЮKassa, связка «Печати ячеек» с аккаунтом. Откат сайта — `selfhost/release.sh` хранит 2 релиза (переключить симлинк current на предыдущий на сервере); миграции аддитивные, откату не требуют.
Патчи программ (`docs/program-link/`) НЕ выпускать — сервер обратно совместим.

Чего НЕ хватает в текущей среде для автоматического выката: чистого `main` (решение владельца по его незакоммиченной работе), `.env.local` (для локальной сборки) и залинкованной боевой Supabase для п.2 — без миграций код п.1 поднимать нельзя (новые таблицы/функции).

## Вход через Яндекс ID и Mail.ru (2026-11-04, ВЫЛОЖЕНО: сайт 20261104-191958, миграция применена, ключи в .env)

OAuth 2.0 по той же схеме, что вход через Telegram: `server/_oauth-login.js` находит или создаёт пользователя Supabase
и выписывает magic-link `token_hash`, браузер обменивает его на сессию на `/auth/oauth` (`OAuthCompletePage`).
Маршруты (`vercel.json` → `api/auth?action=oauth`): `GET /api/auth/oauth/providers` (что настроено),
`GET /api/auth/oauth/{yandex|vkid}/start?next=` (302 к провайдеру, подписанный state + nonce в cookie `shk_oauth`),
`GET /api/auth/oauth/{yandex|vkid}/callback` (code → профиль → аккаунт → 302 `/auth/oauth?token_hash=…`).
Ошибки возвращаются на `/?auth=login&oauth=error&reason=denied|no_email|state|provider|failed` (модалка входа).

Аккаунт: сначала связка `(provider, provider_user_id)` в `user_oauth_identities`, затем совпадение по почте провайдера
(`rpc auth_user_id_by_email`, security definer, только service_role), иначе новый пользователь с настоящей почтой и
`email_confirm: true` (провайдер её подтвердил). Google намеренно не подключён. Кнопки `OAuthButtons` на `/login` и `/register`
показываются только для провайдеров с ключами в `.env`.

Что нужно для включения:
1. `npx supabase db query --linked --yes -f supabase/migrations/20261109_oauth_identities.sql`.
2. Яндекс: https://oauth.yandex.ru/client/new — Redirect URI `https://shk-wb.ru/api/auth/oauth/yandex/callback`,
   доступы «Доступ к адресу электронной почты», «Доступ к логину, имени и фамилии, полу», «Доступ к портрету пользователя».
   Mail.ru — поверх VK ID (прямой OAuth Mail с 1 июля 2025 закрыт для новых приложений, «bad client»): приложение в
   https://id.vk.com/about/business (Web, базовый домен shk-wb.ru, Redirect `https://shk-wb.ru/api/auth/oauth/vkid/callback`,
   доступ email, «Дополнительные способы входа → Mail, ОК»). Провайдер `vkid` — одна кнопка «VK ID»: id.vk.ru/authorize (общий экран VK, ОК, Mail; `?via=mail_ru|ok_ru` в start задаёт provider) с PKCE
   (verifier в cookie shk_oauth как nonce.verifier), обмен на id.vk.ru/oauth2/auth с service_token и device_id, профиль oauth2/user_info.
   Миграция `20261110_oauth_vkid.sql` (provider in yandex|mailru|vkid).
3. В `/srv/shk-wb/.env` (бэкап `.env.bak-*`): `YANDEX_OAUTH_CLIENT_ID/SECRET`, `VKID_APP_ID`, `VKID_SERVICE_TOKEN` (сервисный ключ доступа),
   по желанию `OAUTH_STATE_SECRET` (иначе state подписывается `STICKER_CLIENT_SECRET`); `systemctl restart shk-wb`.
4. Проверка: `curl -s https://shk-wb.ru/api/auth/oauth/providers` → оба провайдера; вход на `/login` кнопкой.
Тесты: `src/api/oauth-login.test.ts`.

**Привязка к текущему кабинету (Профиль → «Способы входа», `src/auth/OAuthLinks.tsx`):** `GET /api/auth/oauth/<p>/start?mode=link`
с Bearer отвечает `{ url }`, в state уезжает id кабинета; callback сохраняет связку и возвращает на
`/cabinet/profile?oauth=linked` (чужая связка → `?oauth=error&reason=taken`). Профиль отдаёт `oauth: [{provider, email, displayName}]`,
отвязка — `DELETE /api/cabinet/oauth?provider=` (последний способ входа у кабинета без почты не удаляется, `LAST_LOGIN_METHOD`).

## Вход — модалка вместо страниц (2026-11-04)

Вход, регистрация и «забыли пароль» — одна модалка `src/auth/AuthModal.tsx` (на `Modal` из UI-кита, на телефоне нижняя
шторка), состояние в `UiStore.authModal` (`ui.openAuth(mode, { from, oauthError })`, `ui.closeAuth()`), рендерится в `App.tsx`.
После входа: `from` (контекстные ссылки «войдите» передают текущий адрес) или `/cabinet` (кнопка в шапке).
Внешние входы одним рядом `src/auth/SocialRow.tsx`: виджет Telegram (`size="medium"`, `navigateAfterLogin={false}`) + круглые
Яндекс ID / Mail.ru. Поле пароля с глазком — `src/auth/PasswordInput.tsx`. Прототип: https://claude.ai/artifact/B19JQk834z6LA9UfnqwniA

Адреса `/login`, `/register`, `/forgot-password` — редиректы (`LegacyAuthRedirect` в `App.tsx`) на `/?auth=login|register|forgot`
с сохранением query и `state.from`; `useAuthParam` в `PublicShell` открывает модалку и чистит адрес. Сервер возвращает ошибку
OAuth на `/?auth=login&oauth=error&reason=…`, бот открывает Mini App «Создать кабинет через Telegram» на `/?auth=login`.
`RequireAuth` без сессии уводит на `/` и открывает модалку с `from`. `/reset-password` остаётся страницей (ссылка из письма).

## QR-отзывы клиентов (2026-11-15, ВЫЛОЖЕНО: миграция применена, сайт 20261115-013701, коммит 8404e380)

Кабинет → «Отзывы клиентов» (`/cabinet/feedback`), бесплатно всем. Владелец создаёт до 10 QR, печатает
карточку (A5 — 2 на листе A4, A6 и наклейка 10×10 — по 4), клиент без входа открывает `/o/<slug>`:
оценка, тип (жалоба/предложение/благодарность), комментарий до 1000 знаков, до 3 фото. Отзыв приходит
в кабинет (уведомление `feedback`), в Telegram (альбомом через релей) и на почту (HTML, фото — ссылками).

**Грабля: с VPS загрузка в `api.resend.com` замирает на 128 КБ** (проверено 15.11.2026: 1 КБ — ответ за 0,3 с,
200 КБ — висит на 131072 байтах до таймаута; ошибка в журнале доставок — `fetch failed`). Текстовые письма
проходят, письмо с фото вложением — нет. Поэтому фото в письмах только ссылками на `/api/feedback/photo/<id>`
(подпись на 30 дней); тест держит тело запроса к Resend меньше 64 КБ. Повторить упавшее письмо по отзыву:
`require('./server/_feedback').retryEmail('<id отзыва>')` из каталога релиза с переменными из `.env`.

- **Код:** `server/_feedback.js` (всё), ветки в `api/cabinet.js` (публичные — до `requireUser`),
  `src/pages/cabinet/FeedbackPage.tsx`, `src/pages/FeedbackFormPage.tsx`, карточка и QR —
  `src/lib/feedback-card.ts` (свой SVG из матрицы `qrcode`, коррекция H), черновик — `src/lib/feedback-draft.ts`.
- **Анонимность:** в отзыве нет IP/User-Agent/контактов; страница клиента шлёт запросы без токена входа;
  фото перекодируются `sharp` без EXIF (геометка и модель телефона не сохраняются).
- **База:** миграция `20261122_feedback_boards.sql` (таблицы, kind `feedback`, обёртки над
  `merge_telegram_account` / `account_merge_summary` — прежние остались как `*_core`: QR переезжают при
  слиянии Telegram-аккаунта, аккаунт с QR не считается пустым). Проверена на PGlite.
- **Фото:** `/srv/shk-wb/feedback-photos` (`FEEDBACK_PHOTO_DIR`), `pending/` — загруженные, но не отправленные
  (удаляются через сутки по ходу загрузок). Владельцу — подписанные ссылки `/api/feedback/photo/<id>` на 6 ч
  (`FEEDBACK_SECRET`, пусто — `STICKER_CLIENT_SECRET`). В еженедельном бэкапе — `shk-feedback-photos.tgz`.
- **Лимиты:** просмотр 120/10 мин с IP (карточка кэшируется в памяти на 60 с — Egress), фото 20/ч с IP,
  отзыв 5/ч на пару IP+QR и 300/сутки на QR, ловушка `website`.
- **Telegram:** сайт шлёт сам, новых `callback_data` нет (под текстом — «Главное меню» = `n:menu:home`) —
  узел бота выкладывать НЕ нужно. Фото — свой multipart через `TELEGRAM_API_BASE` (`telegramUpload` в
  `_telegram-api.js` ходит мимо релея, его не трогали). Не привязан Telegram — конструктор предлагает
  привязать виджетом прямо в окне, без ухода со страницы.

**Выкладка (по порядку):**
1. `npx supabase db query --linked -f supabase/migrations/20261122_feedback_boards.sql`
2. На VPS: `mkdir -p /srv/shk-wb/feedback-photos/pending && chown -R shkwb:shkwb /srv/shk-wb/feedback-photos`
3. Влить ветку в `main`, сверить `ls -l /srv/shk-wb/current`, выложить сайт `deploy.sh` (код выхода — у самого скрипта).
4. Проверка: `curl -s -o /dev/null -w "%{http_code}" https://shk-wb.ru/o/TEST2345` → 200 (оболочка SPA),
   `https://shk-wb.ru/api/feedback/public/TEST2345` → 404 JSON `NOT_FOUND` (не голый `404: NOT_FOUND`);
   создать QR, отправить отзыв с фото с телефона, проверить кабинет, Telegram и почту.

## «Сотрудники» на сайте (2026-11-16, ВЫЛОЖЕНО: миграция применена, сайт 20261116-131818, узел бота 20261116-131954, коммит 701095fb)
Раздел кабинета `/cabinet/staff`: график, замены, зарплата, люди и настройки пунктов — те же документы `staff` и `schedule`
в `app_docs`, что синхронизирует «Помощник ПВЗ». Формат документов не менялся: программы 1.9–1.14 подхватывают правки сайта
обычной синхронизацией, обновлять их для работы сайта не нужно. План и решения — память `staff-web-section`.
- Сервер: `server/_staff.js`, действия `staff*` в `api/cabinet.js`, строки в `vercel.json`. Сайт пишет через ту же
  `rpc/app_doc_put` со сверкой версии (`p_device = null`, в истории — «сайт»). 409 `VERSION_CONFLICT` отдаёт текущую версию,
  браузер сливает (`src/lib/staff-core/merge.ts`, те же правила, что `docs.rs`) и повторяет. 409 `EMPTY_GUARD` — сайт не
  стирает всех сотрудников / все смены без подтверждения. Доступ — фича `staff`: с 16.11.2026 входит в «Стандарт» и «Про» (`STANDARD_FEATURES` в `server/_app-plans.js`; программа получает её в подписанной аренде, отдельный выпуск не нужен), пункт — только свой.
- Чтение — через общую память `_app-device-cache` (`staffdocs:<пункт>`), её сбрасывает любая запись документа: опрос
  сайта раз в 45 с не ходит в Supabase. Лимиты `staff-owner` / `staff-public` — в памяти процесса (`_rate-limit.js`).
- Общее ядро `src/lib/staff-core/`: `schedule.ts` и `payroll.ts` — побайтовые копии из программы (правка — в обоих местах),
  кисть и замены (`editor.ts`), итоги (`totals.ts`), «Все пункты» (`overview.ts`), выгрузка (`export.ts`, `xlsx.ts` — свой
  .xlsx без библиотек). Страница — `src/pages/cabinet/staff/*`, отдельный ленивый чанк.
- Ссылка для сотрудников: таблица `staff_share_links` (миграция `20261123_staff_share_links.sql`), страница `/grafik/<token>`
  (`src/pages/StaffPublicPage.tsx`), API `/api/staff/public/:token` — только имена, смены, часы и замены за три месяца.
  `/grafik/` закрыт в robots.txt и `X-Robots-Tag`. При слиянии Telegram-аккаунтов ссылки не переносятся (как и пункты).
- Порядок выкладки: миграция `npx supabase db query --linked -f supabase/migrations/20261123_staff_share_links.sql` →
  влить `staff-web` в `main` → `deploy.sh` → проверить `curl -s -o /dev/null -w "%{http_code}" https://shk-wb.ru/api/cabinet/staff`
  (ожидается 401) и `/api/staff/public/AAAAAAAAAAAA` (404 `LINK_INACTIVE`). Изменился `_app-plans.js` (описание «Стандарта» в экране тарифов бота) — после сайта выложить и узел бота в Германии.
- 16.11.2026, замечание владельца после первой выкладки: табель «люди × дни» с кистью непонятен. Вкладка «График»
  переделана в календарь месяца (как в его проекте admin-pvz): клетка — кто работает, нажатие открывает день справа
  (`DayPanel.tsx`, на телефоне — окном), у каждого сотрудника список «Не работает / Смена / Полсмены / Свои часы».
  В пункте по умолчанию один человек в день: `schedule.maxPerDay` (1–3, Настройки); второго панель не ставит молча —
  предлагает заменить или разрешить двоих. Поле новое и необязательное, старые программы его сохраняют как есть.
  ВЫЛОЖЕНО 16.11.2026: коммит d8e9e20e, сайт 20261116-163834, узел бота 20261116-163940 (код бота не менялся,
  узел выложен для выравнивания). Сервер и миграции не менялись — только страница кабинета.
- 16–17.11.2026, вторая волна замечаний владельца (ветка `staff-quickpick-payroll`, НЕ выложено на момент записи):
  - **Список у дня** (`DayQuickPick.tsx`): нажатие на день раскрывает под клеткой список людей — нажатие на имя ставит
    полную смену, повторное убирает, «Я сам», «Убрать всех». При «один человек в день» другое имя сразу заменяет стоящего
    (`quickToggle` в `editor.ts`); полсмены, свои часы, замену и введённые товары молча не теряет — спрашивает. На телефоне
    список встроен в окно дня. Календарь вынесен в `MonthCalendar.tsx` (его же показывает мастер).
  - **Превышение лимита**: метка «2 чел.» на клетке, постоянный блок в панели дня («Оставить только: X» / «Разрешить
    двоих»), легенда под календарём, пункт «Что осталось сделать» смотрит весь открытый месяц, включая прошедшие дни.
  - **Выплата за месяц вкладки**: `PayDialog` / `MassPayDialog` считают по месяцу, открытому во вкладке (`dueFor`), сумма
    «Зарплаты» подставляется сама, «Выплатить всем» есть в любом открытом месяце не позже текущего. Выплата попадает в
    месяц по `date`, поэтому зарплата за октябрь, выданная 16 ноября, пишется `date: 2026-10-31` + новое необязательное
    `paidAt: 2026-11-16` (`payDate`, `paidOn`). `monthCalc` не менялся — программы 1.9–1.14 считают те же суммы до рубля,
    только покажут такую выплату датой «31 октября».
  - **Оплаченные дни** (`paidDays` в `payroll.ts`): выплаты закрывают отработанные дни по порядку, с самых ранних, премии —
    в последнюю очередь; в календаре у оплаченной смены галочка, у частично оплаченной — полукруг, в панели дня — текст.
    Раскладка всегда сходится с «Осталось выплатить». Месяц до `ledgerFrom` считается сам по себе.
  - **Мастер шаблона**: день начала цикла выбирается нажатием в мини-месяце (кнопки «Сдвинуть на день» убраны), на шаге
    проверки — календарь месяца с галочками недель (`weeksDays`), «С сегодня до конца месяца» / «Весь месяц»; прошедшие дни
    по умолчанию не заполняются. Блокирует только превышение, которое создаёт само заполнение; уже стоявшее — подсказкой.
  - Вкладка «Отчёты» в зарплате (печать всех листков, свод для Excel, расходы по месяцам) — перенос из программы.
  - **Копии для программы**: `node scripts/sync-staff-core.mjs --write` копирует `src/lib/staff-core/*` (кроме `types.ts`) и
    экраны `ScheduleTab`, `DayPanel`, `DayQuickPick`, `MonthCalendar`, `TemplateWizard`, `ReplaceDialog`, `PayrollTab`, `parts`,
    `staff.module.css` в `_local-only/pvz-tauri` (`src/lib/staff-core/`, `src/screens/staff/web/`); `--check` сверяет, тест
    `src/lib/staff-core/sync.test.ts` падает, если копии разошлись. Правим только на сайте. Что экрану разрешено в программе,
    задаёт `StaffDocs.caps` (сайт не задаёт).
- **«Что нового»** (правило владельца с 16.11.2026: каждое обновление показывает, что изменилось): записи в
  `src/lib/whats-new.ts` (`WHATS_NEW`, новые сверху: id, дата, заголовок и пункты на двух языках, пути разделов). Окно
  `src/components/WhatsNew.tsx` показывается в кабинете один раз на запись (не показывается аккаунтам, созданным позже даты
  записи), у пункта меню изменённого раздела — плашка «new», пока раздел не открыли или не прошло 14 дней. Хранится в
  `localStorage` (`cabinet_whats_new_v1_<userId>`), сервер не участвует. **Меняется то, что видит пользователь в кабинете, —
  добавить запись в `WHATS_NEW`.**
- Тесты: `src/lib/staff-core/*.test.ts`, `src/api/staff.test.ts`, `src/pages/cabinet/staff/StaffPage.test.tsx`.
  НЕ проверено: настоящий браузер с боевыми данными, одновременная правка с сайта и с ПК вживую, открытие .xlsx в Excel/Р7.
