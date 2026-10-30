# «Печать ячеек» — ячейка на этикетку по скану

Две ветки: 2.x на Tauri (боевая) и 1.5.x на Tkinter (история, часть людей ещё на ней).
**Перед правкой сверить версию** — см. первый раздел ниже.
Историческая ветка 1.5.x — в конце файла.

## «Печать ячеек» 2.x — Tauri (выложена 2.1.2, 2026-10-30)
**СНАЧАЛА СВЕРИТЬ ВЕРСИЮ.** Исходники лежат в ДВУХ местах, и `_local-only` бывает устаревшей: ветка
`wip/cell-print-tauri` (путь в ней — `cell-print-tauri/`, вне `_local-only`, поэтому попадает в git) обычно свежее.
29.10.2026 правки сделали в копии 2.0.1 из `_local-only` и чуть не выложили её поверх живой 2.1.0 — пользователи
потеряли бы дату/время на этикетке и канал обновлений. Перед ЛЮБОЙ правкой:
```
grep '^version' _local-only/cell-print-tauri/src-tauri/Cargo.toml   # что у нас
curl -s https://shk-wb.ru/api/cell-print/feed                       # что у людей
```
Не сходится → взять свежее дерево: `git log --oneline --all -- "*cell-print-tauri*"`, затем
`git archive <коммит> cell-print-tauri | tar -x -C <папка>` и положить поверх `_local-only/cell-print-tauri`
(node_modules и target при этом сохраняются). ПОСЛЕ выпуска вернуть исходники в ветку — временным worktree,
не переключая main: `git worktree add <tmp> wip/cell-print-tauri` → скопировать туда дерево без
node_modules/target/dist → `git add -A cell-print-tauri` → commit → `git worktree remove <tmp>`.
Код 2.1.0 прогнан через rustfmt (ширина по умолчанию), 2.0.1 была в широком стиле — отсюда огромные диффы;
смысловые правки видно только после `rustfmt` обеих сторон и `diff --strip-trailing-cr`.

Исходники: `_local-only/cell-print-tauri/` (gitignored). Rust: `config.rs` (тот же `%APPDATA%\shk_tools\cell_print\settings.json`),
`license.rs` (тот же license.json, отпечаток MachineGuid, `/api/cell-print/activate`), `wbdb.rs` (порт wb_db_reader: ТОЛЬКО `immutable=1`,
повтор пары item_uid+cell, фильтр приёмки), `scan_hook.rs` (WH_KEYBOARD_LL), `label.rs` (fontdue + Arial Bold, 203 dpi, вертикально),
`winprint.rs` (GDI, DEVMODE на задание), `niimbot.rs` (btleplug; канал bef8d6c9 — ff02 НЕ отвечает; принтер держит любая другая
программа → Windows отдаёт AccessDenied/0 характеристик), `ozon.rs` (тот же exe = Native Messaging host `ru.shk.cell_print`, пересылка
в программу по `\.\pipe\shk_cell_print_ozon_v2`, регистрация HKCU Chrome/Яндекс/Edge при старте), `account.rs` (вход сайта, DPAPI
session.bin), `updates.rs` (с 2.1.0 — tauri-plugin-updater, см. «Канал обновлений» ниже; до 2.1.0 была лента `/api/cell-print/feed`). Сервер: `/api/cell-print/{login,login/start,
login/poll,refresh,keys,claim,logout}` в api/cell-print.js (без регистрации ПК в подписке Помощника).
Установщик: `installer-hooks.nsh` — PREINSTALL тихо удаляет 1.x (Inno `{61C7B30E-…}_is1`) ДО копирования файлов (её деинсталлятор
сносит ярлык и хост Ozon), POSTINSTALL — ярлык на рабочем столе. Ставится в `%LOCALAPPDATA%\Печать ячеек\cell-print-tauri.exe`.
Сборка (для отладки; для выпуска — ТОЛЬКО с подписью, п. 2 ниже): `cd _local-only/cell-print-tauri &&
CARGO_TARGET_DIR="$(pwd -W)/src-tauri/target" npx tauri build` → `src-tauri/target/release/bundle/nsis/Печать ячеек_X_x64-setup.exe`.
Версия — Cargo.toml + tauri.conf.json + package.json.

