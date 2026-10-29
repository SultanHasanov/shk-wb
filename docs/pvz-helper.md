# «Помощник ПВЗ» (Tauri) — программа для пунктов выдачи

Исходники: `_local-only/pvz-tauri/` (gitignored). Версия — `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`
+ `package.json` + `package-lock.json`. Выпуск — раздел «Как выпустить обновление Помощника».
История Python-версии 1.4.x — `docs/archive/pvz-helper-python-1.4.md` (не инструкция).
Хранилище облака (Supabase + свой Postgres на shk-wb, бэкапы, аварийные выключатели) — `docs/site.md`.

## Сотрудники — ТОЛЬКО из онлайн-API WB (в sqlite их нет: issued_by пустое, ФИО нет)
Проверено по `my-pvz.wb.ru6.har`. Авторизация — тот же вход в WB, что для отзывов
(`WbReviewsClient`: request_code → confirm_code → load_point_ids → enrich_for_point → JWT `self.token`).
Запросы: `X-Token: token`, `Origin: https://my-pvz.wb.ru`. Эндпоинты:
- сотрудники: `POST pickpoint-ext-delivery.wb.ru/service-manager/api/v2/personal-account/my-pvz/managers`
  тело `{"filter":{"is_active":true,"pickpoint_ids":[<external_id>],"search":""}}`
- ФИО+тел: `POST r-point.wb.ru/gw/common/v1/users-data` тело `{"user_ids":[...]}`
- оборот: `GET point-quality.wb.ru/employee-stat-v2/frontend/v3/statistic/turnover?limit=21&offset=0`
«Ячейка сотрудника» = `buyer_sid` совпал с `user_sid` сотрудника. Ростер кэшируется на диск
(`pvz_config.save_staff_cache`) и показывается при старте. Запросы к WB иногда таймаутят (флаки) —
обрабатывать мягко (у `ReviewsScreen._session_expired`, у `StaffScreen` fallback на кэш/вход).

## Админка подписок «Помощник ПВЗ» (2026-10-17, код написан, НЕ задеплоен)
- Миграция `20261019_app_admin_grant.sql`: вынес логику сегмента в `app_apply_subscription(user,plan,months,snap,source,order_id)`
  (продление/повышение с пересчётом/понижение + снимок лимитов + колонка `source`); `complete_app_subscription_order`
  теперь делегирует ей (`source='payment'`). Добавил `admin_grant_app_subscription` (`source='admin'`) и
  `admin_revoke_app_subscription`. Починен пограничный баг: отрезок со `starts_at=now()` при повышении/отзыве
  отменяется, а не обрывается в ноль длины (нарушало `ends_at>starts_at`). Проверено транзакцией+ROLLBACK на боевой БД:
  выдача/повышение/понижение/продление/отзыв и путь оплаты (succeeded+идемпотентность) — ок.
- Backend: `server/_admin-users.js` — в `userDetail` добавлены `app.{entitlements,subscriptions,devices,usage}`;
  экшены `grantAppSubscription`/`revokeAppSubscription`/`revokeAppDevice` (snapshot из `orderSnapshot` в `_app-plans.js`).
- Фронт: `AdminUserPage` — блок «Помощник ПВЗ» (тариф/лимиты/подписки с бейджем источника/ПК/расход + форма выдачи
  тариф×срок, отзыв подписки и ПК); `AdminProgramPage` — обзор тарифов из `useAppPlans()` + подсказка, где выдавать.
- Напоминание на почту за ~3 дня до конца подписки УЖЕ есть: крон `/api/cron/notifications` (api/cabinet.js, ветка
  app_subscriptions, дедуп, пропуск если продлено), на сервере cron 6:00 UTC + RESEND_*/CRON_SECRET заданы. Уедет с деплоем.
- Релизный установщик 1.4.0 собран (`_local-only/pvz-tauri/src-tauri/target/release/bundle/nsis/`, с ускорением argon2, подпись).

## Платный режим после бесплатного периода (2026-10-19, ВЫЛОЖЕНО: миграция 20261020, сайт, программа 1.4.13 необязательной; app_free_until=2026-10-31T20:59:59Z; ОСТАЛОСЬ: PVZ_APP_MIN_VERSION=1.4.13 до 31.10)
- В бесплатный период `/me` отдаёт `subscription.effective {startsAt,endsAt,paidUntil}` — даты после сдвига (`effectiveDates` в _app-account.js, та же формула, что planShift); программа и кабинет показывают «начнётся … · оплачено до …».
- Оплата по QR СБП в программе (1.4.11): `PayDialog.tsx` (`openPay({kind,id,months})`, опрос статуса раз в 3 с) → `app_pay`/`app_pay_status` → `/api/app/pay` (прокси в api/payments.js create с `paymentMethod:sbp_qr`, ЮKassa `confirmation:{type:qr}`) и `/api/app/pay-status`. СБП в магазине ЮKassa подключён. Новые `/api/app/*` маршруты добавлять в vercel.json (иначе 404).
Миграции применяются через `npx supabase db query --linked -f <файл>` (история миграций в Supabase не ведётся).
- Тарифы `server/_app-plans.js`: разделы `BASIC/STANDARD/PRO_FEATURES` (+boxes, goods, tryon, notes, risky; `sync` убран),
  услуга `ADDONS.archive` 590 ₽/6 мес, 990 ₽/12 мес, `minPlan: standard`; `effectiveFeatures(plan, addons, free)`.
- Миграция `20261020_app_addons.sql`: `app_addons`, `app_apply_addon`, `complete_app_addon_order`, `admin_grant/revoke_app_addon`,
  `app_entitlements.addons`. Проверено на PGlite (скрипт в scratchpad сессии, 11/11). Оплата `productKind:'app_addon'`.
- Права в ПОДПИСАННОЙ аренде: `/api/app/lease` с `Authorization` → `payload.rights {user,plan,features,archive_until,free}`
  (`_app-account.js leaseRights`). Программа: `lease::has/require(feature)` (`lease.rs`), `with_feature` в lib.rs,
  ошибка `PLAN_REQUIRED:<f>`. Подбор кода/обзор/карточка ячейки НЕ закрыты (лимит — на сервере). Нет поля `rights` (старый
  сервер) → режим legacy (решает фронт); `rights:null` (сбой БД) → прошлые подписанные права (`last_rights` в lease.bin).
- Архив собирается ВСЕГДА; без `archive` закрыто только чтение (`db::dossier` считает `archive_hidden`, `client_summary`,
  `sids_for_phone_suffix`, `archive::stats().locked`).
