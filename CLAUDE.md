# «Помощник ПВЗ» — где что и что осталось (для нового чата)

Этот репозиторий — сайт **shk-wb.ru** (React + API на Vercel/selfhost). Рядом идёт разработка
десктоп-программы для пунктов выдачи WB. Ниже — состояние работы, чтобы продолжить с нуля.

## Две программы

1. **«Подбор кодов» 1.3.x** — текущая боевая программа (Tkinter). Выложена, работает у людей.
   - Исходники: `_local-only/program-sources/scripts/crack_cell.py` (ядро: подбор кода, лицензия,
     заголовок `X-App-Version`) + `crack_cell_gui.py` (старое окно Tkinter, класс `WbReviewsClient`
     для входа в WB и отзывов — ПЕРЕИСПОЛЬЗУЕТСЯ новой программой).
   - Релиз 1.3.15 уже выложен: без пробного периода, обязательное обновление, итерации за поиск
     по SID/телефону/отзывам. `downloads/version.json` (mandatory), `api/license.js`, `api/trial.js`,
     `server/_program-version.js` (`PROGRAM_MIN_VERSION`). На сервере в `/srv/shk-wb/.env`
     стоит `PROGRAM_MIN_VERSION=1.3.15`.

2. **«Помощник ПВЗ» 1.4.0** — НОВАЯ программа (CustomTkinter), её и развиваем.
   - Исходники там же, `_local-only/program-sources/scripts/` (ВСЁ это gitignored, в репо не попадает):
     - `pvz_app.py` — окно, все экраны, навигация, тариф, лицензия, обновление.
     - `pvz_data.py` — чтение локальной базы WB (ячейки, товары, «в пути», досье, дорогие товары,
       дни выдач). Фото клиентов/товаров маскируем телефоны (имён клиентов в базе WB НЕТ).
     - `pvz_images.py` — фото товаров по `vendor_code` с CDN WB. **httpx HTTP/2** (urllib/HTTP1.1
       виснет на части узлов → везде ставить `Connection: close`).
     - `pvz_wb.py` — `WbPvzClient`: сотрудники/ФИО/оборот из ОНЛАЙН-API WB поверх `WbReviewsClient`.
     - `pvz_stickers.py` — стикеры товаров/коробок через API сайта (`/api/stickers/*`), печать win32print/PDF.
     - `pvz_config.py` — `%APPDATA%/wb_pvz_tools/config.json`: диапазон дорогих, Telegram, ставки/смены,
       кэш сотрудников (`staff_cache`).
     - `pvz_telegram.py` — свой бот по токену (getMe/getUpdates/sendMessage).
     - `pvz_sync.py` — задел под сервер (ENABLED=False).
   - Макет-прототип (эталон дизайна): артефакт Claude Design `7cn1Zox5BMmD6nuuNS486P`
     (экраны Main/Cell/Client/Stickers/Plans/Locked/LockedPro/Searching/Activate/Update).
   - Стиль из `src/styles/tokens.css` сайта: фон #f5f5f7, карточки #fff, акцент WB #cb11ab, шрифт Inter.
     Без градиентов/теней/«ИИ»-приёмов.

## Как собрать и запустить новую программу
```
cd _local-only/program-sources/scripts
py -3.13 -m PyInstaller --noconfirm "Помощник ПВЗ.spec"     # exe → dist/Помощник ПВЗ/
"/c/Users/HONOR/AppData/Local/Programs/Inno Setup 6/ISCC.exe" "Помощник ПВЗ.iss"  # установщик → dist-installer/
```
Установить тихо: `setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER`
→ ставится в `%LOCALAPPDATA%/Programs/Помощник ПВЗ/`. У установщика ОТДЕЛЬНЫЙ AppId
(ставится рядом с «Подбор кодов», не заменяет его — это preview).
Запуск из исходников для отладки: `PYTHONPATH=. py -3.13 pvz_app.py` (или свой раннер, форсящий `app.plan="pro"`).
Нужны пакеты (Python 3.13): customtkinter==5.2.2, pillow, qrcode, httpx[http2], pywin32, pyinstaller.

