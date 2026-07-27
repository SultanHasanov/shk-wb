"""
Подбор кодов по номеру ячейки — графический интерфейс.

Тот же функционал, что и в crack_cell.py, но с окном вместо консоли.
Вся логика (лицензирование, работа с БД, подбор кодов, QR) переиспользуется
из crack_cell.py — здесь только UI.
"""

import json
import hashlib
import http.cookiejar
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import List, Optional

import crack_cell as core

APP_TITLE = "Подбор кодов"
APP_VERSION = "1.2.7"
TELEGRAM_URL = "https://t.me/roma_denosov"
SITE_URL = "https://shk-wb.vercel.app/"
VERSION_URL = "https://shk-wb.vercel.app/downloads/version.json"
# Объявления, публикуемые из админки сайта (mokky mock REST API).
MESSAGE_API = "https://shk-wb.vercel.app/api/messages"
# win7-сборка собирается под Python 3.8, обычная — под 3.13.
# Так один и тот же код скачивает правильный exe для своей сборки.
IS_WIN7_BUILD = "windows 7" in Path(sys.executable).stem.lower()

# заголовок, ширина в пикселях, вес растяжения
COLUMNS = [
    ("Дата", 95, 0),
    ("Статус", 120, 0),
    ("Имя", 130, 1),
    ("Телефон", 120, 0),
    ("SID", 100, 0),
    ("Код", 85, 0),
    ("", 150, 0),
]

KIND_LABELS = {
    "no-hash": "код не в базе",
    "not-found": "код не найден",
    "no-data": "нет записей на дату",
    "unavailable": "хеши удалены",
    "stale": "устаревший код",
}

# Шаги встроенного мини-курса: (заголовок, текст, имя атрибута виджета для
# подсветки | None — только текст).
TOUR_STEPS = [
    (
        "1. Ключ доступа",
        "Вставьте купленный ключ в поле «Ключ доступа» и нажмите «Активировать».\n"
        "Первый подбор кода — бесплатный (пробный). Дальше нужен ключ.\n"
        "Купить ключ: @roma_denosov.",
        "key_entry",
    ),
    (
        "2. Номер ячейки",
        "Введите номер ячейки, в которой лежит заказ клиента.",
        "cell_entry",
    ),
    (
        "3. Поиск",
        "Нажмите «Найти» — программа найдёт клиентов этой ячейки и подберёт коды.",
        "search_btn",
    ),
    (
        "4. Результаты",
        "Появится таблица: Дата, Имя, Телефон, SID и Код.\n"
        "Столбец «Код» — это и есть код получения заказа.",
        "table_frame",
    ),
    (
        "5. QR-код",
        "В каждой строке есть кнопка «QR». Она откроет окно с QR-кодом прямо в\n"
        "программе и кнопкой «Скачать», чтобы сохранить картинку.",
        None,
    ),
    (
        "6. Товары клиента",
        "Кнопка «Товары» в строке показывает список товаров этого клиента.",
        None,
    ),
    (
        "7. Обновления и объявления",
        "Иногда вверху окна появляется баннер: жёлтый — «Обновить программу»\n"
        "(обновление в один клик), голубой — объявления. Читайте их время от времени.",
        None,
    ),
]


class WbApiError(Exception):
    def __init__(self, message, status=None, pow_header=None):
        super().__init__(message)
        self.status = status
        self.pow_header = pow_header