- Фронт программы: `derivePlan(account, lease)` (без фолбэка «вошёл → Стандарт»), `has()` = список фич, `PlanLocked` вместо
  закрытого раздела (не монтирует его), замки в меню, `PlanNotice` (конец free за 14 дн, подписки за 3 дн, нет тарифа),
  тарифы + карточка «Архив» в «Аккаунте», `?plan=`/`?addon=archive` → оплата в кабинете.
- Бесплатный период: дата окончания `site_settings.app_free_until` (админка → «Программа»); `appFreeMode()` считает режим
  выключенным с этой даты; крон сам выключает со сдвигом подписок И услуг до даты, письма+Telegram за 7 и 1 день.
- Порядок запуска: миграции 18/19/20 → деплой сайта (+PVZ_LEASE_PRIVATE_KEY) → выпуск программы 1.4.8 →
  `PVZ_APP_MIN_VERSION=1.4.8` ДО даты конца free (старые версии без прав по аренде) → задать дату в админке.
- Дата конца бесплатного периода — **31.10.2026 включительно** (в админке: 2026-10-31 → до 23:59:59 МСК).
- КП для владельцев ПВЗ: Claude Docs https://claude.ai/code/artifact/8fbc16f4-42a9-42d3-aed6-7101f75ef61e

## Статистика «Помощника ПВЗ» (2026-10-20, выложено)
Админка → «Программа» → «Помощник ПВЗ — скачивания и установки» (`admin_app_stats` в миграции 20261021).
Скачивания пишутся в `app_download_events` кнопкой сайта `/api/payments/download-program` (хеш IP+UA вместо IP,
`?from=tg` → источник); она же отдаёт последнюю версию из latest.json. Прямые ссылки `/dl/…` не считаются.
История до 20.10 перенесена из журналов nginx (source='журнал'). Установки = `app_devices` (вошли в программу).

## Отдельная программа на Tauri + Rust (ЯДРО СОБРАНО 2026-10-17)
Решение 2026-10-17: собрать «Помощник ПВЗ» заново, **отдельной программой** на Tauri (Rust + React),
текущую CustomTkinter-версию не трогать и не переписывать на месте.

**СТАТУС: ядро собрано и проверено** — исходники в `_local-only/pvz-tauri/` (вся папка gitignored).
Стек: Tauri 2, Rust (rusqlite read-only, argon2+md-5+rayon, reqwest rustls/http2, DPAPI через прямой
FFI к crypt32 — не крейт `windows`), фронт Vite+React18+TS с боковым меню и виртуализацией списков.
Данные ОБЩИЕ с текущей программой (`%APPDATA%/wb_pvz_tools`, тот же X-Device-Id) → вход/ключ из
текущей версии действуют сразу. Rust-модули — порт 1:1 pvz_data/crack_cell/pvz_account/pvz_images/
pvz_config. Готово: Ячейки, карточка+подбор кода (argon2/md5, стоп, прогресс, QR, кэш до 00:00),
Дорогие, В пути, Клиенты, Досье, Настройки, Аккаунт/тарифы/вход. **2 ЭТАП СОБРАН**: `wb_online.rs`
(вход WB по SMS с решением X-Pow, my-orgs/enrich, сотрудники, отзывы), `telegram.rs`, `stickers.rs`
(генерация/превью/PDF); экраны Сотрудники (ручной список + импорт из WB + ставки/смены-календарь/
зарплата), Отзывы, Стикеры, Telegram в настройках. Сессия WB — отдельный `wb_session_tauri.json`. В нём же куки WB (свой jar в `wb_online.rs`, reqwest cookie_store НЕ используется):
`wbx-validation-key` (.wb.ru, живёт часы — без неё токен = 401 «validation key is invalid») и `wbx-refresh`
(auth-my-pvz.wb.ru/v2/auth, ~3 мес). На 401 — `WbClient::refresh()` = `POST /v2/auth/slide-v3` (как сайт),
затем повтор; не вышло → `WB_SESSION_EXPIRED` → фронт показывает вход. Хранятся `token` (enrich, привязан к
организации) и `base_token` (для my-orgs/enrich). Отзывы+сводки клиентов (`review_clients`) кэшируются в
localStorage `reviews-cache-v1` до «Обновить». Ярлык «Помощник ПВЗ (Про, тест)» → `src-tauri/target-local/debug`
(сборка: `CARGO_TARGET_DIR=src-tauri/target-local npx tauri build --debug --no-bundle`; debug-сборка = Про).
Остаток 2 этапа: прямая термопечать стикеров на принтер (пока через системный PDF). Проверено:
npm build ок, cargo build линкуется, exe стартует. Запуск: `cd _local-only/pvz-tauri && npm install
&& npm run tauri dev` (PVZ_PREVIEW=1 → Про без входа). Установщик: `npm run tauri build` (NSIS).
Осталось: живой тест на
машине с базой WB и аккаунтом, 2 этап.

### Скорость подбора кода argon2 (замерено 2026-10-17, cracker.rs)
Хеши WB: `argon2id m=8192(8МиБ),t=1,p=1`. Один поток: current(verify+парсинг PHC на попытку) 216 х/с →
reuse(парсинг 1 раз + переиспользование буфера памяти по потокам, thread_local `ARGON_MEM`) **442 х/с, ×2**.
C-libargon2 (argon2-cffi, как в Python) = 208 х/с — МЕДЛЕННЕЕ чистого Rust, C не нужен. `target-cpu=v2/v3` — 0.
Параллельно (22 потока, упор в память, масштаб ×7.5) ~3300 х/с: 5 цифр ≈15–30 с, 6 цифр ≈до 5.5 мин.
**Главное:** argon2 в debug в ~14 раз медленнее release (15 vs 216 х/с) → отладочный ярлык тормозит.
Лечится `[profile.dev.package.argon2/blake2] opt-level=3` в Cargo.toml — debug-билд подбирает почти как release.
Дальше ускорять нечего: fill 8 МиБ на попытку неизбежен. Длины кодов — константа `CODE_LENGTHS` в cracker.rs = `[6]`
(по требованию ищем только 6-значные коды; релиз 1.4.1).