## Тарифы и флаги
- Тарифы: **Базовый** (подбор кода) → **Стандарт** (+ячейки/товары/в пути/поиск/отзывы/дорогие)
  → **Про** (+досье клиента, стикеры, сотрудники). `FEATURE_PLAN` в `pvz_app.py`.
  Недоступное показывается размытым (`LockedBlock`) с подсказкой перейти на тариф.
- `PREVIEW_BUILD=True` в `pvz_app.py` → тариф Про без сервера (для показа). В релизе = False,
  тариф придёт в записи ключа (`record['plan']`).

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

## Что СДЕЛАНО (в программе, локально)
Отзывы WB инлайн; раздел «Дорогие товары» (диапазон в профиле); фильтр и бейджи «сотрудник»
в ячейках; раздел «Сотрудники» (список из WB, ставка за смену, зарплата = смены×ставка, календарь
смен; дни-подсказки из `delivered_goods`); профиль (дорогие/Telegram/синхронизация-заглушка);
Telegram свой бот; кэш ростера; фото товаров; досье клиента; стикеры. Собрано и установлено.

## Сессия 2026-10-16 — что доделано (детали для нового чата)

Всё ниже — в gitignored исходниках `_local-only/program-sources/scripts/`. exe/installer 1.4.0
собирались в начале сессии; **часть UI-правок ниже в собранный установщик ещё НЕ вошла** — перед
раздачей пересобрать (см. «Что ОСТАЛОСЬ» п.5). Во время работы запускалось из исходников
(`PYTHONPATH=. py -3.13 pvz_app.py`, `PREVIEW_BUILD=True` → тариф Про).

**1. Досье: отказы и возвраты.** Вся история клиента не только в `goods_in_pick_point`, но и в
`goods_on_way` (там тоже есть `buyer_sid`). Признаки: `status='GOODS_DECLINED'` = отказ (не забрал);
`item_purpose='return_to_seller'` = возврат (забрал и вернул). `pvz_data.dossier()` собирает из ОБЕИХ
таблиц с дедупом по `item_uid` (запись из пункта приоритетнее — у неё есть ячейка), окно `WAY_DAYS=30`,
различает «Отказ» vs «Возврат». Починен старый баг «отказы 0» (читался только goods_in_pick_point).
Новые поля: returned/returned_sum/return_pct, declined_sum, declined_cats, returned_cats, refused.
Константы `RETURNED`, `RETURN_PURPOSE`. UI: боковой блок «Отказы и возвраты» + события в ленте;
события «Отказ»/«Возврат» группируются по ДНЮ (не по минуте, без дробления по ячейке) → серии
схлопываются в 1 строку с ×N.

**2. Производительность (подвисания).** Замер на машине: БД читается ~45 мс (НЕ тормоз), тормозит
создание виджетов CustomTkinter (~19 мс/карточка → 24 шт ≈ 0.5 с). Сделано в `pvz_app.py`:
  - хелперы `chunked()`/`cancel_chunk()`/`loader_panel()`; в базовом `Screen` — `debounce()`,
    `chunk_render()`, `maybe_refresh()`, `_hide_loader()`, `_cancel_build()`.
  - **Персистентные экраны**: `App.show()` кэширует экраны-синглтоны в `self._screens`
    (`SINGLETON_TABS`), переключает через pack_forget/pack (не destroy+create) → переключение
    мгновенное. Параметрические (cell/dossier/plans) строятся заново и уничтожаются.
    **ГОТЧА:** при смене тарифа вызывать `App.reset_screens()` (чистит кэш и пересобирает текущий) —
    иначе «Ячейки» застревают в тарифе, в котором построились на старте до `_check_license` (100 мс).
  - **Данные в памяти + таймер**: `App.get_overview(force)` (TTL=OV_TTL) + фоновый `_refresh_tick`
    каждые `App.refresh_seconds` (из config `general.refresh_minutes`, по умолч. 10, floor 30 с).
    Настройка — Профиль → «Обновление данных». `invalidate_overview()` при смене staff_map.
  - **Лоадер (double-buffer)**: в CellsScreen/WayScreen сетка снимается с показа, сверху
    анимированная полоса (`loader_panel`), карточки строятся скрыто порциями, затем сетка
    показывается разом (без «наезжающих» карточек). Защита от гонок — `_cancel_build` + `_build_after`.
  - дебаунс поиска по ячейкам 250 мс; стартовая порция PAGE: cells 24, way 30; размер чанка 4/6.

