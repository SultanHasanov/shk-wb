# Telegram-бот и релей

Бот — часть серверного процесса сайта (`server/_telegram-wb-bot.js`), выкладывается вместе с сайтом
(`selfhost/deploy.sh`), отдельного деплоя у него нет.

> Идемпотентность: защита от повторного списания (`requestId` / `app_code_once`) сделана ТОЛЬКО для
> настольной программы. В боте два сообщения с одним SID — две генерации и два списания; переносить туда
> `requestId` не надо. Подробности — `docs/pvz-helper.md`, раздел «Выпуск 2026-10-26».
> Дедупликация повторной доставки одного `update_id` остаётся.

## Telegram-релей (2026-10-20) — ВАЖНО
С VPS недоступны api.telegram.org и весь IP Vercel 76.76.21.21 (с 20.10 ~09:11 МСК; прежний релей
`tg-relay-three.vercel.app` для ИСХОДЯЩИХ перестал работать → бот не отвечал). Исходящие теперь через Supabase Edge
Function `supabase/functions/tg-relay` (тот же протокол: `POST /api/<метод>` + Bearer токен, `GET /media?url=` для стикеров).
`TELEGRAM_API_BASE=https://ouxsvlfaszsaykzpnkwh.supabase.co/functions/v1/tg-relay` в `/srv/shk-wb/.env` (бэкап
`.env.bak-1792482978`). Пропускает только ботов из секрета `ALLOWED_BOT_IDS` (8804824717 боевой, 8894809412 тестовый).
Деплой: `npx supabase functions deploy tg-relay --no-verify-jwt --use-api --yes` (CLI 3.x требует `supabase/config.toml` с `project_id`, без `--yes` в неинтерактивном режиме отказывается). ВХОДЯЩИЕ (webhook) с 03.11.2026 тоже через
Supabase: Telegram → `<TELEGRAM_API_BASE>/webhook` → `shk-wb.ru/api/telegram/webhook` (Vercel в 12:44 МСК перестал доставать
до VPS → 504, бот молчал; напрямую на VPS вебхук ставить нельзя — с VPS адреса Telegram не отвечают, и обратный хэндшейк
тоже не проходит). Переключение: `setWebhook` через релей с `secret_token` = `TELEGRAM_WEBHOOK_SECRET` из `.env`, см.
`selfhost/tg-set-webhook.sh`. Откат — вернуть старый TELEGRAM_API_BASE.

## Релей на немецком сервере tg.shk-wb.ru:88 (с 03.11.2026) — ОСНОВНОЙ
Сервер aeza в Германии: `root@109.120.140.116`, ключ тот же `~/.ssh/shk-wb_ed25519`, Debian 13, 1 CPU / 2 GB.
Там уже живёт VPN-релей на Caddy (сайт `{$TPROXY_HOSTNAME}` = tg.shk-wb.ru на 80/443, панель на 8443, `mtproto-proxy`
на 2398, бэкенды 127.0.0.1:8080/8081/8090) — **не трогать**. Релей бота — отдельный блок `/etc/caddy/Caddyfile.tg-relay`
(подключён `import` в конце `/etc/caddy/Caddyfile`), порт **88** (Telegram допускает вебхуки на 80/88/443/8443),
сертификат общий с :443. Протокол тот же, что у Supabase-релея: `POST /api/<метод>` + Bearer-токен (пропускает
только ботов 8804824717 и 8894809412, остальным 403), `GET /file?path=`, `GET /media/api/stickers/{image,pdf}?…`,
`POST /webhook` → `https://shk-wb.ru/api/telegram/webhook` (секрет сверяет сервер). У Caddy `admin off` и нет
`ExecReload`: после правки `caddy validate --config /etc/caddy/Caddyfile` (нужны переменные из `systemctl show caddy
-p Environment`) и `systemctl restart caddy` — VPN-релей прервётся на секунду.
Замеры с Германии: api.telegram.org 50 мс на запрос, Supabase 1 мс пинг, VPS РФ 36 мс пинг; с VPS РФ `getMe` через
:88 ~0,17 с (через Supabase edge было ~0,35 с плюс холодные старты). Итог 03.11 на прогретом процессе:
`bot message /menu` 92–142 мс и `bot callback menu:home` 235–294 мс (до релея 464 / 900 мс), Telegram получает
200 за ~0,3 с. Первые запросы после `systemctl restart shk-wb` холодные (новые TLS), это норма.
Включение: `TELEGRAM_API_BASE=https://tg.shk-wb.ru:88` в `/srv/shk-wb/.env` + `systemctl restart shk-wb`,
затем `bash /srv/shk-wb/tg-set-webhook.sh https://tg.shk-wb.ru:88/webhook`. Supabase-релей остаётся задеплоенным
как запасной: откат — вернуть `TELEGRAM_API_BASE=https://ouxsvlfaszsaykzpnkwh.supabase.co/functions/v1/tg-relay`,
рестарт, `tg-set-webhook.sh` без аргумента. Картинки стикеров сервер теперь шлёт как `<релей>/media/api/stickers/…`
(путь, не `?url=`), Supabase-функция понимает обе формы.

