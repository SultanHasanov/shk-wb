#!/bin/sh
# «Помощник ПВЗ» для Linux — запуск одной командой, без установки:
#
#   curl -fsSL https://shk-wb.ru/dl/linux.sh | sh
#
# С ключами (например, свой путь к базе WB):
#   curl -fsSL https://shk-wb.ru/dl/linux.sh | sh -s -- --wb-db /путь/к/wb_point_db.sqlite
#
# Что делает этот скрипт (прочитайте перед запуском — он короткий):
#   1. узнаёт последнюю версию: https://shk-wb.ru/dl/pvz-helper-linux.json;
#   2. скачивает программу (один файл) в ~/.cache/pvz-helper/ — если этой версии там ещё нет;
#   3. сверяет контрольную сумму SHA-256 с той, что в pvz-helper-linux.json, — не сошлась, не запускает;
#   4. запускает её. Программа поднимает сервер только на 127.0.0.1 и открывает браузер.
#
# Данные пункта никуда не выгружаются: программа читает базу WB (wb_point_db.sqlite) на этом компьютере,
# только чтение. Ничего не ставится в систему, root не нужен, автозапуска нет.
#
# Закрыли вкладку браузера — через ~30 секунд программа завершается и САМА удаляет с компьютера себя и всё,
# что хранила (вход в аккаунт и WB, настройки, архив клиентов). Так же — по Ctrl+C. База WB и клиент WB
# не трогаются. Сохранять данные между запусками: ... | sh -s -- --keep
#
# Стереть оставшееся после запусков с --keep:
#   curl -fsSL https://shk-wb.ru/dl/linux.sh | sh -s -- --uninstall
# Место компьютера в аккаунте освобождается в кабинете на сайте.
set -eu

BASE="${PVZ_DL:-https://shk-wb.ru/dl}"
DIR="${XDG_CACHE_HOME:-$HOME/.cache}/pvz-helper"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/wb_pvz_tools"
IMAGES="${XDG_CACHE_HOME:-$HOME/.cache}/pvz_helper"

say() { printf '%s\n' "$*" >&2; }
die() { say "Ошибка: $*"; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  if pgrep -f "$DIR/pvz-helper-" >/dev/null 2>&1; then
    die "программа ещё запущена — закройте её (Ctrl+C в её терминале) и повторите"
  fi
  for d in "$DIR" "$IMAGES" "$DATA"; do
    if [ -e "$d" ]; then
      rm -rf "$d"
      say "Удалено: $d"
    fi
  done
  say "Помощник ПВЗ удалён с этого компьютера. База WB и клиент WB не тронуты."
  say "Освободить место компьютера в аккаунте: https://shk-wb.ru/cabinet/subscription"
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || die "этот скрипт — для Linux (для Windows есть установщик на https://shk-wb.ru/program)"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  *) die "пока есть сборка только для x86_64, а у вас $(uname -m)" ;;
esac

if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL --retry 2 "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -q -O "$2" "$1"; }
else
  die "нужен curl или wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "нужна программа sha256sum (пакет coreutils)"
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
TMP="$(mktemp "$DIR/.dl.XXXXXX")"
trap 'rm -f "$TMP" "$TMP.json"' EXIT INT TERM

say "Помощник ПВЗ: проверяю последнюю версию…"
get "$BASE/pvz-helper-linux.json" "$TMP.json" || die "не удалось связаться с shk-wb.ru — проверьте интернет"

field() { sed -n "s/.*\"$1\" *: *\"\\([^\"]*\\)\".*/\\1/p" "$TMP.json" | head -n1; }
VERSION="$(field version)"
FILE="$(field "file_$ARCH")"
SUM="$(field "sha256_$ARCH")"

# только ожидаемый вид: цифры с точками, имя файла без «/», sha256 — 64 hex
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "не понял номер версии в pvz-helper-linux.json"
printf '%s' "$FILE" | grep -Eq '^[A-Za-z0-9._-]+$' || die "не понял имя файла в pvz-helper-linux.json"
printf '%s' "$SUM" | grep -Eq '^[0-9a-f]{64}$' || die "не понял контрольную сумму в pvz-helper-linux.json"

BIN="$DIR/pvz-helper-$VERSION"
if [ -x "$BIN" ] && [ "$(sha "$BIN")" = "$SUM" ]; then
  say "Версия $VERSION уже скачана."
else
  say "Скачиваю версию $VERSION…"
  get "$BASE/$FILE" "$TMP" || die "не удалось скачать $BASE/$FILE"
  GOT="$(sha "$TMP")"
  [ "$GOT" = "$SUM" ] || die "контрольная сумма не совпала (ожидалась $SUM, получена $GOT) — файл не запущен"
  chmod 755 "$TMP"
  mv -f "$TMP" "$BIN"
fi

# старые версии больше не нужны
for old in "$DIR"/pvz-helper-*; do
  [ "$old" = "$BIN" ] || [ ! -f "$old" ] || rm -f "$old"
done

trap - EXIT INT TERM
rm -f "$TMP" "$TMP.json"
# stdin при «curl | sh» — это сам скрипт; программе он не нужен
exec "$BIN" "$@" </dev/null