**3. Карточка ячейки и досье — обрезание/читабельность.** Правая колонка `CellScreen.right` и
правый столбец `DossierView.side` — `CTkScrollableFrame`. Блок «Едут этому клиенту» в `_goods` —
сетка с переносом (3 колонки), показываются ВСЕ товары (раньше одна строка вбок → обрезалось).
У клиента в ячейке имени нет (в базе WB имён нет) → различаем по маск. телефону / SID.

**4. Глобальный поиск кода + стоп + кэш до 00:00.**
  - Поиск вынесен в `App.find_code(client, on_update)` (было в `CellScreen._find`). Прогресс/результат —
    плашка `App._render_banner` / `_update_search_banner` НАД `self.body` (pack `before=self.body`),
    поэтому поиск виден после ухода с карточки. ВАЖНО: имя `_update_banner(info,required)` уже занято
    баннером обновления версии — поисковый назван `_update_search_banner`.
  - **Остановка**: в `crack_cell.py` во все функции перебора проброшен `cancel` (threading.Event):
    `run→process_sid→codes_for_sid_on_date→crack_argon2_numeric_code→crack_argon2` (воркер проверяет
    `stop.is_set() or cancel.is_set()`). `App.cancel_search()` его выставляет; при отмене лимит НЕ
    списывается и код не запоминается, плашка «Поиск остановлен». Кнопка «Остановить» — в плашке и в карточке.
  - **Кэш кода до 00:00**: `App.found_codes` {sid→{code,date}}, `code_for(sid)`/`remember_code(sid,code)`,
    персист в config (`found_codes`), на старте фильтр по `core.today_str()`. `CellScreen._render_code(sid)`
    рисует по состоянию: идёт поиск / код на сегодня (Скопировать/QR/Искать заново) / «Найти код».
    Коды WB меняются ежедневно — отсюда привязка к дате.

**5. Сотрудники вручную + копирование SID (вторая половина 2026-10-16).**
  - Сотрудники теперь — ручной список `config.staff_list` [{id,name,last4,sid,phone}] (`pvz_config.add_staff/
    update_staff/remove_staff/get_staff`). SID ищется по 4 цифрам `core.sids_for_phone_suffix`; несколько совпадений →
    `StaffPickDialog`; нет → сохраняется без SID, повтор при reload/«Найти SID». Онлайн-WB — только кнопка «Добавить из WB»
    (и разовая миграция из `staff_cache`, если список пуст). Ставки/смены по-прежнему `config.staff[sid]`.
  - `App.rebuild_staff_map()` = кэш WB + ручной список (ручной приоритетнее); вызывать ВМЕСТО присваивания
    `staff_map` (в т.ч. при выходе из WB). Он же помечает экран «Ячейки» устаревшим.
  - `StaffCardScreen` (`App.open_staff(id)`, параметрический) — шапка сотрудника + `DossierView`.
  - Хелперы `copy_icon(master, app, text)` и `bind_tree(widget, cb)` (клик по всем потомкам, кроме кнопок/полей).
  - «В пути»: столбец SID + ⧉, телефон + ⧉ (`raw_phone` в `way_overview`), кликабельна вся строка.
  - «Ячейки»: сортировка по возрастанию номера (`pvz_data.overview`), debounce поиска 300 мс, ⧉ у SID на карточке.

**6. Зависания больших списков (вторая половина 2026-10-16).** Причина — НЕ база (чтение ~45 мс,
read-only) и НЕ язык, а тысячи тяжёлых CTk-виджетов: временная правка «догружать весь список в фоне»
создавала ~165 карточек + ~273 строки сразу → упор в лимит GUI-хэндлов Windows → креш
`Failed to create the menu window`.
  - **Вернулись к постраничной подгрузке по кнопке «Показать ещё»** (`CellsScreen`/`WayScreen`: `self.shown`,
    `render()` строит `items[:shown]`, `_more()` += PAGE). Карточки — CTk (как было); пробная замена на
    лёгкие tkinter-виджеты (`tkframe/tklabel/copy_label`) и ленивый рендер по скроллу пользователю не
    понравились (мелкие карточки) и ОТКАЧЕНЫ. PAGE: cells 24, way 30.
  - Копию базы НЕ делаем.
  - Если тормоза останутся актуальны на большом ПВЗ — следующий шаг настоящая виртуализация
    (переиспользование строк при прокрутке), но с сохранением текущего вида карточек CTk.

