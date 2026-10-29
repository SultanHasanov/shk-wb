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
  `wallet_move` с уникальным `event_key`. Пополнение = заказ `wallet_topup` (100/300/500/1000 или своя 100–50000 ₽, бонус +5% от
  500, +10% от 1000; Mini App `/bot-checkout?kind=topup&amount=N`). Покупка с баланса = обычный заказ `amount=0, gross_amount=0,
  wallet_paid_kopecks=цена` → `wallet_pay_order` → штатный `completeOrder` → при ошибке `wallet_refund_order`
  (`payWithWallet`). Так реферальная комиссия и выручка считаются один раз — с пополнения. `notifyCompleted` молчит для таких заказов.
  Генерации: сначала коды доступа, иначе `generationCost(units)` = min(пакет сверху, штучная цена пакета снизу) и докупка на свой
  код (`renewal_target_key`). Магазин `shop:*` (подписка Помощника, ключ Печати ячеек новый/продление, пакет подборов WBPK) —
  цену считает `resolveShopItem` на сервере, кнопка оплаты `shop:pay:<nonce>:…` + claim в `telegram_generation_requests`.
  «Кто поставил оценку» = 25 ₽ с баланса (`bot_review_spend` переопределён, повтор того же автора бесплатный).
  Не хватает денег → одна кнопка «💳 Пополнить на X ₽ и купить» (`topupAndBuyRow`, X = недостающее, мин. 25 ₽):
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
- Тестовый бот @wb_newtest_bot: `TELEGRAM_BOT_TOKEN=<токен> PUBLIC_APP_URL=https://shk-wb.ru node scripts/run-telegram-bot-local.cjs`
  (боевой Supabase). Вход через Mini App в тестовом боте не работает (initData подписан боевым ботом).