class WbReviewsClient:
    AUTH_ORIGIN = "https://auth-my-pvz.wb.ru"
    ORGS_ORIGIN = "https://r-point.wb.ru"
    RATING_ORIGIN = "https://point-rating.wb.ru"
    SESSION_DIR = Path(
        os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming"
    ) / "wb_pvz_tools"
    SESSION_PATH = SESSION_DIR / "wb_session.json"
    COOKIE_PATH = SESSION_DIR / "wb_cookies.txt"

    def __init__(self):
        self.cookies = http.cookiejar.LWPCookieJar(str(self.COOKIE_PATH))
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.device_id = str(uuid.uuid4())
        self.sticker = None
        self.token = None
        self.organizations = []
        self.point_organizations = {}
        self.active_organization_id = None
        self.phone = ""
        self._load_session()

    def _load_session(self):
        try:
            if self.COOKIE_PATH.exists():
                self.cookies.load(ignore_discard=True, ignore_expires=True)
        except Exception:
            self.cookies.clear()
        try:
            with self.SESSION_PATH.open("r", encoding="utf-8") as session_file:
                data = json.load(session_file)
            self.token = data.get("token") or None
            self.device_id = data.get("device_id") or self.device_id
            self.phone = data.get("phone") or ""
            self.active_organization_id = data.get("active_organization_id")
        except Exception:
            pass

    def _save_session(self):
        self.SESSION_DIR.mkdir(parents=True, exist_ok=True)
        data = {
            "token": self.token,
            "device_id": self.device_id,
            "phone": self.phone,
            "active_organization_id": self.active_organization_id,
        }
        with self.SESSION_PATH.open("w", encoding="utf-8") as session_file:
            json.dump(data, session_file)
        self.cookies.save(ignore_discard=True, ignore_expires=True)

    def clear_session(self):
        self.token = None
        self.sticker = None
        self.phone = ""
        self.organizations = []
        self.point_organizations = {}
        self.active_organization_id = None
        self.cookies.clear()
        for path in (self.SESSION_PATH, self.COOKIE_PATH):
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _decode_json(raw):
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    @staticmethod
    def _message(data, fallback):
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            for key in ("message", "error"):
                if isinstance(data.get(key), str):
                    return data[key]
        return fallback

    def _request(self, url, method="GET", body=None, headers=None):
        request_headers = {
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://my-pvz.wb.ru",
            "Referer": "https://my-pvz.wb.ru/",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/150.0.0.0 Safari/537.36"
            ),
            "X-Language": "ru",
        }
        request_headers.update(headers or {})
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            request_headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            url, data=payload, headers=request_headers, method=method
        )
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read()
                data = self._decode_json(raw)
                if data is None:
                    raise WbApiError("WB вернул ответ не в формате JSON")
                return data, response.headers.get("X-Pow")
        except urllib.error.HTTPError as error:
            raw = error.read()
            data = self._decode_json(raw)
            raise WbApiError(
                self._message(data, "Ошибка WB HTTP {}".format(error.code)),
                status=error.code,
                pow_header=error.headers.get("X-Pow"),
            )
        except urllib.error.URLError as error:
            raise WbApiError("Нет соединения с WB: {}".format(error.reason))

    @staticmethod
    def _extract_challenge(pow_header):
        if not pow_header:
            return None
        match = re.search(r"challenge=([^;]+)", pow_header)
        return match.group(1) if match else None

    @staticmethod
    def _solve_pow(challenge):
        parts = challenge.split(",")
        if len(parts) < 9:
            raise WbApiError("WB вернул некорректный X-Pow challenge")
        difficulty = int(parts[1])
        salt = parts[3]
        full_nibbles = difficulty // 4
        remaining_bits = difficulty % 4
        nonce = 0
        max_attempts = 2 ** (difficulty + 6)

        while nonce < max_attempts:
            digest = hashlib.sha256(
                (salt + str(nonce)).encode("utf-8")
            ).hexdigest()
            full_zeroes = digest.startswith("0" * full_nibbles)
            next_nibble = int(digest[full_nibbles] or "0", 16)
            remaining_zeroes = (
                remaining_bits == 0
                or next_nibble < 2 ** (4 - remaining_bits)
            )
            if full_zeroes and remaining_zeroes:
                return nonce
            nonce += 1
        raise WbApiError("Не удалось решить X-Pow challenge")

    def _auth_headers(self, pow_challenge=None):
        headers = {
            "Deviceid": self.device_id,
            "Wb-Appversion": "v0.0.55",
        }
        if pow_challenge:
            nonce = self._solve_pow(pow_challenge)
            headers["X-Pow"] = "status=valid; nonce={}; challenge={}".format(
                nonce, pow_challenge
            )
        return headers

    def request_code(self, phone):
        digits = str(phone).strip()
        if not re.fullmatch(r"7\d{10}", digits):
            raise WbApiError(
                "Введите номер строго в формате 7XXXXXXXXXX (11 цифр)"
            )
        self.phone = digits

        data, _ = self._request(
            self.AUTH_ORIGIN + "/v2/code/wb-captcha",
            method="POST",
            headers=self._auth_headers(),
            body={
                "captcha_token": "",
                "phone_number": digits,
                "save_push": True,
            },
        )
        payload = data.get("payload") or {}
        self.sticker = payload.get("sticker")
        if data.get("result") != 0 or not self.sticker:
            raise WbApiError(self._message(data, "Не удалось запросить код"))
        return payload.get("ttl") or 60

    def confirm_code(self, code):
        digits = re.sub(r"\D", "", str(code))
        if not self.sticker:
            raise WbApiError("Сначала запросите код")
        if len(digits) < 4 or len(digits) > 6:
            raise WbApiError("Введите код из 4–6 цифр")

        body = {"code": int(digits), "sticker": self.sticker}
        try:
            data, pow_header = self._request(
                self.AUTH_ORIGIN + "/v2/auth",
                method="POST",
                headers=self._auth_headers(),
                body=body,
            )
        except WbApiError as error:
            challenge = self._extract_challenge(error.pow_header)
            if not challenge:
                raise
            data, pow_header = self._request(
                self.AUTH_ORIGIN + "/v2/auth",
                method="POST",
                headers=self._auth_headers(challenge),
                body=body,
            )
        payload = data.get("payload") or {}
        token = payload.get("access_token") or data.get("access_token")

        if data.get("result") == 0 and token:
            self.token = token
            self._save_session()
            return

        challenge = self._extract_challenge(pow_header)
        if challenge:
            data, _ = self._request(
                self.AUTH_ORIGIN + "/v2/auth",
                method="POST",
                headers=self._auth_headers(challenge),
                body=body,
            )
            payload = data.get("payload") or {}
            token = payload.get("access_token") or data.get("access_token")
            if data.get("result") == 0 and token:
                self.token = token
                self._save_session()
                return

        raise WbApiError(self._message(data, "Неверный код"))

    def _api_headers(self, app_version="v0.0.44"):
        if not self.token:
            raise WbApiError("Сначала авторизуйтесь")
        return {
            "X-Token": self.token,
            "X-App-Type": "prod-my-pvz",
            "X-App-Version": app_version,
            "X-Client-Id": "my-pvz",
            "X-Language": "ru",
            "Deviceid": self.device_id,
        }

    def load_point_ids(self):
        data, _ = self._request(
            self.ORGS_ORIGIN + "/auth-api/v3/my-orgs",
            headers=self._api_headers("v0.0.55"),
        )
        self.organizations = data if isinstance(data, list) else []
        self.point_organizations = {}
        point_ids = []
        for organization in self.organizations:
            for point_id in organization.get("eapids") or []:
                try:
                    value = int(point_id)
                except (TypeError, ValueError):
                    continue
                if value <= 0:
                    continue
                self.point_organizations[value] = organization
                if value not in point_ids:
                    point_ids.append(value)
        return point_ids

    def enrich_for_point(self, point_id):
        point_id = int(point_id)
        organization = self.point_organizations.get(point_id)
        if not organization:
            raise WbApiError("Для выбранного ПВЗ не найдена организация WB")

        organization_id = organization.get("id")
        if self.active_organization_id == organization_id:
            return

        data, _ = self._request(
            self.ORGS_ORIGIN + "/auth-api/v3/enrich",
            method="POST",
            headers=self._api_headers("v0.0.55"),
            body={
                "org_id": organization_id,
                "position": organization.get("position"),
            },
        )
        access = data.get("access") or {}
        enriched_token = access.get("token")
        if not enriched_token:
            raise WbApiError(
                self._message(data, "WB не вернул обогащённый токен")
            )
        self.token = enriched_token
        self.active_organization_id = organization_id
        self._save_session()

    def load_reviews(self, point_id, limit=100, offset=0):
        self.enrich_for_point(point_id)
        params = [
            ("pickpoint_id", str(int(point_id))),
            ("filter.stars", "1"),
            ("filter.stars", "2"),
            ("filter.stars", "3"),
            ("filter.stars", "4"),
            ("filter.stars", "5"),
            ("filter.limit", str(int(limit))),
            ("filter.offset", str(int(offset))),
            ("filter.only_disputable", "false"),
        ]
        url = (
            self.RATING_ORIGIN
            + "/external/api/v3/feedbacks/pickpoint?"
            + urllib.parse.urlencode(params)
        )
        data, _ = self._request(url, headers=self._api_headers())
        return data

    @staticmethod
    def decode_client_id(rating_id):
        match = re.match(r"^([0-9a-f]{8})-", str(rating_id), re.I)
        if not match:
            raise ValueError("Некорректный ID оценки WB")
        return int(match.group(1), 16)