**7. «Ячейки» на одном холсте (2026-10-17).** Карточки в `CTkScrollableFrame` «размазывались» при
прокрутке (~20 окон Windows на карточку). Теперь `CardGrid` (`pvz_app.py`) — один `tk.Canvas`:
карточка = фигуры с тегом `card{i}`, фон — сглаженная PIL-картинка `rounded_photo()` (кэш), шрифты
`canvas_font()` (размер × масштаб CTk), `fit_text()` обрезает с «…». Рисуются только ряды у видимой
области, «Показать ещё» и лоадер на «Ячейках» убраны. Клик/наведение — по координатам (`_hit`),
горячие зоны (⧉ у SID) возвращает `draw`. Пользователь проверил — не размазывает, вид устроил.
Затем так же переведены «Дорогие» (секции с заголовками, 4 колонки товаров с фото / 2 колонки
клиентов — старая CTk-версия клиентов наезжала: `column=i % 2` при columnspan=2) и «В пути»
(строки таблицы, шапка — отдельный холст, «Что едет» тянется по ширине). `CardGrid` умеет секции
(`set_sections`), фото (`good_photo`, грузит в фоне и перерисовывает ждущие карточки),
«✓» после копирования (`flash_copied`). Также: список принтеров на «Стикерах» грузится в фоне
(`_load_printers`) — `EnumPrinters` вешал окно на недоступном сетевом принтере.

**8. Проверка ключа через httpx (2026-10-17).** `urllib` к shk-wb.ru ~в каждом 4-м запросе висел
15 с до таймаута → ключ «не проверен», программа оставалась на тарифе Базовый. `crack_cell._api_call`
теперь через общий `httpx.Client(http2=True)` (`crack_cell._http`; без httpx — fallback на urllib для
старого «Подбор кодов»), так же `App._check_update`. Замер: 15/15 по 0.2–0.9 с.

**9. Тарифы, вход по аккаунту сайта, профиль (2026-10-17, код написан, НЕ задеплоен).**
  - Тарифы — `server/_app-plans.js` (единственное место с ценами): Базовый 190 ₽ / 15 подборов / 1 ПК,
    Стандарт 390 / 30 / 1 ПК, Про 790 / 100 подборов + 300 стикеров / 2 ПК; сроки 1/3/6/12, скидки 0/10/15/25%.
    Лимиты месячные (окно от даты старта). Сверх лимита — «пакеты подборов» = `license_keys` владельца (старые WBPK).
    Без подписки, но с пакетами — работает только подбор кода. Поиск по SID/телефону подборы больше НЕ списывает.
  - БД — `supabase/migrations/20261018_app_subscriptions.sql`: `app_subscriptions` (отрезки времени со снимком
    лимитов; продление/повышение с пересчётом дней по цене/понижение в очередь), `app_devices`, `app_usage`,
    `app_login_requests`; функции `app_entitlements`, `app_consume`, `app_register_device`,
    `app_sticker_quota_code` (квота стикеров Про = код генераций владельца на месяц), `complete_app_subscription_order`.
    Проверено на PGlite (квота→пакеты→LIMIT_EXCEEDED, лимит ПК, продление/повышение/понижение, окно месяца).
  - API — `api/app.js` (бывший `api/trial.js`, `/api/trial` → rewrite) + `server/_app-account.js`:
    `/api/app/{plans,login,refresh,login/start,login/poll,login/request,login/approve,register-device,me,consume,
    usage,claim-key,site-link,logout,devices/:id}`. Программа шлёт `X-Device-Id` = sha256(MachineGuid).
    Оплата: `productKind:'app_subscription'` (+`appPlan`,`appTermMonths`) в `api/payments.js`. Крон кабинета
    напоминает за 3 дня до конца подписки. Стикеры: вошедший без кода печатает по квоте Про, потом своими пакетами.
    Тесты: `src/api/app-account.test.ts`.
  - Сайт: `/cabinet/subscription` (`SubscriptionPage.tsx`, тарифы/лимиты/ПК/оплата), `/app-login`
    (подтверждение входа из программы `?code=` и вход по ссылке из программы `?th=`). Пункт меню скрыт флагом
    `src/lib/app-release.ts` `APP_SUBSCRIPTIONS_LIVE=false` — включить в день релиза.
  - Программа: `pvz_account.py` (сессия DPAPI в `session.bin`, кэш `account.json`, офлайн 24 ч), `LoginScreen`,
    `DeviceLimitDialog`, профиль с вкладками «Аккаунт | Настройки», `PlansScreen` с сервера, шапка «Про · до 07.11 ·
    13 из 100 +7». Ключ WBPK с этого ПК после входа сам привязывается к аккаунту. `PREVIEW_BUILD` теперь только
    через `PVZ_PREVIEW=1` (Про без входа); `PVZ_SITE=http://…` — другой сервер для проверки.

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