## Узел бота в Германии (с 03.11.2026) — где обрабатываются апдейты
Сам процесс бота живёт на немецком сервере рядом с релеем: та же кодовая база, `selfhost/server.cjs` в роли
`BOT_ROLE=bot` (`selfhost/bot-role.cjs`), порт 3001, unit `selfhost/shk-wb-bot.service` (на сервере он называется
`shk-wb`), каталоги `/srv/shk-wb/{releases,current,state}`, `.env` по `selfhost/env.bot.example` (без `TELEGRAM_API_BASE`:
Telegram и Supabase — напрямую, Supabase там в 1 мс). Узел отдаёт только `/api/telegram/webhook`, `/api/stickers/image|pdf` и `/api/internal/bot` (RPC).
**Картинки и PDF для Telegram** — `STICKER_MEDIA_BASE=https://ouxsvlfaszsaykzpnkwh.supabase.co/functions/v1/tg-relay/media`
(Supabase забирает их с shk-wb.ru): через `tg.shk-wb.ru:88/media` Telegram файлы НЕ скачивает — на нестандартном
порту отвечает «Bad Request: wrong type of the web page content» (03.11.2026, сломались «Скачать PDF» и QR кода
клиента; сам Caddy при этом отдавал PNG правильно). Маршрут `/media` в Caddy оставлен, но не используется. Caddy :88
(`selfhost/caddy/Caddyfile.tg-relay`): `/webhook` и `/media/*` → 127.0.0.1:3001, `/rpc` → узел только с IP VPS,
`/api/*` и `/file` — по-прежнему релей для исходящих вызовов сайта.
Сайт на VPS зовёт бота через `server/_bot-rpc.js` (`BOT_RPC_URL=https://tg.shk-wb.ru:88/rpc`, `BOT_RPC_SECRET`):
`afterWalletTopup` (оплата «пополнить и купить»), `notifyMiniAppAuthorized`, `bindTelegramReferral` (вход через Telegram).
Узел не ответил — вызов выполняется локально, как раньше. За узлом следит `_bot-health` сайта (`BOT_NODE_URL`).
**Выкладка:** меняется бот — выкладывать ОБА сервера: сайт как обычно, узел —
`ROLE=bot SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@109.120.140.116` (без сборки фронта; GitHub
Actions узел пока не выкладывает). Проверка: на узле `curl 127.0.0.1:3001/api/telegram/webhook` → 200, `/api/cabinet` → 404.
**Откат на обработку на VPS:** в `/etc/caddy/Caddyfile.tg-relay` вернуть `/webhook` → `https://shk-wb.ru` и
`/media/*` → `https://shk-wb.ru` (бэкап `Caddyfile.tg-relay.bak-*`), `systemctl restart caddy`; на VPS убрать
`BOT_RPC_URL` и `BOT_NODE_URL`, `systemctl restart shk-wb`. Код бота на VPS остаётся, URL вебхука не меняется.

