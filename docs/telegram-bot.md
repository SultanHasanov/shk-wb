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
Деплой: `npx supabase functions deploy tg-relay --no-verify-jwt --use-api`. ВХОДЯЩИЕ (webhook) по-прежнему идут
Telegram → `tg-relay-three.vercel.app/webhook` → сервер — это направление работает. Откат — вернуть старый TELEGRAM_API_BASE.
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