## Что ОСТАЛОСЬ (следующие этапы)
1. **Запуск тарифов в бою:**
   - применить миграции `20261018_app_subscriptions.sql` и `20261019_app_admin_grant.sql` в Supabase; задеплоить сайт (vercel.json, api/app.js).
   - живой тест: вход паролем и через сайт/Telegram, оплата подписки в тестовом режиме ЮKassa, списание, отключение ПК.
   - в день релиза 1.4.0: `APP_SUBSCRIPTIONS_LIVE=true`, таблица тарифов на `ProgramPage` (данные — `useAppPlans()`
     из `src/api/app.ts`), «Ключи WBPK» в кабинете назвать «Пакеты подборов».
   - эндпоинты `api/pvz/{config,staff,salary}` под `pvz_sync.py` (сейчас ENABLED=False) — авторизация Bearer.
2. **Переименование на сайте** «Подбор кодов» → «Помощник ПВЗ» (~25 файлов: `src/pages/ProgramPage.tsx`,
   `src/layout/PublicShell.tsx`, `build-seo.mjs`, `program.html`, юр. страницы). Делать В ДЕНЬ релиза 1.4.0.
3. **Релизный установщик 1.4.0**: решить AppId (для замены «Подбор кодов» — НЕ менять его AppId;
   сейчас у «Помощника» отдельный preview-AppId), папку данных ключа `wb_pvz_tools` НЕ переименовывать.
4. Живой тест зарплаты за полный месяц; возможно per-employee статистика через `employee-stat-v2`.
5. **Пересобрать установщик 1.4.0** со всеми правками сессии 2026-10-16 (последняя сборка в начале
   дня — часть UI-правок: лоадеры, скролл карточки/досье, сетка «Едут», глобальная плашка поиска,
   стоп, кэш кода — в неё НЕ вошла). Команды — раздел «Как собрать».
6. (Опц.) Если первый заход на вкладку всё ещё медленный — облегчить карточки ячеек: заменить тяжёлые
   CTk-виджеты внутри `_card` на `tkinter.*` (создаются в ~3–4× быстрее). Кэш экранов уже делает так,
   что стоимость платится один раз за сессию на вкладку.
7. (Опц.) Кнопка «Открыть ячейку» в плашке найденного кода (сейчас только Скопировать/Скрыть) —
   в `App.search` для этого нужно сохранять и номер ячейки.
8. Живой тест на РЕАЛЬНОМ поиске: отмена поиска (кнопка «Остановить»), что лимит при отмене не
   списывается, и что найденный код переживает переключение вкладок и перезапуск в тот же день.

Подробнее — память проекта `pvz-helper-app` (в `~/.claude/projects/.../memory/`).
Глобальный `~/.claude/CLAUDE.md` содержит шаблон генерации сайтов-витрин и RTK — к этой задаче
не относится.

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

## «Печать ячеек» (Tkinter 1.5.x) — как выпустить обновление (с 1.5.10, как у Помощника)
Исходники: `_local-only/program-sources/scripts/cell_print_app.py` (+ `niimbot_printer.py`, `scan_hook.py`, `wb_db_reader.py`,
`ozon_native.py`). Сайт НЕ пересобирать: установщик лежит на сервере вне сайта, ссылку даёт строка Supabase.
1. Версия: `APP_VERSION` в `cell_print_app.py` и `MyAppVersion` + `dist-X` в `cell-print-installer.iss`.
2. Сборка (ТОЛЬКО `py -3.8` — на 3.13 тянется numpy, установщик 26 МБ вместо 17):
   `py -3.8 -m PyInstaller --noconfirm --distpath dist-X --workpath build-cell-X "Печать ячеек.spec"` →
   `ISCC.exe cell-print-installer.iss` → `dist-installer/Печать ячеек setup X.exe`.