## Оплата из бота без Mini App (03.11.2026)
Кнопки пополнения (`tp:<сумма>[:<then>]`, `topupRows`/`topupAndBuyRow`) и ввод своей суммы больше не открывают
Mini App `/bot-checkout` (он входил в кабинет, слал «Вход выполнен» и только потом открывал ЮKassa — путало людей).
`startTopupPayment` → `server/_bot-checkout.js` создаёт заказ через общий обработчик `api/payments.js`
(action=create) синтетическим запросом с `req.internalUser` (ставится только в процессе, у HTTP-запроса поля нет) и
показывает в том же сообщении кнопку-ссылку `url` на страницу ЮKassa с подписью про оферту (`accepted: true`).
`then` и экран покупки уходят в `walletThen`/`walletMessage` как раньше, зачисление и автопокупка — по вебхуку
ЮKassa → `afterWalletTopup` (через RPC на узел). Возврат после оплаты — `/payment-result?from=telegram`.
Кабинет не привязан — по-прежнему `sendLoginPrompt` (вход через Mini App или виджет на сайте). Страница
`/bot-checkout` остаётся для старых сообщений с кнопками `web_app`.

## Сообщения админу о здоровье бота (03.11.2026)
Два уровня, получатели — `adminIds()` из `server/_admin-alerts.js` (ADMIN_PAYMENT_TELEGRAM_IDS, по умолчанию владелец).
1. **Внутри сервера** — `server/_bot-health.js`, стартует из `selfhost/server.cjs`, проверка раз в минуту:
   апдейты за 10 минут (≥3 с ошибкой или ≥3 медленных дольше `BOT_HEALTH_SLOW_MS`=3 с при доле ≥30%) → «Бот отвечает
   с перебоями»; `getMe` через релей дольше 5 с или с ошибкой два раза подряд → «Релей Telegram не отвечает»;
   `getWebhookInfo` с очередью ≥20 или свежей `last_error_date` (3 мин) → «Telegram не может доставить апдейты».
   Повтор не чаще раза в 30 минут, «снова в порядке» после двух хороших проверок, состояние в
   `/srv/shk-wb/state/bot-health.json`. Если сломан рабочий релей, сообщение уходит через запасной
   `TELEGRAM_API_FALLBACK_BASE` (Supabase) — переменная есть в `.env`.
2. **Снаружи, на немецком сервере** — `selfhost/tg-watchdog/` (скрипт + systemd service/timer): раз в минуту
   `GET https://shk-wb.ru/api/telegram/webhook`, два провала подряд → «Сервер бота не отвечает» напрямую через
   api.telegram.org, повтор раз в 30 минут, после двух удачных проверок — «снова отвечает». Это единственный канал,
   когда лёг сам процесс или VPS. Установка: скрипт в `/usr/local/bin/tg-watchdog.sh`, юниты в `/etc/systemd/system/`,
   `/etc/tg-watchdog.env` (chmod 600: `TG_BOT_TOKEN`, `TG_ADMIN_IDS`, `TARGET_URL`), `systemctl enable --now tg-watchdog.timer`.
   Лог: `journalctl -t tg-watchdog`.

## Горячий путь и скорость отклика (03.11.2026)
До ускорения нажатие кнопки стоило 1,5–2,5 с: 5–10 сетевых запросов строго по очереди (Supabase ~30 мс по тёплому
соединению и ~200 мс по новому, каждый вызов Telegram через релей ~350 мс), «часики» снимались третьим запросом,
а 200 Telegram получал только после полной обработки. Что сделано и чего не ломать:
- `handleTelegramUpdate` отвечает 200 сразу после `claimUpdate`, обработка (`processUpdate`) идёт в фоне; локальный
  polling передаёт `req.waitForCompletion` и ждёт. Не смогли закрепить апдейт (Supabase лёг) — 502, Telegram повторит.
  Повторы отсекает память (`seenUpdates`, 2000 id) и уже потом таблица `telegram_bot_updates`.
