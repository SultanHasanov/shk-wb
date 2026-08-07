"""
Глобальный перехват сканера штрихкодов/QR (Windows).

Сканер в режиме HID «печатает» код как нажатия клавиш в активное окно. Чтобы
«Подбор кодов» мог ловить скан ОДНОВРЕМЕННО с открытым WB_PVZ (который остаётся
в фокусе и обрабатывает выдачу), ставим низкоуровневый хук клавиатуры
WH_KEYBOARD_LL. Хук НЕ «съедает» ввод (всегда вызывает CallNextHookEx), поэтому
WB_PVZ получает те же нажатия как обычно.

Скан отличаем от ручного набора по скорости: сканер жмёт клавиши очень быстро
(единицы миллисекунд между символами) и завершает Enter. Медленный набор
человеком сбрасывает буфер и не считается сканом.

Символы восстанавливаем по vkCode (виртуальный код клавиши Windows) — это не
зависит от активной раскладки, поэтому русская раскладка не искажает цифры/буквы.

Работает только на Windows. На других ОС start() тихо ничего не делает.
"""

import ctypes
import sys
import threading
import time
from ctypes import wintypes

WH_KEYBOARD_LL = 13
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
VK_RETURN = 0x0D
VK_SHIFT = 0x10
VK_CAPITAL = 0x14

# vkCode -> (обычный символ, символ с Shift) для не-буквенно-цифровых клавиш
_VK_PUNCT = {
    0xBA: (";", ":"), 0xBB: ("=", "+"), 0xBC: (",", "<"), 0xBD: ("-", "_"),
    0xBE: (".", ">"), 0xBF: ("/", "?"), 0xC0: ("`", "~"), 0xDB: ("[", "{"),
    0xDC: ("\\", "|"), 0xDD: ("]", "}"), 0xDE: ("'", '"'),
    0x6A: ("*", "*"), 0x6B: ("+", "+"), 0x6D: ("-", "-"),
    0x6E: (".", "."), 0x6F: ("/", "/"),
}
# символы верхнего ряда с Shift
_SHIFT_NUM = {
    0x30: ")", 0x31: "!", 0x32: "@", 0x33: "#", 0x34: "$",
    0x35: "%", 0x36: "^", 0x37: "&", 0x38: "*", 0x39: "(",
}


def _vk_to_char(vk: int, shift: bool, caps: bool):
    """Восстановить символ по виртуальному коду клавиши (без учёта раскладки)."""
    if 0x41 <= vk <= 0x5A:  # A..Z
        upper = shift ^ caps
        return chr(vk) if upper else chr(vk + 32)
    if 0x30 <= vk <= 0x39:  # 0..9 верхний ряд
        return _SHIFT_NUM[vk] if shift else chr(vk)
    if 0x60 <= vk <= 0x69:  # numpad 0..9
        return chr(vk - 0x30)
    if vk in _VK_PUNCT:
        return _VK_PUNCT[vk][1 if shift else 0]
    return None


class _KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class GlobalScanListener:
    """Слушает сканер глобально. При распознанном скане вызывает on_scan(code)
    из своего потока — колбэк должен быть потокобезопасным (в GUI используем
    очередь + tk.after)."""

    def __init__(self, on_scan, min_len: int = 4, max_gap: float = 0.05):
        self._on_scan = on_scan
        self._min_len = min_len
        self._max_gap = max_gap  # макс. пауза между клавишами внутри одного скана
        self._buf = []
        self._last_t = 0.0
        self._thread = None
        self._hook = None
        self._thread_id = None
        self._proc = None  # держим ссылку на CFUNCTYPE, иначе GC
        self._running = False

    def available(self) -> bool:
        return sys.platform.startswith("win")

    def start(self):
        if not self.available() or self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        tid = self._thread_id
        if tid:
            # разбудить GetMessage, чтобы поток вышел
            ctypes.windll.user32.PostThreadMessageW(tid, 0x0012, 0, 0)  # WM_QUIT

    # ---- внутреннее ----

    def _handle_key(self, vk: int):
        now = time.monotonic()
        if vk == VK_RETURN:
            if self._buf and (now - self._last_t) <= self._max_gap:
                code = "".join(self._buf)
                if len(code) >= self._min_len:
                    try:
                        self._on_scan(code)
                    except Exception:
                        pass
            self._buf = []
            return
        # разрыв во времени -> начало новой последовательности (ручной ввод)
        if now - self._last_t > self._max_gap:
            self._buf = []
        user32 = ctypes.windll.user32
        shift = bool(user32.GetAsyncKeyState(VK_SHIFT) & 0x8000)
        caps = bool(user32.GetKeyState(VK_CAPITAL) & 0x0001)
        ch = _vk_to_char(vk, shift, caps)
        if ch is not None:
            self._buf.append(ch)
            self._last_t = now
        else:
            # неизвестная клавиша внутри кода — не рвём, просто игнорируем символ
            self._last_t = now

    def _run(self):
        user32 = ctypes.windll.user32
        LRESULT = ctypes.c_ssize_t
        LPARAM = ctypes.c_ssize_t
        WPARAM = ctypes.c_size_t
        HHOOK = wintypes.HANDLE
        HOOKPROC = ctypes.CFUNCTYPE(LRESULT, ctypes.c_int, WPARAM, LPARAM)
        # Явные прототипы обязательны: без них ctypes неверно передаёт lParam
        # (получаем OverflowError: int too long to convert).
        user32.CallNextHookEx.restype = LRESULT
        user32.CallNextHookEx.argtypes = [HHOOK, ctypes.c_int, WPARAM, LPARAM]
        user32.SetWindowsHookExW.restype = HHOOK
        user32.SetWindowsHookExW.argtypes = [
            ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD,
        ]
        user32.UnhookWindowsHookEx.argtypes = [HHOOK]
        user32.GetMessageW.argtypes = [
            ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT,
        ]

        def proc(nCode, wParam, lParam):
            if nCode == 0 and wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
                kb = ctypes.cast(lParam, ctypes.POINTER(_KBDLLHOOKSTRUCT)).contents
                try:
                    self._handle_key(kb.vkCode)
                except Exception:
                    pass
            return user32.CallNextHookEx(None, nCode, wParam, lParam)

        self._proc = HOOKPROC(proc)
        self._thread_id = ctypes.windll.kernel32.GetCurrentThreadId()
        self._hook = user32.SetWindowsHookExW(
            WH_KEYBOARD_LL, self._proc, None, 0
        )
        if not self._hook:
            self._running = False
            return
        msg = wintypes.MSG()
        # цикл сообщений нужен, чтобы low-level hook получал события
        while self._running and user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        user32.UnhookWindowsHookEx(self._hook)
        self._hook = None
        self._thread_id = None