3. Выкладка: файл как `cell-print-X-setup.exe` → `scp` в `/srv/shk-wb/app-updates/cell-print/` и `cp` на сервере в
   `/srv/shk-wb/app-updates/pvz-helper/public/` (это и есть https://shk-wb.ru/dl/, nginx alias), `chown shkwb:shkwb`,
   сверить sha256 локально / на сервере / `curl https://shk-wb.ru/dl/cell-print-X-setup.exe | sha256sum`.
4. Плашка у пользователей: PATCH `cell_print_releases?id=eq.true` (с сервера: `. /srv/shk-wb/.env`, SUPABASE_URL +
   SUPABASE_SECRET_KEY) — `version`, `notes`, `download_url=https://shk-wb.ru/dl/cell-print-X-setup.exe`,
   `mandatory` (true = обязательное) или `minimum_version`, `updated_at`. Программа читает `/api/cell-print/feed`
   при запуске и раз в 6 ч; «Скачать» на сайте (`/api/payments/download-cell-print`) переадресует на тот же download_url.
5. Откат: вернуть прошлые version/download_url в `cell_print_releases` (старые setup.exe на сервере не удалять).
Продление ключа: кнопка «Продлить» в программе → `https://shk-wb.ru/cabinet/keys?renew=<ключ>` (KeysPage сам
привяжет ключ без владельца к аккаунту и откроет оплату продления того же ключа, дни добавляются к сроку).

## «Печать ячеек» 2.x — Tauri (выложена 2.0.0, 2026-10-19)
Исходники: `_local-only/cell-print-tauri/` (gitignored). Rust: `config.rs` (тот же `%APPDATA%\shk_tools\cell_print\settings.json`),
`license.rs` (тот же license.json, отпечаток MachineGuid, `/api/cell-print/activate`), `wbdb.rs` (порт wb_db_reader: ТОЛЬКО `immutable=1`,
повтор пары item_uid+cell, фильтр приёмки), `scan_hook.rs` (WH_KEYBOARD_LL), `label.rs` (fontdue + Arial Bold, 203 dpi, вертикально),
`winprint.rs` (GDI, DEVMODE на задание), `niimbot.rs` (btleplug; канал bef8d6c9 — ff02 НЕ отвечает; принтер держит любая другая
программа → Windows отдаёт AccessDenied/0 характеристик), `ozon.rs` (тот же exe = Native Messaging host `ru.shk.cell_print`, пересылка
в программу по `\.\pipe\shk_cell_print_ozon_v2`, регистрация HKCU Chrome/Яндекс/Edge при старте), `account.rs` (вход сайта, DPAPI
session.bin), `updates.rs` (лента `/api/cell-print/feed`, скачивание и запуск setup). Сервер: `/api/cell-print/{login,login/start,
login/poll,refresh,keys,claim,logout}` в api/cell-print.js (без регистрации ПК в подписке Помощника).
Установщик: `installer-hooks.nsh` — PREINSTALL тихо удаляет 1.x (Inno `{61C7B30E-…}_is1`) ДО копирования файлов (её деинсталлятор
сносит ярлык и хост Ozon), POSTINSTALL — ярлык на рабочем столе. Ставится в `%LOCALAPPDATA%\Печать ячеек\cell-print-tauri.exe`.
Сборка: `cd _local-only/cell-print-tauri && CARGO_TARGET_DIR="$(pwd -W)/src-tauri/target" npx tauri build`
→ `src-tauri/target/release/bundle/nsis/Печать ячеек_X_x64-setup.exe`. Версия — Cargo.toml + tauri.conf.json + package.json.
Выкладка — как 1.5.x выше (файл `cell-print-X-setup.exe` в `/dl`, PATCH `cell_print_releases`). Подписи обновлений пока НЕТ
(скачивание по https с shk-wb.ru), установщик при обновлении показывает обычный мастер NSIS.

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