- `answerCallbackQuery` без текста уходит первым и не ждётся; с текстом (тост) — по-прежнему `await`.
- `touchSubscriber` (last_seen + уведомление о новичке) — в фоне. Независимые чтения — `Promise.all`
  (`handleMenu`, `/start`, `requestConfirmation`, `renderWizard` правит экран и пишет сессию параллельно).
- Кеши в памяти процесса (сервер один, писатели там же): сессия мастера (`sessionCache`, сквозная запись, `getSession`
  отдаёт копию), telegram → user_id (`server/_telegram-user-cache.js`, 10 мин, «нет связки» — 60 с; `api/auth.js` и
  `api/cabinet.js` сбрасывают при привязке/отвязке), подключение WB (60 с), «технический аккаунт» (10 мин).
  Баланс, коды доступа, скидки, entitlements НЕ кешируются.
- Сеть: `server/_fetch-retry.js` — таймаут 10 с и один повтор только на сетевую ошибку до ответа. Supabase повторяет
  GET/DELETE/upsert (`on_conflict` + `Prefer: resolution=`), обычный insert и RPC — нет. Telegram повторяет только
  `RETRY_SAFE_METHODS` (answerCallbackQuery, editMessageText, …); `sendMessage`/`sendPhoto`/`sendDocument` не
  повторяются — дубль сообщения хуже его отсутствия. В `selfhost/server.cjs` стоит `undici` Agent с keep-alive 60 с.
- Лог на каждый апдейт: `bot callback menu:home 180 ms` / `bot message /start 240 ms` — по нему смотрят скорость.
  Связь VPS ↔ Cloudflare (Supabase и релей) по нескольку раз в час рвётся на 15–50 с — в логе это `fetch retry (...)`.
В `.env.local` лежит токен ТЕСТОВОГО бота (не боевого).

## Telegram-бот: меню, баланс, магазин (2026-10-20, ВЫЛОЖЕНО коммитом 158d3c2f + 3d94d9bd)
- `server/_telegram-wb-bot.js`: главное меню — инлайн-сообщение (`showMainMenu`, callback `menu:*`), постоянная клавиатура
  только `[☰ Меню] [🏷 Стикеры и QR]`; старые тексты кнопок («💳 Остаток», «👤 Аккаунт», «➕ Создать ШК») принимаются.
  Все экраны — ОДНО сообщение, которое редактируется (`showScreen` = editMessageText, при неудаче новое сообщение).
  Мастер стикеров (`wizardView`/`renderWizard`/`wizardBack`, «⬅️ Назад»), ввод пользователя удаляется, ошибка строкой сверху;
  кнопки старых сообщений мастера отвечают «шаг устарел» (`draft.msgId`); идемпотентность генерации — `msgId + draft.nonce`.
  Витрины `showFindCode`/`showHelperInfo`/`showCellPrintInfo`/`showSupport`, канал https://t.me/wbtools_ru в меню.
  Команды бота — `BOT_COMMANDS` (setMyCommands в `scripts/run-telegram-bot-local.cjs`; для боевого бота вызвать отдельно).