Исходный замысел (ориентиры), текущую программу им НЕ трогать:
- Rust: подбор кода (argon2), чтение базы WB ПВЗ (rusqlite, read-only), вход в WB и отзывы, печать стикеров.
- Интерфейс: React в стиле сайта (`src/styles/tokens.css`, Inter, #cb11ab).
- Сервер и аккаунты — те же: `/api/app/*`, вход логином/паролем сайта, тарифы/подписки.
- Ориентиры из аналога WBCash Omni (`C:\Program Files\WBCash-Omni`, Tauri; гайд wbcash.pro/omni/guide):
  инвентаризация (снимок склада → скан → отчёт найдено/нет/лишнее, восстановление после перезапуска);
  заметки о клиентах, общие для ПК, с окном поверх остальных при появлении клиента на примерке;
  поиск по ШК со сканером и озвучкой ячейки; история ячейки за 2–3 недели; журнал операций (статусы ШК);
  статистика дня с графиком по часам; трей; автообновление с подписью.
- В текущую программу функции Omni НЕ добавляем.

### Запуск, обновления, аренда, очистка (Tauri, 2026-10-17, код написан, сервер НЕ задеплоен)
- Запуск: `gate` в store = `boot` (сплэш, ≤5 с: check_update + lease_refresh) → `update` (UpdateGate, всё закрыто) /
  `offline` (OfflineGate) / null → главная `Home.tsx` (плитки из `src/app/nav.ts`, общий список с Sidebar).
  Любая команда, вернувшая `UPDATE_REQUIRED`/`LEASE_EXPIRED`, поднимает заслонку (обёртка `invoke` в `lib/ipc.ts`).
- Обновление: tauri-plugin-updater, `updater.rs`. Сервер `GET /api/app/update` (`server/_app-update.js`, до
  enforceProgramVersion) — формат Tauri + `mandatory`/`min_version`. Обязательность: env `PVZ_APP_MIN_VERSION`
  (без деплоя) или `"mandatory": true` в latest.json. Программа шлёт `X-App-Name: pvz-helper` → 426 считается
  по `PVZ_APP_MIN_VERSION`, а не `PROGRAM_MIN_VERSION`.
- Аренда (`lease.rs`): без связи работает ≤ `PVZ_LEASE_SECONDS` (3600). `POST /api/app/lease` подписан Ed25519
  (`PVZ_LEASE_PRIVATE_KEY`), публичный ключ зашит в `lease.rs`. Файл `lease.bin` (DPAPI), защита от перевода часов.
  Debug-сборка и `PVZ_PREVIEW=1` — без аренды. `lease::ensure()` стоит в `with_db`, find_code, wb_*, stickers_generate.
  `OFFLINE_HOURS` в account.rs = 1.
- Очистка (`cleanup.rs`, только release, раз на версию): тихо удаляет «Подбор кодов» и CustomTkinter-«Помощник»
  (Inno AppId `{9F1C4B2E-…}`, `{B7E42A19-…}`), их установщики в Загрузках/Рабочем столе/Документах/TEMP.
  `%APPDATA%\wb_pvz_tools` и «Печать ячеек» не трогает. Журнал — `wb_pvz_tools\cleanup.log`.
- Ключи — `_local-only/pvz-tauri/keys/` (gitignored, НЕ терять): `updater.key(.pub)` — подпись обновлений,
  `lease-private.pem` — в /srv/shk-wb/.env как PVZ_LEASE_PRIVATE_KEY, `lease-public.b64` — уже в lease.rs.
- ДО релиза: задеплоить сайт (api/app.js, vercel.json, server/_app-update.js), на сервере в .env прописать
  PVZ_LEASE_PRIVATE_KEY (иначе /lease = 503 и release-сборка через час встанет в OfflineGate), создать
  /srv/shk-wb/app-updates/pvz-helper/. Удаление старых версий проверять ТОЛЬКО на чистой ВМ.

#### Как выпустить обновление Помощника (быстрый деплой, так выложены 1.4.3 и 1.4.4)
Если менялась ТОЛЬКО программа (`_local-only/pvz-tauri`), сайт НЕ пересобирать и НЕ выкладывать
(push в main = полная сборка+tar+`npm ci` на сервере — это долго и не нужно). На сервер уходит
один установщик (~3.5 МБ, ~12 с) + подпись; копия для ссылки «Скачать» делается `cp` НА СЕРВЕРЕ,
второй раз не отправляется. Сервер: `root@212.193.59.72`, ключ `~/.ssh/shk-wb_ed25519`.

1. Версия: `src-tauri/Cargo.toml` (`version = "X.Y.Z"`, APP_VERSION берётся отсюда) и `src-tauri/tauri.conf.json`.
2. Сборка с подписью (пароль у ключа пустой), из `_local-only/pvz-tauri`:
   ```
   TAURI_SIGNING_PRIVATE_KEY="$(cat keys/updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build
   ```
   → `src-tauri/target/release/bundle/nsis/Помощник ПВЗ (Tauri)_X.Y.Z_x64-setup.exe` и `.sig`.
   Отладочный `tauri dev` (target-local) сборке не мешает — можно не закрывать.
3. Выкладка (Git Bash, из папки `src-tauri/target/release/bundle/nsis`; подставить V и NOTES):
   ```
   V=X.Y.Z; NOTES="Что нового — одной-двумя фразами для плашки обновления."
   F="Помощник ПВЗ (Tauri)_${V}_x64-setup.exe"; SIG="$(cat "$F.sig")"; NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   K="-i $HOME/.ssh/shk-wb_ed25519 -o BatchMode=yes"; H=root@212.193.59.72
   scp $K "$F" "$F.sig" "$H:/srv/shk-wb/app-updates/pvz-helper/"
   ssh $K $H "cd /srv/shk-wb/app-updates/pvz-helper && cp latest.json latest.json.bak-\$(date +%s) \
     && cp '$F' public/pvz-helper-$V-setup.exe \
     && printf '%s' '{\"version\":\"$V\",\"notes\":\"$NOTES\",\"pub_date\":\"$NOW\",\"file\":\"$F\",\"signature\":\"$SIG\"}' > latest.json.new \
     && python3 -c 'import json;json.load(open(\"latest.json.new\"))' && mv latest.json.new latest.json \
     && chown shkwb:shkwb '$F' '$F.sig' latest.json public/pvz-helper-$V-setup.exe && sha256sum '$F' public/pvz-helper-$V-setup.exe"
   sha256sum "$F"   # хеш должен совпасть с обоими на сервере
   ```
   В NOTES не использовать кавычки `"` и `'` (ломают JSON/команду) — «ёлочки» можно.
   Для обязательного обновления в JSON добавить `"mandatory": true` (или `"min_version"`).
4. Проверка (обе должны пройти):
   ```
   curl -s "https://shk-wb.ru/api/app/update?current=<прошлая>&target=windows&arch=x86_64" -H "X-App-Name: pvz-helper"   # → "version":"V"
   curl -sI https://shk-wb.ru/dl/pvz-helper-$V-setup.exe | grep -E "^HTTP|Content-Length"                             # → 200
   ```
5. Откат: на сервере `cp latest.json.bak-<время> latest.json` (старые setup.exe не удаляем).
6. Сделать обязательным уже выложенное: `PVZ_APP_MIN_VERSION=X.Y.Z` в `/srv/shk-wb/.env` и `systemctl restart shk-wb`.
7. (Опц., уже требует деплоя сайта) `downloads/version.json` — ссылки для старого «Подбор кодов» и кнопки «Скачать»
   на сайте. Если не трогать, они дадут прошлую версию, а она сама обновится до новой по `latest.json`.
   GitHub для файлов НЕ использовать: из РФ открывается не у всех, а старый «Подбор кодов» при ошибке скачивания
   молча закрывает окно обновления (баг с `ex` в лямбде).

**Фоновое обновление (код написан 2026-10-23, НЕ выпущено):** `updater.rs` сразу скачивает найденную версию
(подпись проверяется), сам проверяет раз в 30 мин (`updater::spawn`, только release) и ставит скачанное, когда
никто не трогает клавиатуру/мышь 10 мин (окно открыто) / 3 мин (в трее), нет клиента на примерке, не идёт подбор
кода/стикеры (`updater::Busy`), не открыто окно видео. `installMode: quiet` — без окна установщика; из трея
перезапускается в трей (метка `update_hidden.flag`). Настройка `general.auto_update` (Настройки → «Окно при примерке»).
В latest.json: `"auto": false` — только по кнопке; `"mandatory": true, "mandatory_after": "<ISO>"` — до даты ставится
как обычное, после — заслонка. Эти два поля отдаёт `server/_app-update.js` — нужен деплой сайта (без него auto=да).

Как программа узнаёт о новой версии (с 1.4.4): при запуске, каждые 30 мин (`UPDATE_EVERY_MS` в `store.tsx`)
и по кнопке «Обновить» в шапке — плашка появляется без перезапуска; закрытая «Позже» плашка показывается снова,
когда выходит следующая версия. Версии до 1.4.4 проверяют только при запуске и раз в 6 ч.

Бесплатный режим — админка → «Программа» → переключатель (`site_settings.app_free_mode`, `server/_app-free.js`).
При выключении подписки сдвигаются вперёд на длину бесплатного периода.

### 1.4.5–1.4.6 (2026-10-18/19, выложено)
- «Товар по ШК» (`GoodsInfo.tsx`): `GET point.wb.ru/api/v3/goods/find_by/shk?search_base64=…` → `status_history`
  (статус/время/`full_name` сотрудника), коробка, брак. WB отдаёт историю ~1.5–3 мес. и только своего пункта.
- WB-клиент: общая блокировка `state.wb` только на enrich (`wb_prepare`), сами запросы — по копии `WbClient::snapshot()`
  через `wb_call` (на 401 — refresh, на 403 — `invalidate_enrich`, один повтор). enrich-токен восстанавливается из
  `wb_session_tauri.json` после перезапуска. `wb_status` — без блокировки (`status_handle`). Отзывы — только по «Обновить».
- Навигация: стек «назад» в `store.tsx` (`navigate`), раздел под карточкой/досье не размонтируется (App.tsx, display:none).
- Примерка (`tryon.rs`): поток раз в 1 с читает `buyers_on_try_on`/`goods_on_try_on`, окно `tryon` (`#tryon`,
  `TryOnPopup.tsx`) поверх всех, `focusable(false)` — не крадёт ввод у сканера. Режимы `tryon.show`: notes (по умолч.)
  / risky / all; звук `tryon.sound` = MessageBeep. Журнал `wb_pvz_tools/tryon.log` (задержка относительно WB) —
  живой тест на клиенте ещё НЕ проводился.
- Заметки (`notes.rs`, `client_notes.json`) — пока только локально; синхронизация между ПК через сервер — следующий шаг.
- Архив (`archive.rs`, `archive.sqlite`): при старте и раз в 5 мин копирует товары пункта + отказы/возвраты из «в пути»
  + buyers; `db::dossier`/`client_summary`/`sids_for_phone_suffix` добирают из него то, что WB удалил.
- Трей + закрытие в трей + single-instance; автозапуск `autostart.rs` (HKCU Run `PvzHelper`, `--autostart` → без окна,
  окно в tauri.conf `visible:false`, показывается в setup). Ручное «Обновить» снова показывает скрытую плашку обновления.
- Сборка debug: `CARGO_TARGET_DIR="$(pwd -W)/src-tauri/target-local"` (абсолютный путь, иначе exe уезжает в
  `src-tauri/src-tauri/target-local`).

### График и зарплата сотрудников (2026-10-19, выложено в 1.4.7)
Раздел «Сотрудники» → вкладки График · Зарплата · Сотрудники (`src/screens/Staff.tsx` — оболочка и общий контекст
`useStaffCtx`; `src/screens/staff/{Schedule,AutofillDialog,Payroll,EmployeeMonth,StaffList}.tsx`, стили `src/theme/staff.css`).
Макет: артефакт Claude Design https://claude.ai/artifact/8XATo6FL6CttzrQMTRegde
- Вся логика — `src/lib/schedule.ts` (смены/замены/автозаполнение/зарплата/привязка удержаний). Rust только хранит
  `wb_pvz_tools/schedule.json` (`schedule_load/save`) и приносит удержания.
- Оплата: ставка за смену с даты (`staff_list[].rates[{from,rate}]`), ½ смены = ½ ставки, свои часы = часы/длина смены.
  Замена: смена уходит заменяющему с `replaces`. Аванс по правилу (за смены до N-го / % / фикс), правится у сотрудника.
- Удержания WB — `src-tauri/src/penalties.rs` (`wb_penalties`, кэш `penalties.json` + `events`). Эндпоинты из
  my-pvz.wb.ru6.har: `write-off-ext-delivery.wb.ru/my-pvz/v2/overdue-goods-hold-add/list` (зависшие),
  `/replace-report/goods/list` (подмены), `/get-defect-panel` (брак), `/get-history-goods-and-box` (история ШК).
  Типы WB: expired/to_hold → будет удержано, hold → удержано (ticket → оспаривается), contenstated → оспаривается,
  add → снято WB (не вычитается). `employee_sid`/`user_sid` = WB user id = `sid` сотрудника в списке.
  Привязка: ручное решение → сотрудник в записи → последний сотрудник в истории ШК → кто был на смене, поровну.
- Тест логики: esbuild-скрипт по сценариям (2/2, замены, ½, аванс, двое на смене, снятое WB) — 28/28 ок.
- Правила после аудита (2026-10-19): «будет удержано» (pending) в зарплату не идёт; возврат WB удержания из ЗАКРЫТОГО
  месяца — доплата в месяце возврата (`closed[m].wbKeys` + `wbCredits`); закрытый месяц только просмотр (снимок
  `closed.rows`, правки — после «Открыть снова»); Rust `merge` больше НЕ ставит «снято» пропавшим записям (`missing`,
  а разделы с ошибкой сети не трогаются — `failed`); «Отменить» — по дням (`snapshotDays/restoreDays`); остаток = всего − аванс.
- НЕ проверено вживую: ответы списаний на реальном аккаунте (тип `expired` у зависших/подмен мог не поддерживаться —
  ошибки разделов глушатся), печать ведомости в WebView2.

## «Видео по ШК» — Ivideon (Помощник Tauri, 2026-10-21/22, код написан, НЕ выпущен)
Раздел программы: по ШК найти товар в базе WB → время приёмки → архив камер Ivideon на это время. Всё в
`_local-only/pvz-tauri` (gitignored, коммита нет). Проверялось в debug-сборке (`target-local/debug`), в релиз не выкладывалось.
- Данные: `goods_in_pick_point.acceptance_unix_timestamp` (мс UTC), поиск по `scanned_code`/`shk_code`/`sticker_code`/`item_uid`,
  затем `surplus_goods`. Время в WB и Ivideon — UTC, часовой пояс только для показа.
- Ivideon API (публичной доки нет, разобрано по коду их embed-плеера; подробности — память `ivideon-archive-api`):
  `GET openapi-alpha.ivideon.com/cameras/<id>/archive_stream?op=GET&access_token=…&format=hls&start_time&end_time&speed`
  → 302 на HLS. `:` в ID камеры НЕ кодировать. Шкала записей — `POST …/archive_timeline` (пропуски в архиве).
  `speed` ускоряет на сервере (playbackRate не годится — плейлист дописывается ~в реальном времени).
- Rust `src-tauri/src/video.rs`: lookup, настройки (`config.json` → `video`: `cameras` [{id,name}] цепочка по порядку,
  `before_sec`=60, `window_min`=90, `tz`; `offset_sec` остался в бэке, в UI убран), токен — `wb_pvz_tools/ivideon.bin` (DPAPI),
  `cameras`, `archive_url`, `timeline`/`coverage` (нет записи → реальное начало + `gap`), `session`, `stream_from`.
  Команды в lib.rs: `video_lookup/settings/save_settings/cameras/open/session/stream`; окно `video` (`index.html#video`),
  в capabilities добавлено `video`; CSP: `*.extcam.com`, `*.ivideon.com`, `media-src blob:`, `worker-src blob:`.
- Фронт: `src/screens/VideoSearch.tsx` (поиск, карточка с фото, настройки по шагам 1-2-3: токен → таблица цепочки
  «Выше/Ниже/Убрать» + «Добавить камеру» → время), `src/screens/VideoWindow.tsx` (hls.js 1.5.20): по 2 камеры в ряд,
  окно прокручивается (`html.video-window body`), все стартуют с T−60 с и СВЯЗАНЫ; ручное управление камерой → «отдельно»
  (только по клику/клавише — `dataset.touched`, сам плеер тоже шлёт pause/seeked); медленные камеры ждём («Ждём камеру N»,
  «Не ждать эту камеру», лимит 20 с); «Начать сначала» (малиновая) — всё сначала и снова связано; бейдж «Скан через m:ss»
  (малиновый, пульсирует за 7 с) / «● Скан товара» / «+m:ss после скана»; плашка пропуска в архиве; ПАУЗА пользователем →
  меню «Продолжить» + «Перейти на камеру» (все камеры аккаунта): есть на экране — перемотка ровно на момент паузы + рамка + прокрутка,
  нет — добавляется в сетку с того же момента.
- Скорость (2026-10-22): `video_open` сразу открывает/показывает окно с шапкой товара («Загружаем камеры…»,
  событие `video://pending` + команда `video_pending`, номер открытия — последнее побеждает), сессия приходит
  `video://session`. В `open_stream` шкала (`coverage`) и ссылка (`archive_url`) запрашиваются параллельно; шкала ±12 ч
  кэшируется в памяти на 2 мин (`TIMELINE`, по камере) — перемотки/скорость без лишнего запроса. hls.js:
  `maxBufferLength 20`, `backBufferLength 180`, `startFragPrefetch`. Перемотка кнопками на той же скорости внутри
  `video.seekable` — просто `currentTime`, без нового потока. Первый сегмент Ivideon генерирует сам — это не ускорить.
- Общая пауза: ручная пауза на любой камере → `pauseAll`: все на паузу (`held`) и все «отдельно». Включают по одной
  («Продолжить» или Play плеера → `unhold`), каждая идёт сама; следующая пауза снова останавливает все. Меню
  «Продолжить / Перейти на камеру» — на камере, где нажали паузу, на остальных — плашка «▶ Продолжить».
  Связать снова — «Начать сначала». Слежка за человеком: момент последней паузы (`pauseMs`) — «Продолжить» на другой
  камере перематывает её на этот момент, «Перейти на камеру» — тоже ровно на него (откат −5 с убран). Перемотка
  сначала внутри загруженного ролика (`seekLocal`, точно до кадра), иначе новый поток.
- **Расхождение камер ~3–5 с (НЕ решено, 2026-10-22).** Замер по часам в кадре (OSD; ffmpeg первый кадр сегмента):
  Склад точно, Стол +1 с, Клиентская зона −5 с и −3 с в разные моменты. Сдвиг плавает → это Ivideon начинает новый
  поток с ключевого кадра (у камеры длинный GOP), а не часы камер. В HLS нет `EXT-X-PROGRAM-DATE-TIME`, PTS сегментов
  с нуля → реальное начало ролика программа узнать не может. Внутри загруженного ролика перемотка точная.
  Рекомендовано пользователю: в настройках камер «I-Frame Interval / GOP» = частоте кадров (1 ключевой кадр/с).
  Если не поможет — вариант «читать часы OSD с кадра» (canvas + распознавание цифр) и выравнивать камеры по ним
  (у «Записи экрана» OSD нет). Пользователь ранее НЕ хотел ручных поправок времени.
- **ОСТОРОЖНО с замерами:** много параллельных `archive_stream` на одном аккаунте путают сессии Ivideon (разные
  камеры отдавали один и тот же сегмент, в программе у пользователя — levelLoadTimeOut). Скрипты замера —
  в scratchpad сессии (`osd-probe.ps1`, `hls-probe.ps1`, токен из `ivideon.bin` через DPAPI CurrentUser).
- **Без VPN камеры не грузятся (НЕ решено).** У пользователя Happ (TUN + прокси 127.0.0.1:10809). Серверы Ivideon
  в РФ (openapi-alpha — Selectel Москва, rr*.extcam.com — Москва), браузер без VPN openapi открывает, а программа —
  «error sending request». reqwest собран без default-features → системный прокси Windows НЕ читает, переменных
  прокси нет. Добавлен `net_error` в video.rs: токен/URL из текста ошибки убраны (раньше токен показывался в окне),
  выводится цепочка причин `source()`. Ждём от пользователя текст новой ошибки без VPN. Если запрос из Rust рвётся,
  а WebView работает — вариант отдать запрос ссылки на поток окну (hls.js сам пройдёт 302), нужен CORS и CSP.
- Заодно: на карточках товаров (`GoodCard`) ШК с копированием (`Good.shk`: в пункте `scanned_code`, «в пути» `shk_code`;
  `PIP_GOODS_COLS` в db.rs, индексы доп. колонок сдвинуты на +1); в открытой ячейке «яч. N» больше не показывается (`inCell`).
- Раздел без тарифа (в nav без `feature`) — спросить пользователя, закрывать ли тарифом.
- Осталось: живой тест перехода между камерами и синхронизации; решить тариф; релиз (версия, сборка с подписью, выкладка —
  см. «Как выпустить обновление Помощника»). На будущее (не делали): режим «Раскладка» — скан товара + QR ячейки при
  раскладке → точное время и ячейка, «Склад» сразу на момент раскладки.
- Токен Ivideon пользователь прислал в чат открытым текстом — посоветовано перевыпустить после проверки.

## Облако аккаунта: пункты, архив, синхронизация (2026-10-24, ВЫЛОЖЕНО: миграция 20261028, сайт 8b9ba34f, программа 1.5.0 обязательной, PVZ_APP_MIN_VERSION=1.5.0)
- Миграция `20261028_app_points_sync.sql` (применена): `app_points` (пункты аккаунта, лимит — `app_register_point`),
  `app_archive_{goods,clients,reviews,shk}` (архив по пункту, `app_archive_push` — старое не перезаписывает новое, удалений нет),
  `app_point_rows` (зеркало базы WB пункта, `app_mirror_push`; С 24.10 архив и зеркало — в Postgres на shk-wb,
  см. «Хранилище облака Помощника»), `app_docs`(+history, 20 версий; `app_doc_put` с версией →
  `VERSION_CONFLICT`), `app_secret_access`, `app_signup_requests`, `app_sync_maintenance` (крон в api/cabinet.js).
  Пакеты в `_app-plans.js`: `devices_1/3`, `points_1/3`; лимиты Базовый 1/1, Стандарт 1 пункт/2 ПК, Про 2/4 (`accountLimits`).
- Сервер: `server/_app-sync.js`, `server/_app-crypto.js` (AES-256-GCM, ключ на пользователя HKDF; детерминированный IV),
  регистрация/пароль в `_app-account.js`, маршруты в `api/app.js` + `vercel.json`. Тесты `src/api/app-sync.test.ts`.
  Env: `APP_DATA_KEY`, `APP_SECRETS_KEY` (значения — в `.env.sync.local`, при деплое ТЕ ЖЕ в /srv/shk-wb/.env),
  `APP_UNLIMITED_USER_IDS` (безлимит владельца: bcc5a14a-426c-4cfd-9794-f7db146b2bfe, Telegram @sult987).
- Программа: `points.rs` (свой/выбранный пункт, `active_db`), `archive.rs` (колонка point + dirty, миграция с бэкапом
  `archive.sqlite.bak-*`), `mirror.rs`, `docs.rs` (3-стороннее слияние, бэкапы в `backups/`), `cloud.rs` (цикл раз в минуту,
  журнал `cloud.log`). Вход в WB между ПК НЕ переносится (каждый ПК входит по SMS сам); сессия WB локально под DPAPI.
  Фронт: `AuthDialog.tsx` (вход/регистрация/сброс), новый `screens/Account.tsx` (профиль), `layout/PointSwitcher.tsx`.
- ВАЖНО: новая программа переделывает `archive.sqlite` под пункты — старые версии (≤1.4.18) после этого не пишут архив.
  Поэтому выпускать вместе с обязательным обновлением; при отладке запускать только с `PVZ_DATA_DIR` (tools/run-two-pcs.ps1).
- Тест: `tools/make-test-db.py` (ПВЗ 900001/900002, `--advance` = «прошёл день»), debug: Настройки → «Источник базы WB».
- Кабинет (пункты, пакеты) и админка (пункты, выдача пакетов) — сделаны. Не проверено вживую: «статусы
  с ПК пункта доходят до ПК дома» на аккаунте владельца.

## «Загрузка с другого ПК» вместо облачного зеркала (2026-10-24, ВЫЛОЖЕНО: сайт bcb76780, программа 1.6.0 ОБЯЗАТЕЛЬНОЙ)
План: `~/.claude/plans/pasted-content-id-6950-prancy-dahl.md`. Решения пользователя: данные пункта хранятся ТОЛЬКО на
компьютерах (и зеркало, и архив); сервер — передатчик; пользователь сам выбирает, с какого ПК грузить; загруженное —
в ОТДЕЛЬНЫЕ файлы, не в папку WB и не в свой архив; маленькая база не стирает большую.
- **База WB теперь открывается только `db::open_wb` (`immutable=1`)** — раньше `open_ro` брал SHARED-блокировку и мог ронять
  COMMIT WB_PVZ («Ошибка базы данных…»), как было в «Печати ячеек». Тест `db::tests` это доказывает (старый способ блокирует,
  новый нет). Фоновые копирования читают через `db::read_stable` (принимают проход, только если WB не писал). Примерка
  открывает соединение на каждый опрос. `open_ro` — только для своих файлов; `open_source` выбирает сам.
- Программа: `downloads.rs` (копии `wb_pvz_tools/downloads/<аккаунт>/<пункт>/<id ПК>/{current,history}.sqlite + source.json`;
  полная замена current — через `.new`, отказ если новая меньше вдвое; история — только `archive::merge`, удалений нет;
  удаление — только кнопкой), `mirror.rs` (журнал `share_journal.sqlite`, `serve` перечитывает WB по запросу; таблица
  «похудела» вдвое — проход не принят, пока то же не повторится через 5 мин), `archive.rs` (только свой пункт, `lseq` триггерами,
  `serve` постранично; чтение истории = свой архив + все копии, дедуп по uid/rid/sid), `relay.rs` (inbox держат только ПК со
  своей базой WB и услугой `mirror`; загрузка `one/download`, авто раз в 5 мин для открытого чужого пункта), `cloud.rs`
  (больше НЕ шлёт/не тянет архив и зеркало; один раз забирает старый архив с сервера в копию `cloud` «Облако (до версии 1.6)»;
  `downloads::migrate_legacy` переносит `points/<id>/mirror.sqlite` и чужие пункты из archive.sqlite туда же, с бэкапом).
  `general.account_user`, `general.point_source`, `general.downloads_v1`, `general.cloud_export_done` в config.json.
  Debug/тесты: `PVZ_WB_DB=<копия базы>` подменяет базу WB. UI: `components/LoadFromPc.tsx`, `PointSwitcher.tsx` (RemoteBar).
- Сервер: `server/_app-relay.js` (в памяти процесса, куски на диске `RELAY_DIR`/tmp, TTL 30 мин), маршруты `relay-*` в
  `api/app.js` (свой лимит 3000/600 с), rewrite в vercel.json. `archive/pull` с `export:true` без проверки услуги (выгрузка своих
  данных). `APP_CLOUD_STORAGE_OFF=1` → archive/mirror push ничего не пишут. Пакеты mirror_* переименованы в «Загрузка с другого ПК».
- Тесты: `npx vitest run src/api/app-relay.test.ts`; `cargo test --lib` (downloads::tests на копии test-db/pvz-1.sqlite;
  с `PVZ_RELAY_MOCK=http://127.0.0.1:3999` + scratchpad `relay-mock.cjs` — ещё и через передатчик);
  `PVZ_ARCHIVE_COPY=<папка с копией archive.sqlite> cargo test --lib archive::tests` (на копии настоящего: 22720 товаров ок).
- **Выпуск 2026-10-24 ~23:50 МСК:** сайт задеплоен `selfhost/deploy.sh` (релиз 20261024-234446, коммит bcb76780);
  установщик 1.6.0 в `/srv/shk-wb/app-updates/pvz-helper/` + `/dl/pvz-helper-1.6.0-setup.exe` (sha256 f07ee4dc…),
  latest.json с `"mandatory": true` (бэкап latest.json.bak-*); в `/srv/shk-wb/.env` (бэкап .env.bak-*):
  `PVZ_APP_MIN_VERSION=1.6.0` (было 1.5.0) и `APP_CLOUD_STORAGE_OFF=1`; `systemctl restart shk-wb`. Проверено: 1.5.1 при
  входе получает 426, /api/app/update отдаёт 1.6.0 mandatory, /api/app/relay/* отвечает 401 без входа (маршрут есть).
  Откат: `cp latest.json.bak-<время> latest.json`, в .env вернуть PVZ_APP_MIN_VERSION=1.5.0 и убрать APP_CLOUD_STORAGE_OFF.
- ОСТАЛОСЬ: живой тест на двух реальных ПК (вживую 1.6.0 до выпуска НЕ проверялась — только тесты и локальный передатчик);
  следить за `cloud.log` у пользователей и журналом сервера (`journalctl -u shk-wb`) по `relay`; через ~30 дней очистить
  `app_point_rows`/`app_archive_*` в pvz_archive и крон-бэкап (ТОЛЬКО с подтверждения пользователя).
  Передатчик держит состояние в памяти процесса — при перезапуске shk-wb незаконченные загрузки начинаются заново.
- **Названия компьютеров (2026-10-24, выложено вместе с 1.6.0):** сервер берёт имя ПК только при ПЕРВОМ входе (`registerDevice` шлёт
  пустое имя для известного ПК), `PATCH /api/app/devices/:id {name}` (`renameDevice`) — из программы и кабинета.
  Программа: `account::device_name()` = `general.pc_name` → адрес пункта из базы WB → имя Windows; `PcNameHost`
  (components/PcName.tsx): ПК с WB сам переименовывается в адрес пункта, личный ПК — окно «Как назвать этот компьютер?».
  `pay`/`pay-status` в api/app.js теперь ДО `requireDevice` — в окне «Лимит компьютеров» кнопки «+1/+3 компьютера» и
  «Подключить этот компьютер». Имя в «Загрузке с другого ПК» берётся из аккаунта (device.name). Оплата переключения —
  как была: ПК, пункты и «Загрузка с другого ПК» отдельно (решение пользователя).
- **1.6.1 (2026-10-25, ВЫЛОЖЕНО фоновым обновлением: latest.json `"auto": true`, без mandatory; sha256 76542310…;
  PVZ_APP_MIN_VERSION остаётся 1.6.0 — 1.5.1 обновляется сразу до 1.6.1 обязательно):**
  - Обновление: кнопка «Обновить» во время фоновой загрузки больше не пишет «ещё скачивается» — ждёт её с прогрессом
    (фоновая загрузка тоже шлёт `update://progress`). У 1.5.1 баг остаётся: подождать и нажать ещё раз.
  - Хранение: свой архив и копии истории с других ПК — 1 год (`archive::prune` после каждого пакета в копию). История из
    копий (в т.ч. отзывы/ШК) видна только с услугой «Архив» (`archive::everywhere`).
  - Копии: перед первой загрузкой окно с примерным размером (история×750 Б + строки×700 Б) и свободным местом
    (`disk_free`, GetDiskFreeSpaceExW); `downloads::check_space` не даёт начать при нехватке; «заменить копию с другого ПК
    или хранить обе» (старая удаляется только после успешной загрузки новой); размер каждой копии и всего; подсказка
    «не открывалась 60 дней — можно удалить» (сами копии программа НЕ удаляет — решение пользователя). `openedAt` в source.json.
  - Замер места: ~170 товаров/день → ~50–60 МБ архива в год на пункт.
- **1.6.2 (2026-10-25, ВЫЛОЖЕНО фоновым обновлением: latest.json `"auto": true`, без mandatory; sha256 8c7db1b6…):**
  - Прогресс загрузки: `relay.rs` пишет в статус `stage` (wait/history), `page`, `expected` (с фронта: history+rows из peers),
    накопленные `bytes`; окно подтверждения остаётся открытым с полосой (`RelayBar`) и кнопкой «Свернуть».
  - Свой пункт (на ПК есть своя база WB того же пункта): загрузка тянет и текущую базу. Что показывать — выбор в шапке
    (`PointSwitcher`: «этот компьютер · база WB» / «с «ПК» · копия»): `point_source[wb]` = `"local"` или id ПК.
    `points::uses_local_db()` (вместо `is_local_active` в active_db/with_db/require_local/refresh_loop; `isLocal` в list()),
    `ownActive`, `localAt` = mtime базы WB и `-wal`. Подбор кода/примерка — только с базой WB этого ПК.
    `StaleBar`: база WB не менялась >1 ч, а копия новее на >30 мин → «Показать с «ПК»» (скрытие — localStorage до новой копии).
  - Названия ПК везде по id из `account.me.devices` (`pcName(id, fallback)` в store), а не из памяти передатчика/source.json.
    `PcNameHost`: имя, заданное в аккаунте с другого ПК, запоминается локально (раньше ПК пункта при запуске переименовывал себя
    обратно в адрес), и проверка повторяется при смене имени.

## Код клиента на сервере + данные аккаунта (2026-10-26, выложено частично)
Генерация кода клиента перенесена на сервер (анти-реверс), в программе логики кода больше нет.
- Сервер: `server/_wb-code.js` (+`qrFromCode`), `server/_wb-crack.js` (резерв MD5, порт cracker::find_code_md5),
  `server/_app-flags.js` (флаг `app_crack_fallback`). Эндпоинты `/api/app/{client-qr,crack-code,wallet,orders,assets,referrals}`
  (`api/app.js`, маршруты в `vercel.json`); биллинг общий `account.billCode` (Bearer-квота/пакеты ИЛИ WBPK-ключ через
  `rpc/consume_license` — Базовый без входа не ломается). `accountSummary.flags.crackFallback` в `/me`.
  Админка: тумблер «Резервный подбор» (`api/admin/data.js` `appCrackFallback`, `src/api/admin.ts`, `AdminProgramPage.tsx`).
  Переиспользованы `api/cabinet.js` (getOrders/getAssets/getReferral — экспортированы) и `server/_wallet.js` (`walletSummary`).
  Тест `src/api/wb-code.test.ts`.
- Программа (`_local-only/pvz-tauri`): `cracker.rs`/`qr.rs` → `_archive-code-logic/` (вне сборки), убраны argon2/md-5/rayon.
  Команды `find_code/find_code_md5/cancel_search/qr_payload/fast_qr_payload` удалены; добавлены
  `client_qr/crack_code/account_{wallet,orders,assets,referrals}` (account.rs). Store: `clientQr/crackCode/crackFallback`.
  UI: одна кнопка «QR код клиента» (компонент `ClientCode` в CellDetail), «Быстрый QR» — только при флаге; убран SearchBanner.
  Новый раздел «Код клиента» (`screens/CodeClient.tsx`, nav `codeclient`) — поиск по ячейке/телефону из ЛОКАЛЬНОЙ базы.
  Профиль: блок «Покупки, баланс и ключи» (`AccountDataCard` в Account.tsx).
- **Офлайн:** код теперь требует связи (sdbm мгновенна). `PVZ_PREVIEW=1` без входа QR не выдаст (сервер требует аккаунт/ключ).
- **Статистика «Печати ячеек»** в «Помощнике» показывается как покупки/ключи/устройства; счётчик печати на сервере отсутствует
  (он локален в cell-print-tauri) — нужна отдельная выгрузка статистики на сервер (не сделано).

### ОСТАЛОСЬ для интеграции: онлайн-поиск в разделе «Код клиента» (НЕ сделано — нужен HAR)
Сейчас раздел ищет клиента только в ЛОКАЛЬНОЙ базе (api.cell / api.searchPhone). Онлайн-подгрузка (для ПК без базы,
как в боте) НЕ реализована. Это отдельный WB-API (десктоп ПВЗ, `s-point.wb.ru`), не тот, что отзывы/сотрудники:
1. `GET s-point.wb.ru/s{shard}/api/v2/pickpoint/{office}/switch` → desktop-токен; затем
   `GET /s{shard}/api/v5/pickpoint/goods/list?last_id=…&pickpoint_id={office}&x_pickpoint_id={external}` постранично (как
   бот: `server/_wb-pvz.js loadGoodsInPickPoint`, пагинация по `max_last_id`, до 20 страниц).
2. shard+office_id — бот берёт из списка пунктов; в программе в `my-orgs`/`point_orgs` их наличие НЕ подтверждено
   (возможно, нужен отдельный запрос списка пунктов). Без shard путь не работает.
3. Заголовки десктопа: `User-Agent: WBPoint Android`, `X-App-Type: staff`, `X-App-Version: v0.37.0`, свой X-Pow; общий
   `wb_online::request` жёстко шлёт `Origin/Referer: my-pvz.wb.ru` и свой UA — для десктопа переопределить.
Парсинг готов (бот: `buyer_sid`/`cell`/`buyer.mobile`, фильтр по ячейке или хвосту телефона ≥3 цифр).
План реализации: метод `WbClient::point_clients(point_id, digits)` в `wb_online.rs` (switch → goods/list → фильтр) + Tauri
`wb_point_clients(query)` + онлайн-режим в `CodeClient.tsx` (кнопка видна при `wb_status.loggedIn`).
**Нужен HAR живого десктопного `goods/list` (переключение ПВЗ + список), как `my-pvz.wb.ru6.har`** — по нему
зафиксировать shard, заголовки и формат. До этого онлайн-поиск не включать.

## Выпуск 2026-10-26: сервер `20261026-164454`, программа 1.6.6

- Замена копии с другого ПК теперь удаляет старую только после успешного результата всей загрузки; для выпуска всё ещё нужен живой тест на двух ПК с обрывом передачи.
- Платный QR использует сохранённый UUID операции и серверный `app_code_once`. Миграция `20261031_app_code_idempotency.sql` применена, затем выложен сервер и подписанная программа 1.6.6. Старые клиенты без UUID продолжают работать по прежнему маршруту.
- Защита от повторного списания относится **только к настольной программе**. В Telegram-боте два отдельных сообщения с одним SID — две отдельные генерации и два списания. Не переносить `requestId`/`app_code_once` в обработчик бота. Дедупликация повторной доставки одного Telegram `update_id` остаётся.
- Release-сборка больше не принимает `PVZ_PREVIEW=1`; если подписанные права недоступны, платные разделы не открываются. Автоматическая очистка старых программ и установщиков при запуске отключена.
- 1.6.6 опубликована как необязательное обновление (`auto:false`, минимальная версия остаётся 1.6.0). SHA-256 установщика: `90374a7c135b2359355430e1d2afab03756c497e38d1997a07cef79a950c0317`; бэкап манифеста на сервере: `latest.json.bak-1793022766`.
- После выпуска отдельно проверить реальные платежи, два ПК с обрывом передачи, WB/SMS, оборудование печати и онлайн-поиск по HAR.