class WbReviewsWindow(tk.Toplevel):
    def __init__(self, parent, client):
        super().__init__(parent)
        self.title("Отзывы и оценки WB")
        self.geometry("900x560")
        self.minsize(760, 420)
        self.client = client
        self.reviews = []
        self.action_buttons = []
        self._button_refresh_job = None
        self._build_ui()
        if self.client.token:
            self.phone_var.set(self.client.phone)
            self.status_var.set("Сессия восстановлена. Загружаем ПВЗ...")
            self.after(
                50, lambda: self._run(
                    self.client.load_point_ids, self._points_loaded
                )
            )

    def _build_ui(self):
        auth = ttk.LabelFrame(self, text="Авторизация WB")
        auth.pack(fill="x", padx=10, pady=10)

        ttk.Label(auth, text="Телефон:").grid(row=0, column=0, padx=6, pady=8)
        self.phone_var = tk.StringVar(value=self.client.phone)
        phone_validation = (self.register(self._validate_phone), "%P")
        ttk.Entry(
            auth,
            textvariable=self.phone_var,
            width=20,
            validate="key",
            validatecommand=phone_validation,
        ).grid(
            row=0, column=1, padx=6, pady=8
        )
        ttk.Label(
            auth,
            text="Формат номера: 7XXXXXXXXXX (ровно 11 цифр)",
            foreground="#666666",
        ).grid(row=1, column=1, columnspan=2, padx=6, pady=(0, 7), sticky="w")
        self.send_btn = ttk.Button(
            auth, text="Получить код", command=self._request_code
        )
        self.send_btn.grid(row=0, column=2, padx=6, pady=8)

        ttk.Label(auth, text="Код:").grid(row=0, column=3, padx=6, pady=8)
        self.code_var = tk.StringVar()
        ttk.Entry(auth, textvariable=self.code_var, width=10).grid(
            row=0, column=4, padx=6, pady=8
        )
        self.login_btn = ttk.Button(
            auth, text="Войти", command=self._confirm_code
        )
        self.login_btn.grid(row=0, column=5, padx=6, pady=8)
        self.logout_btn = ttk.Button(
            auth, text="Выйти из WB", command=self._logout
        )
        self.logout_btn.grid(row=0, column=6, padx=6, pady=8)

        points = ttk.Frame(self)
        points.pack(fill="x", padx=10, pady=(0, 8))
        ttk.Label(points, text="ПВЗ:").pack(side="left")
        self.point_var = tk.StringVar()
        self.point_select = ttk.Combobox(
            points, textvariable=self.point_var, state="readonly", width=22
        )
        self.point_select.pack(side="left", padx=6)
        self.load_btn = ttk.Button(
            points, text="Загрузить отзывы", command=self._load_reviews,
            state="disabled",
        )
        self.load_btn.pack(side="left", padx=6)
        self.copy_btn = ttk.Button(
            points, text="Копировать ID", command=self._copy_selected,
            state="disabled",
        )
        self.copy_btn.pack(side="left", padx=6)

        self.status_var = tk.StringVar(value="Авторизуйтесь, чтобы получить ПВЗ")
        ttk.Label(points, textvariable=self.status_var).pack(
            side="left", padx=12
        )

        columns = (
            "date", "stars", "weight", "client_id", "action", "rating_id"
        )
        self.review_table_style = ttk.Style(self)
        self.review_table_style.configure(
            "WbReviews.Treeview",
            rowheight=36,
        )
        self.table = ttk.Treeview(
            self,
            columns=columns,
            show="headings",
            selectmode="browse",
            style="WbReviews.Treeview",
        )
        headings = {
            "date": "Дата",
            "stars": "Оценка",
            "weight": "Вес",
            "client_id": "ID клиента",
            "action": "Действие",
            "rating_id": "ID оценки",
        }
        widths = {
            "date": 130, "stars": 70, "weight": 80,
            "client_id": 130, "action": 100, "rating_id": 330,
        }
        for column in columns:
            self.table.heading(column, text=headings[column])
            self.table.column(column, width=widths[column], anchor="w")
        self.table.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.table.bind("<<TreeviewSelect>>", self._selection_changed)
        self.table.bind("<Double-1>", lambda _event: self._copy_selected())
        self.table.bind("<Configure>", self._schedule_action_buttons, add="+")
        self.table.bind("<MouseWheel>", self._schedule_action_buttons, add="+")

    @staticmethod
    def _validate_phone(value):
        if value == "":
            return True
        return (
            value.isdigit()
            and len(value) <= 11
            and value.startswith("7")
        )

    def _run(self, task, done, button=None):
        if button:
            button.configure(state="disabled")

        def worker():
            try:
                result = task()
            except Exception as error:
                self.after(
                    0,
                    lambda caught_error=error: self._show_error(
                        caught_error, button
                    ),
                )
                return
            self.after(0, lambda: done(result, button))

        threading.Thread(target=worker, daemon=True).start()

    def _show_error(self, error, button=None):
        if button:
            button.configure(state="normal")
        self.status_var.set(str(error))
        messagebox.showerror("Отзывы WB", str(error), parent=self)

    def _request_code(self):
        self.status_var.set("Запрашиваем код...")
        self._run(
            lambda: self.client.request_code(self.phone_var.get()),
            self._code_requested,
            self.send_btn,
        )

    def _code_requested(self, ttl, button):
        button.configure(state="normal")
        self.status_var.set("Код отправлен. Действует {} сек.".format(ttl))

    def _confirm_code(self):
        self.status_var.set("Выполняется вход...")
        self._run(
            lambda: self.client.confirm_code(self.code_var.get()),
            self._authorized,
            self.login_btn,
        )

    def _authorized(self, _result, button):
        button.configure(state="normal")
        self.status_var.set("Авторизация успешна. Загружаем ПВЗ...")
        self._run(self.client.load_point_ids, self._points_loaded)

    def _logout(self):
        if not messagebox.askyesno(
            "Отзывы WB",
            "Выйти из аккаунта WB и удалить сохранённую сессию?",
            parent=self,
        ):
            return
        self.client.clear_session()
        self.phone_var.set("")
        self.code_var.set("")
        self.point_var.set("")
        self.point_select.configure(values=[])
        self.load_btn.configure(state="disabled")
        self.copy_btn.configure(state="disabled")
        self.reviews = []
        for item in self.table.get_children():
            self.table.delete(item)
        self._schedule_action_buttons()
        self.status_var.set("Сессия WB удалена. Авторизуйтесь заново.")

    def _points_loaded(self, point_ids, _button=None):
        values = [str(value) for value in point_ids]
        self.point_select.configure(values=values)
        self.point_var.set("")
        self.load_btn.configure(state="normal" if values else "disabled")
        self.status_var.set(
            "Выберите ПВЗ" if values else "Доступные ПВЗ не найдены"
        )

    def _load_reviews(self):
        point_id = self.point_var.get()
        if not point_id:
            messagebox.showwarning(
                "Отзывы WB", "Выберите ПВЗ", parent=self
            )
            return
        self.status_var.set("Загружаем отзывы...")
        self._run(
            lambda: self.client.load_reviews(point_id),
            self._reviews_loaded,
            self.load_btn,
        )

    def _reviews_loaded(self, payload, button):
        button.configure(state="normal")
        self.reviews = payload.get("data") or []
        for item in self.table.get_children():
            self.table.delete(item)

        for review in self.reviews:
            rating_id = review.get("id") or ""
            try:
                client_id = self.client.decode_client_id(rating_id)
            except ValueError:
                client_id = ""
            date = str(review.get("rate_dt") or "")[:10]
            self.table.insert(
                "", "end",
                values=(
                    date,
                    review.get("stars", ""),
                    review.get("weight", ""),
                    client_id,
                    "",
                    rating_id,
                ),
            )
        self.copy_btn.configure(state="disabled")
        self.status_var.set(
            "Загружено {} из {} отзывов".format(
                len(self.reviews), payload.get("total", len(self.reviews))
            )
        )
        self._schedule_action_buttons()

    def _selection_changed(self, _event=None):
        self.copy_btn.configure(
            state="normal" if self.table.selection() else "disabled"
        )

    def _copy_selected(self):
        selection = self.table.selection()
        if not selection:
            return
        values = self.table.item(selection[0], "values")
        client_id = str(values[3])
        self.clipboard_clear()
        self.clipboard_append(client_id)
        self.update()
        self.status_var.set("ID клиента {} скопирован".format(client_id))

    def _schedule_action_buttons(self, _event=None):
        if self._button_refresh_job is not None:
            self.after_cancel(self._button_refresh_job)
        self._button_refresh_job = self.after(30, self._refresh_action_buttons)

    def _refresh_action_buttons(self):
        self._button_refresh_job = None
        for button in self.action_buttons:
            button.destroy()
        self.action_buttons = []

        for item_id in self.table.get_children():
            box = self.table.bbox(item_id, column="#5")
            if not box:
                continue
            x, y, width, height = box
            values = self.table.item(item_id, "values")
            if len(values) < 4 or not values[3]:
                continue
            client_id = str(values[3])
            button = ttk.Button(
                self.table,
                text="Найти",
                command=lambda value=client_id: self._search_client_history(value),
            )
            button.place(
                x=x + 7,
                y=y + 5,
                width=max(1, width - 14),
                height=max(1, height - 10),
            )
            button.bind(
                "<MouseWheel>",
                lambda event: self.table.event_generate(
                    "<MouseWheel>", delta=event.delta
                ),
            )
            self.action_buttons.append(button)

    def _table_click(self, event):
        item_id = self.table.identify_row(event.y)
        if not item_id:
            return
        values = self.table.item(item_id, "values")
        if len(values) < 4 or not values[3]:
            return
        self.table.selection_set(item_id)
        self._search_client_history(str(values[3]))

    def _search_client_history(self, client_id):
        self.status_var.set(
            "Ищем историю клиента {}...".format(client_id)
        )

        def worker():
            try:
                with core.connect_readonly(core.DEFAULT_DB_PATH) as con:
                    mobile, name = core.info_for_sid(con, client_id)
                    history = core.pickup_history_for_sid(con, client_id)
            except Exception as error:
                self.after(
                    0,
                    lambda caught_error=error: self._show_error(caught_error),
                )
                return

            def show_result():
                self.status_var.set(
                    "История клиента {} загружена".format(client_id)
                )
                self.master._open_pickup_history_modal(
                    client_id, name, mobile, history
                )

            self.after(0, show_result)

        threading.Thread(target=worker, daemon=True).start()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_TITLE} — v{APP_VERSION}")
        self.geometry("860x600")
        self.minsize(700, 420)

        self.log_queue: queue.Queue = queue.Queue()
        self.record = None  # лицензионная запись (платный ключ)
        self.hwid: Optional[str] = None
        self.trial_mode = False  # True — работаем без ключа, доступна 1 бесплатная попытка
        self.collected: List[dict] = []
        self.worker: Optional[threading.Thread] = None
        self.wb_client = WbReviewsClient()

        self._update_banner: Optional[tk.Frame] = None
        self._announce_banner: Optional[tk.Frame] = None

        self._tour_win: Optional[tk.Toplevel] = None
        self._tour_ring: Optional[tk.Toplevel] = None
        self._tour_idx = 0

        self._build_ui()
        self.after(100, self._drain_log_queue)
        self.after(200, self._check_license)
        self.after(300, self._check_update)
        self.after(400, self._check_messages)
        self.after(600, self._maybe_autostart_tour)

    # ---------- вспомогательное ----------

    def _add_context_menu(self, entry: tk.Entry):
        """ПКМ по полю -> Вырезать/Копировать/Вставить/Выделить всё.
        Ctrl+V и так должен работать по умолчанию, но на Windows многие
        пытаются вставить именно через правую кнопку мыши."""
        menu = tk.Menu(entry, tearoff=0)
        menu.add_command(label="Вырезать", command=lambda: entry.event_generate("<<Cut>>"))
        menu.add_command(label="Копировать", command=lambda: entry.event_generate("<<Copy>>"))
        menu.add_command(label="Вставить", command=lambda: entry.event_generate("<<Paste>>"))
        menu.add_separator()
        menu.add_command(label="Выделить всё", command=lambda: entry.select_range(0, "end"))

        def show(event):
            entry.focus_set()
            try:
                menu.tk_popup(event.x_root, event.y_root)
            finally:
                menu.grab_release()

        entry.bind("<Button-3>", show)

    # ---------- UI ----------

    def _build_ui(self):
        pad = {"padx": 8, "pady": 6}

        # ---- раздел активации ключа ----
        license_frame = ttk.LabelFrame(self, text="Лицензия")
        license_frame.pack(fill="x", padx=8, pady=(8, 0))

        ttk.Label(license_frame, text="Ключ доступа:").grid(row=0, column=0, sticky="w", padx=(8, 4), pady=8)
        self.key_var = tk.StringVar()
        self.key_entry = ttk.Entry(license_frame, textvariable=self.key_var, width=34)
        self.key_entry.grid(row=0, column=1, padx=4, pady=8)
        self.key_entry.bind("<Return>", lambda e: self.on_activate_key())
        self._add_context_menu(self.key_entry)

        self.activate_btn = ttk.Button(license_frame, text="Активировать", command=self.on_activate_key)
        self.activate_btn.grid(row=0, column=2, padx=8, pady=8)

        self.license_status_var = tk.StringVar(value="Проверка сохранённого ключа...")
        ttk.Label(license_frame, textvariable=self.license_status_var, foreground="#555").grid(
            row=0, column=3, sticky="w", padx=(8, 8), pady=8,
        )
        license_frame.columnconfigure(3, weight=1)

        buy_link = tk.Label(
            license_frame, text="Купить ключ: @roma_denosov", fg="#0645AD",
            cursor="hand2", font=("", 9, "underline"),
        )
        buy_link.grid(row=1, column=0, sticky="w", padx=8, pady=(0, 8))
        buy_link.bind("<Button-1>", lambda e: webbrowser.open(TELEGRAM_URL))

        help_link = tk.Label(
            license_frame, text="Как пользоваться", fg="#0645AD",
            cursor="hand2", font=("", 9, "underline"),
        )
        help_link.grid(row=1, column=1, columnspan=3, sticky="w", padx=8, pady=(0, 8))
        help_link.bind("<Button-1>", lambda e: self._open_tour())

        top = ttk.Frame(self)
        top.pack(fill="x", **pad)

        ttk.Label(top, text="Номер ячейки:").grid(row=0, column=0, sticky="w")
        self.cell_var = tk.StringVar()
        self.cell_entry = ttk.Entry(top, textvariable=self.cell_var, width=12)
        self.cell_entry.grid(row=0, column=1, padx=(4, 16))
        self.cell_entry.bind("<Return>", lambda e: self.on_search())
        self._add_context_menu(self.cell_entry)

        self.search_btn = ttk.Button(top, text="Найти", command=self.on_search, state="disabled")
        self.search_btn.grid(row=0, column=2, sticky="w")

        ttk.Label(top, text="SID клиента:").grid(row=0, column=3, sticky="w", padx=(24, 0))
        self.sid_history_var = tk.StringVar()
        self.sid_history_entry = ttk.Entry(top, textvariable=self.sid_history_var, width=14)
        self.sid_history_entry.grid(row=0, column=4, padx=(4, 16))
        self.sid_history_entry.bind("<Return>", lambda e: self.on_sid_history())
        self._add_context_menu(self.sid_history_entry)

        ttk.Button(top, text="История", command=self.on_sid_history).grid(row=0, column=5, sticky="w")
        ttk.Button(
            top, text="Отзывы WB", command=self.open_wb_reviews
        ).grid(row=0, column=6, sticky="w", padx=(16, 0))

        self.status_var = tk.StringVar(value="")
        ttk.Label(self, textvariable=self.status_var, foreground="#555").pack(fill="x", padx=8)

        self.progress = ttk.Progressbar(self, mode="indeterminate")
        self.progress.pack(fill="x", padx=8, pady=(0, 4))

        # ---- разделяемая по вертикали область: таблица сверху, статус снизу ----
        # tk.PanedWindow (не ttk) даёт заметную и удобную для перетаскивания
        # полосу-разделитель между областями.
        paned = tk.PanedWindow(
            self, orient="vertical", sashrelief="raised", sashwidth=6,
            bg="#d0d0d0", bd=0,
        )
        paned.pack(fill="both", expand=True, padx=8, pady=4)

        self.table_frame = ttk.Frame(paned)
        paned.add(self.table_frame, minsize=120, stretch="always")

        status_frame = ttk.Frame(paned)
        paned.add(status_frame, minsize=80, stretch="always")

        # ---- таблица результатов (шапка и строки в одной grid-сетке) ----
        canvas = tk.Canvas(self.table_frame, highlightthickness=0)
        yscroll = ttk.Scrollbar(self.table_frame, orient="vertical", command=canvas.yview)
        self.table_body = ttk.Frame(canvas)
        self.table_body.bind(
            "<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        canvas.create_window((0, 0), window=self.table_body, anchor="nw")
        canvas.configure(yscrollcommand=yscroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        yscroll.pack(side="right", fill="y")

        for col, (_, width, weight) in enumerate(COLUMNS):
            self.table_body.grid_columnconfigure(col, minsize=width, weight=weight)

        self._draw_header()

        # ---- статус/лог (лицензия, ошибки, "не найдено" и т.п.) ----
        ttk.Label(status_frame, text="Журнал:", foreground="#555").pack(anchor="w", padx=4)
        log_container = ttk.Frame(status_frame)
        log_container.pack(fill="both", expand=True)
        self.status_log = tk.Text(log_container, wrap="word", state="disabled")
        log_scroll = ttk.Scrollbar(log_container, orient="vertical", command=self.status_log.yview)
        self.status_log.configure(yscrollcommand=log_scroll.set)
        self.status_log.pack(side="left", fill="both", expand=True)
        log_scroll.pack(side="right", fill="y")

    def _draw_header(self):
        for col, (text, _, _) in enumerate(COLUMNS):
            tk.Label(
                self.table_body, text=text, font=("", 9, "bold"),
                anchor="w", padx=4, pady=4,
            ).grid(row=0, column=col, sticky="ew")

    def _clear_table(self):
        for child in self.table_body.winfo_children():
            child.destroy()
        self._draw_header()

    def open_wb_reviews(self):
        WbReviewsWindow(self, self.wb_client)

    def _add_row(self, row_idx: int, e: dict):
        bg = "#f2f2f2" if row_idx % 2 else "#ffffff"
        code = e.get("code")
        code_text = code if code else KIND_LABELS.get(e.get("kind"), "-")
        values = [
            e.get("date") or "-", e.get("status_ru") or "-", e.get("name") or "-",
            e.get("phone") or "-", e["sid"], code_text,
        ]
        for col, val in enumerate(values):
            tk.Label(
                self.table_body, text=val, anchor="w", bg=bg, padx=4, pady=3,
            ).grid(row=row_idx, column=col, sticky="ew")
        cell = tk.Frame(self.table_body, bg=bg)
        cell.grid(row=row_idx, column=len(values), sticky="ew")
        if code:
            ttk.Button(
                cell, text="QR", width=6,
                command=lambda sid=e["sid"], code=code: self._make_qr_for(sid, code),
            ).pack(side="left", padx=2, pady=1)
        ttk.Button(
            cell, text="Товары", width=8,
            command=lambda sid=e["sid"], name=e.get("name"), phone=e.get("phone"):
                self._show_goods(sid, name, phone),
        ).pack(side="left", padx=2, pady=1)

    def _make_qr_for(self, sid: str, code: str):
        """Построить QR прямо в программе и показать его в отдельном окне
        с кнопкой «Скачать» (файл на Рабочий стол не пишем автоматически)."""
        payload = f"{sid}_{code}"
        try:
            import qrcode  # pip install "qrcode[pil]"

            img = qrcode.make(payload)
            tmp_path = os.path.join(tempfile.gettempdir(), f"qr_{payload}.png")
            img.save(tmp_path)
        except ImportError:
            messagebox.showerror(
                APP_TITLE, 'QR не создан — не установлен пакет qrcode[pil].'
            )
            return
        except Exception as ex:
            messagebox.showerror(APP_TITLE, f"Не удалось создать QR: {ex}")
            return
        self.log(f"QR создан: {payload}")
        self._open_qr_modal(payload, tmp_path)

    def _open_qr_modal(self, payload: str, img_path: str):
        win = tk.Toplevel(self)
        win.title(f"QR-код — {payload}")
        win.transient(self)
        win.resizable(False, False)

        img = tk.PhotoImage(file=img_path)
        win._qr_img = img  # держим ссылку, иначе картинку соберёт GC
        tk.Label(win, image=img).pack(padx=16, pady=(16, 8))
        ttk.Label(win, text=payload, font=("", 10, "bold")).pack(pady=(0, 8))

        btns = ttk.Frame(win)
        btns.pack(pady=(0, 16))
        ttk.Button(
            btns, text="Скачать", width=12,
            command=lambda: self._save_qr(payload, img_path),
        ).pack(side="left", padx=6)
        ttk.Button(btns, text="Закрыть", width=12, command=win.destroy).pack(side="left", padx=6)

    def _save_qr(self, payload: str, img_path: str):
        desktop = Path.home() / "Desktop"
        initial_dir = str(desktop if desktop.is_dir() else Path.home())
        dest = filedialog.asksaveasfilename(
            title="Сохранить QR-код",
            initialdir=initial_dir,
            initialfile=f"qr_{payload}.png",
            defaultextension=".png",
            filetypes=[("PNG", "*.png")],
        )
        if not dest:
            return
        try:
            shutil.copyfile(img_path, dest)
        except Exception as ex:
            messagebox.showerror(APP_TITLE, f"Не удалось сохранить файл: {ex}")
            return
        self.log(f"QR сохранён: {dest}")

    # ---------- автообновление ----------

    @staticmethod
    def _ver_tuple(v: str):
        """'1.2.3' -> (1, 2, 3). Некорректные части -> 0."""
        parts = []
        for x in str(v).split("."):
            try:
                parts.append(int(x))
            except ValueError:
                parts.append(0)
        return tuple(parts)

    def _check_update(self):
        """Тихая проверка новой версии на сайте. Ошибки/нет сети — игнорируем."""
        def worker():
            try:
                bust = f"{VERSION_URL}?_={int(time.time())}"
                req = urllib.request.Request(bust, headers={"Cache-Control": "no-cache"})
                with urllib.request.urlopen(req, timeout=6) as resp:
                    info = json.load(resp)
                remote = str(info.get("version") or "")
                if remote and self._ver_tuple(remote) > self._ver_tuple(APP_VERSION):
                    self.after(0, lambda: self._show_update_banner(info))
                ann = info.get("announcement")
                if isinstance(ann, dict) and ann.get("text"):
                    self.after(0, lambda: self._show_announcement_banner(ann))
            except Exception:
                pass  # обновление/объявление необязательны — молча пропускаем

        threading.Thread(target=worker, daemon=True).start()

    def _check_messages(self):
        """Забрать объявления из админки сайта (mokky /message) и показать
        самое свежее активное баннером. Ошибки/нет сети — молча пропускаем."""
        def worker():
            try:
                bust = f"{MESSAGE_API}?_={int(time.time())}"
                req = urllib.request.Request(bust, headers={"Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=6) as resp:
                    data = json.load(resp)
            except Exception:
                return  # объявления необязательны

            if not isinstance(data, list) or not data:
                return
            # самое свежее по id, только активные и с текстом
            active = [
                m for m in data
                if isinstance(m, dict) and m.get("active", True) and str(m.get("text") or "").strip()
            ]
            if not active:
                return
            active.sort(key=lambda m: m.get("id") or 0, reverse=True)
            latest = active[0]
            ann = {
                "id": f"msg-{latest.get('id')}",
                "text": latest.get("text"),
                "url": latest.get("url"),
                "button": latest.get("button"),
            }
            self.after(0, lambda: self._show_announcement_banner(ann))

        threading.Thread(target=worker, daemon=True).start()

    # --- запоминание скрытых объявлений (по id) ---

    def _announce_store_path(self) -> Path:
        return core.LICENSE_PATH.parent / "announce.json"

    def _announce_seen_id(self) -> str:
        try:
            with open(self._announce_store_path(), encoding="utf-8") as f:
                return str(json.load(f).get("seen") or "")
        except Exception:
            return ""

    def _save_announce_seen(self, ann_id: str):
        try:
            path = self._announce_store_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"seen": ann_id}, f)
        except Exception:
            pass

    def _show_announcement_banner(self, ann: dict):
        if self._announce_banner is not None:
            return  # уже показан
        text = str(ann.get("text") or "").strip()
        if not text:
            return
        ann_id = str(ann.get("id") or "")
        if ann_id and ann_id == self._announce_seen_id():
            return  # это объявление пользователь уже скрыл

        banner = tk.Frame(self, bg="#cff4fc")
        banner.pack(side="top", fill="x", before=self.winfo_children()[0])
        self._announce_banner = banner

        tk.Label(
            banner, text=text, bg="#cff4fc", fg="#055160",
            anchor="w", justify="left", padx=10, pady=6, wraplength=760,
        ).pack(side="left")

        def hide():
            if ann_id:
                self._save_announce_seen(ann_id)
            banner.destroy()

        tk.Button(
            banner, text="Скрыть", bg="#cff4fc", relief="flat", command=hide,
        ).pack(side="right", padx=(0, 8), pady=4)

        url = ann.get("url")
        if url:
            label = str(ann.get("button") or "Подробнее")
            tk.Button(
                banner, text=label, bg="#0dcaf0", fg="#055160", relief="flat",
                padx=10, command=lambda: webbrowser.open(url),
            ).pack(side="right", padx=6, pady=4)

    # ---------- встроенный мини-курс «Как пользоваться» ----------

    def _tour_store_path(self) -> Path:
        return core.LICENSE_PATH.parent / "tour.json"

    def _tour_seen(self) -> bool:
        try:
            return self._tour_store_path().exists()
        except Exception:
            return False

    def _mark_tour_seen(self):
        try:
            path = self._tour_store_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"seen": True}, f)
        except Exception:
            pass

    def _maybe_autostart_tour(self):
        if not self._tour_seen():
            self._open_tour()

    def _open_tour(self):
        # уже открыт — просто поднять на передний план
        if self._tour_win is not None and tk.Toplevel.winfo_exists(self._tour_win):
            self._tour_win.lift()
            return
        self._mark_tour_seen()

        win = tk.Toplevel(self)
        self._tour_win = win
        win.title("Как пользоваться")
        win.transient(self)
        win.resizable(False, False)
        win.protocol("WM_DELETE_WINDOW", self._close_tour)

        self._tour_title = tk.Label(win, font=("", 11, "bold"), anchor="w", justify="left")
        self._tour_title.pack(fill="x", padx=16, pady=(14, 4))
        self._tour_text = tk.Label(
            win, anchor="w", justify="left", wraplength=380, fg="#333",
        )
        self._tour_text.pack(fill="x", padx=16, pady=(0, 8))

        self._tour_counter = tk.Label(win, fg="#888")
        self._tour_counter.pack(anchor="w", padx=16)

        btns = ttk.Frame(win)
        btns.pack(fill="x", padx=16, pady=12)
        self._tour_prev = ttk.Button(btns, text="◀ Назад", command=self._tour_back)
        self._tour_prev.pack(side="left")
        ttk.Button(btns, text="Закрыть", command=self._close_tour).pack(side="right")
        self._tour_next = ttk.Button(btns, text="Далее ▶", command=self._tour_forward)
        self._tour_next.pack(side="right", padx=6)

        # поставить окно в правый нижний угол, чтобы не перекрывать подсветку
        win.update_idletasks()
        px, py = self.winfo_rootx(), self.winfo_rooty()
        pw, ph = self.winfo_width(), self.winfo_height()
        ww, wh = win.winfo_width(), win.winfo_height()
        win.geometry(f"+{px + pw - ww - 20}+{py + ph - wh - 20}")

        self._tour_idx = 0
        self._tour_show(0)

    def _tour_show(self, idx: int):
        idx = max(0, min(idx, len(TOUR_STEPS) - 1))
        self._tour_idx = idx
        title, text, target_attr = TOUR_STEPS[idx]
        self._tour_title.configure(text=title)
        self._tour_text.configure(text=text)
        self._tour_counter.configure(text=f"Шаг {idx + 1} из {len(TOUR_STEPS)}")
        self._tour_prev.configure(state="normal" if idx > 0 else "disabled")
        self._tour_next.configure(
            text="Далее ▶" if idx < len(TOUR_STEPS) - 1 else "Готово",
        )
        widget = getattr(self, target_attr, None) if target_attr else None
        self._highlight(widget)

    def _tour_forward(self):
        if self._tour_idx >= len(TOUR_STEPS) - 1:
            self._close_tour()
        else:
            self._tour_show(self._tour_idx + 1)

    def _tour_back(self):
        self._tour_show(self._tour_idx - 1)

    def _close_tour(self):
        self._clear_highlight()
        if self._tour_win is not None:
            try:
                self._tour_win.destroy()
            except Exception:
                pass
            self._tour_win = None

    def _clear_highlight(self):
        if self._tour_ring is not None:
            try:
                self._tour_ring.destroy()
            except Exception:
                pass
            self._tour_ring = None

    def _highlight(self, widget):
        """Обвести реальный виджет рамкой поверх окна (середина прозрачна).
        Использует -transparentcolor (Windows)."""
        self._clear_highlight()
        if widget is None:
            return
        try:
            widget.update_idletasks()
            if not widget.winfo_ismapped():
                return
            x, y = widget.winfo_rootx(), widget.winfo_rooty()
            w, h = widget.winfo_width(), widget.winfo_height()
        except Exception:
            return
        pad = 4
        trans = "#fdfefd"  # редкий цвет для прозрачности
        ring = tk.Toplevel(self)
        ring.overrideredirect(True)
        try:
            ring.attributes("-topmost", True)
            ring.attributes("-transparentcolor", trans)
        except Exception:
            pass
        ring.geometry(f"{w + pad * 2}x{h + pad * 2}+{x - pad}+{y - pad}")
        cv = tk.Canvas(ring, highlightthickness=0, bg=trans)
        cv.pack(fill="both", expand=True)
        cv.create_rectangle(
            2, 2, w + pad * 2 - 2, h + pad * 2 - 2,
            outline="#ff5722", width=3,
        )
        self._tour_ring = ring
        # держать подсказку выше рамки
        if self._tour_win is not None:
            try:
                self._tour_win.lift()
            except Exception:
                pass

    def _show_update_banner(self, info: dict):
        if self._update_banner is not None:
            return  # уже показан
        remote = info.get("version") or "?"
        banner = tk.Frame(self, bg="#fff3cd")
        banner.pack(side="top", fill="x", before=self.winfo_children()[0])
        self._update_banner = banner

        tk.Label(
            banner, text=f"Доступна новая версия {remote}. Обновите программу.",
            bg="#fff3cd", fg="#664d03", anchor="w", padx=10, pady=6,
        ).pack(side="left")
        tk.Button(
            banner, text="Позже", bg="#fff3cd", relief="flat",
            command=banner.destroy,
        ).pack(side="right", padx=(0, 8), pady=4)
        tk.Button(
            banner, text="Обновить программу", bg="#0d6efd", fg="#ffffff",
            relief="flat", padx=10, command=lambda: self._do_update(info),
        ).pack(side="right", padx=6, pady=4)

    def _do_update(self, info: dict):
        # Автозамена возможна только в собранном exe.
        if not getattr(sys, "frozen", False):
            messagebox.showinfo(
                APP_TITLE,
                "Автообновление доступно только в установленной программе (.exe).\n"
                "Сейчас открою страницу загрузки.",
            )
            webbrowser.open(SITE_URL)
            return

        url = info.get("win7_url") if IS_WIN7_BUILD else info.get("win10_url")
        if not url:
            messagebox.showerror(APP_TITLE, "В манифесте обновления нет ссылки на файл.")
            return

        cur = sys.executable
        new = cur + ".new"

        win = tk.Toplevel(self)
        win.title("Обновление")
        win.transient(self)
        win.resizable(False, False)
        ttk.Label(win, text="Загрузка обновления, подождите…").pack(padx=24, pady=16)
        pb = ttk.Progressbar(win, mode="indeterminate")
        pb.pack(fill="x", padx=24, pady=(0, 16))
        pb.start(15)

        def worker():
            try:
                urllib.request.urlretrieve(url, new)
            except Exception as ex:
                self.after(0, lambda: (win.destroy(), messagebox.showerror(
                    APP_TITLE, f"Не удалось скачать обновление: {ex}"
                )))
                return
            self.after(0, lambda: self._apply_update(cur, new, win))

        threading.Thread(target=worker, daemon=True).start()

    def _apply_update(self, cur: str, new: str, win: tk.Toplevel):
        """Запустить bat-помощник, который заменит exe после выхода, и закрыться."""
        bat_path = os.path.join(tempfile.gettempdir(), "shk_update.bat")
        script = (
            "@echo off\r\n"
            ":retry\r\n"
            "ping -n 2 127.0.0.1 >nul\r\n"
            f'move /y "{new}" "{cur}" >nul 2>&1\r\n'
            "if errorlevel 1 goto retry\r\n"
            f'start "" "{cur}"\r\n'
            'del "%~f0" >nul 2>&1\r\n'
        )
        try:
            with open(bat_path, "w", encoding="cp866") as f:
                f.write(script)
        except Exception:
            with open(bat_path, "w") as f:
                f.write(script)

        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        subprocess.Popen(
            ["cmd", "/c", bat_path],
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            close_fds=True,
        )
        try:
            win.destroy()
        except Exception:
            pass
        self.destroy()
        os._exit(0)  # гарантированно освобождаем файл exe для замены

    # ---------- модалка «Товары клиента» ----------

    def _show_goods(self, sid: str, name, phone):
        def worker():
            try:
                with core.connect_readonly(core.DEFAULT_DB_PATH) as con:
                    rows = core.goods_for_sid(con, sid)
            except Exception as ex:
                self.after(0, lambda: messagebox.showerror(APP_TITLE, f"Ошибка чтения товаров: {ex}"))
                return
            self.after(0, lambda: self._open_goods_modal(sid, name, phone, rows))

        threading.Thread(target=worker, daemon=True).start()

    def _open_goods_modal(self, sid: str, name, phone, rows: List[dict]):
        win = tk.Toplevel(self)
        win.title(f"Товары клиента — {name or sid}")
        win.geometry("640x380")
        win.transient(self)

        header = f"SID={sid}   Телефон: {phone or '-'}   Имя: {name or '-'}   Найдено: {len(rows)}"
        ttk.Label(win, text=header, font=("", 9, "bold")).pack(anchor="w", padx=10, pady=(10, 6))

        body = ttk.Frame(win)
        body.pack(fill="both", expand=True, padx=10)

        columns = ("source", "cell", "sticker", "barcode", "scanned")
        headers = {
            "source": "Источник", "cell": "Ячейка", "sticker": "Стикер",
            "barcode": "Штрихкод", "scanned": "Скан-код",
        }
        widths = {"source": 140, "cell": 60, "sticker": 110, "barcode": 130, "scanned": 130}

        tree = ttk.Treeview(body, columns=columns, show="headings", height=12)
        for col in columns:
            tree.heading(col, text=headers[col])
            tree.column(col, width=widths[col], anchor="w")
        for r in rows:
            tree.insert("", "end", values=(
                r.get("source") or "-", r.get("cell") or "-",
                r.get("sticker_code") or "-", r.get("barcode") or "-",
                r.get("scanned_code") or "-",
            ))
        vsb = ttk.Scrollbar(body, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

        if not rows:
            ttk.Label(win, text="Товаров не найдено.", foreground="#777").pack(padx=10, pady=(6, 0))

        ttk.Button(win, text="Закрыть", command=win.destroy).pack(pady=10)

    # ---------- история получения/отказов по SID ----------

    def on_sid_history(self):
        sid = self.sid_history_var.get().strip()
        if not sid:
            messagebox.showwarning(APP_TITLE, "Введите SID клиента.")
            return

        def worker():
            try:
                with core.connect_readonly(core.DEFAULT_DB_PATH) as con:
                    mobile, name = core.info_for_sid(con, sid)
                    history = core.pickup_history_for_sid(con, sid)
            except Exception as ex:
                self.after(0, lambda: messagebox.showerror(APP_TITLE, f"Ошибка чтения истории: {ex}"))
                return
            self.after(0, lambda: self._open_pickup_history_modal(sid, name, mobile, history))

        threading.Thread(target=worker, daemon=True).start()

    def _open_pickup_history_modal(self, sid: str, name, phone, history: List[dict]):
        win = tk.Toplevel(self)
        win.title(f"История получения — {name or sid}")
        win.geometry("680x400")
        win.transient(self)

        header = f"SID={sid}   Телефон: {phone or '-'}   Имя: {name or '-'}   Событий: {len(history)}"
        ttk.Label(win, text=header, font=("", 9, "bold")).pack(anchor="w", padx=10, pady=(10, 6))

        body = ttk.Frame(win)
        body.pack(fill="both", expand=True, padx=10)

        columns = ("date", "time", "status", "phone", "codes")
        headers = {
            "date": "Дата", "time": "Время", "status": "Статус",
            "phone": "Телефон", "codes": "Штрихкоды",
        }
        widths = {"date": 100, "time": 80, "status": 120, "phone": 110, "codes": 260}

        tree = ttk.Treeview(body, columns=columns, show="headings", height=12)
        for col in columns:
            tree.heading(col, text=headers[col])
            tree.column(col, width=widths[col], anchor="w")
        for e in history:
            dt = (e.get("datetime") or "").replace("T", " ")
            date_part, _, time_part = dt.partition(" ")
            tree.insert("", "end", values=(
                date_part or "-",
                time_part[:8] or "-",
                e.get("status_ru") or "-",
                phone or "-",
                ", ".join(e.get("codes") or []) or "-",
            ))
        vsb = ttk.Scrollbar(body, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

        if not history:
            ttk.Label(win, text="История получения/отказов не найдена.", foreground="#777").pack(
                padx=10, pady=(6, 0)
            )

        ttk.Button(win, text="Закрыть", command=win.destroy).pack(pady=10)

    # ---------- логирование в журнал ----------

    def log(self, msg: str):
        self.log_queue.put(msg)

    def _drain_log_queue(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self.status_log.configure(state="normal")
                self.status_log.insert("end", msg.rstrip("\n") + "\n")
                self.status_log.see("end")
                self.status_log.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(100, self._drain_log_queue)

    # ---------- лицензия ----------

    def _check_license(self):
        """При старте молча пробуем сохранённый ключ (если есть) — без блокирующих
        диалогов. Если ключа нет/он невалиден, проверяем доступность бесплатной
        пробной попытки (привязанной к железу, не к локальным файлам)."""
        saved = core.load_saved_key()
        if not saved:
            self.license_status_var.set("Ключ не активирован. Проверка пробного периода...")
            self._refresh_trial_status()
            return

        self.license_status_var.set("Проверка сохранённого ключа...")

        def worker():
            record, msg = core.try_key(saved)
            self.after(0, lambda: self._apply_license_result(record, msg))

        threading.Thread(target=worker, daemon=True).start()

    def on_activate_key(self):
        key = self.key_var.get().strip()
        if not key:
            messagebox.showwarning(APP_TITLE, "Введите ключ доступа.")
            return
        self.activate_btn.configure(state="disabled")
        self.license_status_var.set("Проверка ключа...")

        def worker():
            record, msg = core.try_key(key)
            self.after(0, lambda: self._apply_license_result(record, msg, notify=True))

        threading.Thread(target=worker, daemon=True).start()

    def _apply_license_result(self, record, msg: str, notify: bool = False):
        self.activate_btn.configure(state="normal")
        self.record = record
        if record:
            self.trial_mode = False
            self.license_status_var.set(msg)
            self.search_btn.configure(state="normal")
        else:
            self.license_status_var.set(msg)
            self._refresh_trial_status()
        if notify:
            if record:
                messagebox.showinfo(APP_TITLE, msg)
            else:
                messagebox.showerror(APP_TITLE, msg)

    def _refresh_trial_status(self):
        """Проверить на сервере (по hwid), доступна ли ещё бесплатная попытка
        для этого устройства. Работает и после удаления/переустановки
        программы — состояние хранится не локально, а на сервере."""
        def worker():
            hwid = core.hardware_id()
            self.hwid = hwid
            try:
                used = core.trial_used(hwid)
            except Exception:
                used = None  # нет связи — считаем недоступным до восстановления сети
            self.after(0, lambda: self._apply_trial_status(used))

        threading.Thread(target=worker, daemon=True).start()

    def _apply_trial_status(self, used: Optional[bool]):
        if self.record:
            return  # платный ключ уже активен — пробный статус не актуален
        if used is None:
            self.trial_mode = False
            self.license_status_var.set(
                "Ключ не активирован. Нет связи с сервером для проверки пробного периода."
            )
            self.search_btn.configure(state="disabled")
        elif used:
            self.trial_mode = False
            self.license_status_var.set(
                "Пробный период для этого устройства уже использован. Нужен платный ключ."
            )
            self.search_btn.configure(state="disabled")
        else:
            self.trial_mode = True
            self.license_status_var.set(
                "Ключ не активирован — первый подбор кода бесплатный (пробный, для этого устройства)."
            )
            self.search_btn.configure(state="normal")

    def _remaining_iterations(self) -> int:
        if not self.record:
            return 0
        limit = self.record.get("limit") or 0
        used = self.record.get("used") or 0
        return max(limit - used, 0)

    # ---------- поиск кодов ----------

    def on_search(self):
        if self.worker and self.worker.is_alive():
            return
        using_trial = self.trial_mode and not self.record
        if not self.record and not using_trial:
            messagebox.showwarning(
                APP_TITLE, "Нет доступа: активируйте ключ (пробная попытка уже использована)."
            )
            return
        if self.record and self._remaining_iterations() <= 0:
            messagebox.showwarning(APP_TITLE, "Лимит ключа исчерпан. Введите новый ключ и активируйте его.")
            return
        cell = self.cell_var.get().strip()
        if not cell:
            messagebox.showwarning(APP_TITLE, "Введите номер ячейки.")
            return

        self.status_log.configure(state="normal")
        self.status_log.delete("1.0", "end")
        self.status_log.configure(state="disabled")
        self._clear_table()
        self.collected = []
        self.progress.start(15)
        self.search_btn.configure(state="disabled")
        self.status_var.set(f"Поиск по ячейке {cell}...")

        def worker():
            _, found_any, collected = core.run(
                core.DEFAULT_DB_PATH, cell, None, None, False,
                0, log=self.log, auto_qr=False,
            )
            self.collected = collected

            if found_any and self.record is not None:
                try:
                    new_used = core.api_increment(self.record)
                    self.record["used"] = new_used
                    remaining = max((self.record.get("limit") or 0) - new_used, 0)
                    msg = f"Списана 1 итерация. Осталось: {remaining}"
                    self.log(msg)
                    self.after(0, lambda: self.license_status_var.set(msg))
                except Exception:
                    self.log("Не удалось списать итерацию — нет связи с сервером.")
            elif found_any and using_trial:
                try:
                    claimed = core.trial_claim(self.hwid)
                except Exception:
                    claimed = False
                    self.log("Не удалось подтвердить пробный подбор — нет связи с сервером.")
                self.trial_mode = False
                if claimed:
                    msg = "Пробный подбор использован. Для дальнейшей работы нужен платный ключ."
                else:
                    msg = "Пробный период уже был использован на этом устройстве. Нужен платный ключ."
                self.log(msg)
                self.after(0, lambda: self.license_status_var.set(msg))

            self.after(0, lambda: self._on_search_done(found_any))

        self.worker = threading.Thread(target=worker, daemon=True)
        self.worker.start()

    def _on_search_done(self, found_any: bool):
        self.progress.stop()
        if self.record:
            can_search = self._remaining_iterations() > 0
        else:
            can_search = self.trial_mode
        self.search_btn.configure(state="normal" if can_search else "disabled")
        codes_found = sum(1 for e in self.collected if e.get("code"))
        self.status_var.set(
            f"Готово. Найдено кодов: {codes_found} из {len(self.collected)} записей"
            if self.collected else "Ничего не найдено."
        )
        for idx, e in enumerate(self.collected, start=1):
            self._add_row(idx, e)
def main():
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