- **Баланс** (`server/_wallet.js`, миграция `20261023_wallet.sql` ПРИМЕНЕНА): `wallet_accounts`/`wallet_ledger`, всё через
  `wallet_move` с уникальным `event_key`. Пополнение = заказ `wallet_topup` (100/300/500/1000 или своя 20–50000 ₽ — `MIN_TOPUP`, бонус +5% от
  500, +10% от 1000; Mini App `/bot-checkout?kind=topup&amount=N`). Покупка с баланса = обычный заказ `amount=0, gross_amount=0,
  wallet_paid_kopecks=цена` → `wallet_pay_order` → штатный `completeOrder` → при ошибке `wallet_refund_order`
  (`payWithWallet`). Так реферальная комиссия и выручка считаются один раз — с пополнения. `notifyCompleted` молчит для таких заказов.
  Генерации: сначала коды доступа, иначе `generationCost(units)` = min(пакет сверху, штучная цена пакета снизу) и докупка на свой
  код (`renewal_target_key`). Магазин `shop:*` (подписка Помощника, ключ Печати ячеек новый/продление, пакет подборов WBPK) —
  цену считает `resolveShopItem` на сервере, кнопка оплаты `shop:pay:<nonce>:…` + claim в `telegram_generation_requests`.
  «Кто поставил оценку» = 25 ₽ с баланса (`bot_review_spend` переопределён, повтор того же автора бесплатный).
  Не хватает денег → одна кнопка «💳 Пополнить на X ₽ и купить» (`topupAndBuyRow`, X = недостающее, мин. 20 ₽ — `MIN_TOPUP`):
  `/bot-checkout?kind=topup&amount=X&then=<gen|rv:ф:стр:№|shop:…>&m=<экран>` → `pricing_snapshot.wallet.then/message`
  (api/payments.js проверяет формат; переиспользование старого счёта для wallet_topup отключено) → после зачисления
  `notifyCompleted` вызывает `afterWalletTopup` (ленивый require бота) и покупка проходит сама.
  `admin_wallet_adjust(user, kopecks, note)` — ручное начисление. Таблица `bot_review_credits` (20261022) больше не используется.
- Напоминание в бот за 2 дня до конца подписки Помощника и ключа Печати ячеек — `notifyTelegramExpiry2d` в `api/cabinet.js`
  (крон, всем с привязанным Telegram, кнопка «Продлить с баланса»).
- **Рефералка в боте** (поверх сайта: `referral_accounts`/`bind_referral`, 10% с оплат приглашённого, в т.ч. с пополнений
  баланса). Ссылка `t.me/<бот>?start=r_<КОД>` (имя бота — `getMe`, кэш). `/start r_…` → `captureReferral` пишет
  `telegram_referral_captures` (только если кабинета ещё нет, первый переход побеждает). Привязка `bindTelegramReferral` —
  в `notifyMiniAppAuthorized` и в `api/auth.js` после `createTelegramUser` (вход виджетом). Экран `menu:ref` / `/invite`:
  ссылка, приглашено, заработано, «Перевести на баланс» (`referral_to_wallet`), вывод на карту — `/cabinet/referrals`.
  Пригласившему в бот: «новый пользователь по ссылке» и «+X ₽ — коллега сделал оплату» (`notifyReferralReward` в `_payments.js`).
  Миграция `20261025_bot_referrals.sql` ПРИМЕНЕНА. Тексты бота — короткие (просьба пользователя: «коротко и понятно»).
- `20261024_bot_session_states.sql` (ПРИМЕНЕНА): в проверку состояний сессии добавлены `await_access_code` (ввод кода
  доступа падал с 400 ещё до этих правок) и `await_topup_amount`.

## Скидка 20% участникам «Клуба вопросов» — `server/_club.js` (2026-11-02)
Клуб — бот @zara34_help_bot (проект zara-bot). Подписку проверяем у него: `GET $ZARA_CLUB_CHECK_URL?tg=<telegram id>`
с заголовком `x-club-secret: $CLUB_CHECK_SECRET` → `{active}`; кэш 10 мин, ошибка → без скидки. Оба секрета — в `/srv/shk-wb/.env`.
- **Бот**: «Код клиента» (50 → 40 ₽) и «Кто поставил оценку» (25 → 20 ₽) — только пришедшим из группы клуба
  (`/start club_code|club_reviews` → `telegram_bot_subscribers.club_ref_at`, 30 дней) — `clubDiscount(tg)`, `clubPrice`.
  ШК и магазин без скидки. До 02.11 код жил в `_telegram-wb-bot.js`, поведение не менялось.