### Коды на этикетке WB (с 2.1.2)
Кроме большого QR в центре, по четырём углам этикетки напечатаны мелкие QR с тем же ШК в сжатом виде:
`*` + base64 от шести байт, где первые пять — ШК big-endian, шестой контрольный
(`*C4VGRcZY` → `0x0b854645c6` = 49480615366). Сканер-имиджер иногда ловит именно угловой.
WB такой код понимает сам, а в `goods_in_pick_point` НЕ сохраняет (`encoded_scanned_code` там пуст),
поэтому до 2.1.2 такой скан ложился как «Товар не найден в базе WB» и печать молча пропускалась.
`wbdb::normalize()` приводит код к обычному ШК в начале `on_scan`, до подсчёта повторов.
Контрольный байт не проверяем — по известным образцам полином однозначно не определить.

### Канал обновлений 2.1+ (подписанный, доделан 2026-10-29, коммит 2fa262f5)
Программа проверяет обновления через `tauri-plugin-updater`: `GET /api/cell-print/update` (`server/_cell-print-update.js`,
маршруты `/api/cell-print/update` и `/update/download` в `vercel.json`, проброс в `api/cell-print.js`). Манифест —
`/srv/shk-wb/app-updates/cell-print/latest.json` (`version/notes/pub_date/file/signature/mandatory/auto`), файл отдаётся
через `/api/cell-print/update/download`. **Подпись обязательна** — программа проверяет её сама (`update.verify`), ключ
ОБЩИЙ с «Помощником»: своей папки `keys/` у cell-print нет, берём `_local-only/pvz-tauri/keys/updater.key`.
ГРАБЛИ 27.10.2026: программу 2.1.0 выложили, а серверную половину оставили в ветке и не задеплоили — эндпоинт отдавал 404,
автообновление не работало НИ У КОГО на 2.1.0. Выпуск 2.x считается законченным только после деплоя сайта.

Порядок полного выпуска 2.x:
1. версия в `src-tauri/Cargo.toml` + `tauri.conf.json` + `package.json`; `cargo test --lib`, `npm run build`;
2. сборка с подписью: `TAURI_SIGNING_PRIVATE_KEY="$(cat ../pvz-tauri/keys/updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" CARGO_TARGET_DIR="$(pwd -W)/src-tauri/target" npx tauri build` (без ключа bundler ругнётся «no private key», но exe соберётся — такой выкладывать НЕЛЬЗЯ, апдейтер его отвергнет);
3. `scp` установщика и `.sig` в `/srv/shk-wb/app-updates/cell-print/`, копия `cell-print-X-setup.exe` в `app-updates/pvz-helper/public/` (= `/dl/`), `chown shkwb:shkwb`, сверить sha256;
4. переписать `latest.json` (бэкап `latest.json.bak-$(date +%s)` рядом, проверить `json.load`);
5. если менялся серверный код — деплой: `SSH_OPTS="-i ~/.ssh/shk-wb_ed25519" bash selfhost/deploy.sh root@212.193.59.72`;
6. PATCH `cell_print_releases` (кнопка «Скачать» на сайте и плашка у старых 1.5.x/2.0.x — они апдейтер не используют);
7. проверка: `/api/cell-print/update?current=<прошлая>` → JSON с подписью, `?current=<новая>` → 204, `/dl/cell-print-X-setup.exe` → 200 с тем же sha256.
Откат: вернуть `latest.json.bak-*` и прошлые `version`/`download_url` в ленте (старые setup.exe не удалять).

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