- **Тариф «Про» Помощника** (с 02.11.2026): `api/payments.js` при `app_subscription` + `appPlan === 'pro'` вызывает
  `clubUserDiscount(user.id)` — Telegram аккаунта из `user_telegram_identities`, переход из группы не нужен — и
  уменьшает `total` на 20% поверх скидки за срок (`pricing_snapshot.club_discount_percent = 20`; `snapshot.app`
  не трогается — из него SQL берёт лимиты). Работает и для оплаты из программы (`api/app.js` pay → тот же create).
  Кабинет: `GET /api/app/me` → `clubDiscountPercent` (0 | 20), `SubscriptionPage` показывает «Про» со скидкой и
  считает чекаут той же формулой (`planPriceFor`). Без привязки Telegram скидки нет — бот клуба подсказывает войти
  на сайт через Telegram. Админу в уведомлении о заказе — строка «Скидка клуба 20%». Только «Про»: Стандарт, услуги,
  пакеты — без скидки. Окно тарифов в программе цену со скидкой пока не показывает (TODO в pvz-helper.md).
## ШК с фото (2026-11-01, ВЫЛОЖЕНО релизом 20261101-231546, коммит 2b5eb7ec)
- Анонс с фото разослан 01.11 всем подписчикам: доставлено 562, заблокировали бота 37, ошибок 0.
  Админская рассылка (`telegram-broadcast` в `server/_admin-cabinet.js`) умеет только текст — анонс с фото
  слали разовым скриптом на сервере: фото один раз multipart через релей, дальше по `file_id`.
- Релей теперь пропускает и multipart (загрузку файлов) — с VPS можно слать фото буфером через `${TELEGRAM_API_BASE}/api/sendPhoto`.
  `telegramUpload` в `server/_telegram-api.js` по-прежнему ходит напрямую в api.telegram.org (работает только локально).
- На сервере одно фото читается 3–7 с (на ПК 1–2 с).
- Человек присылает скриншот WB Point («Подмена», «Зависшие ШК», карточка ШК) или фото экрана WB-PVZ — бот
  читает номер сам. Локально, без внешних сервисов: `server/_shk-vision.js` = `sharp` (серый, ширина 2000,
  normalize) + `tesseract.js` (PSM 11, только цифры), до трёх проходов. Языковой файл —
  `server/assets/tessdata/eng.traineddata.gz`, в интернет за ним не ходим. Распознавания по одному, таймаут 30 с,
  воркер (~100–150 МБ) выгружается после 5 мин простоя. Занимает 1–2 с на фото.
- Правило номера (`extractShkCodes`): 11 цифр подряд или «7 цифр + 4 цифры»; у WB-PVZ значок «копировать»
  справа OCR читает как «0» → «4894976 81720» → берём первые 4. Баркод (13), ПВЗ (8), цены и даты не проходят.
- Где работает: шаг мастера «По номеру» (1 номер → подтверждение, 2–5 → кнопки `gen:pick:<ШК>`) и фото вне мастера
  (кнопка `gen:num:<ШК>` → сразу подтверждение). Голые 7–12 цифр текстом → выбор «стикер по ШК» / «QR клиента по ID».
  Фото не чаще раза в 10 с на человека. Коробки (10 цифр) — только в мастере.
- Скачивание: `downloadFile` в `server/_telegram-api.js`; на сервере через релей — новый маршрут
  `GET <релей>/file?path=<file_path>` в `supabase/functions/tg-relay`. **Порядок выпуска: сначала задеплоить
  релей и проверить `/file` (не 404), потом выкладывать сайт.**
- Тесты: `src/api/shk-vision.test.ts` на пяти реальных примерах `src/test/fixtures/shk-*.jpg` (1280 px, как отдаёт Telegram).

- Тестовый бот @wb_newtest_bot: `TELEGRAM_BOT_TOKEN=<токен> PUBLIC_APP_URL=https://shk-wb.ru node scripts/run-telegram-bot-local.cjs`
  (боевой Supabase). Вход через Mini App в тестовом боте не работает (initData подписан боевым ботом).
