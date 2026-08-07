"""
Печать этикеток с номером ячейки на термопринтере NIIMBOT (B21 / B21S).

Модуль самодостаточный: рендер этикетки (Pillow), реализация бинарного
протокола NIIMBOT и BLE-транспорт (bleak). GUI зовёт только публичный API:

    list_printers()                          -> list[Device]   (сканирование BLE)
    print_cell_label(address, cell, settings, log=...)         (печать, блокирующая)
    render_cell_label(cell, ...)             -> PIL.Image       (для фолбэка «Сохранить PNG»)

Протокол портирован из открытой библиотеки niimprint
(https://github.com/AndBondStyle/niimprint), MIT.

Абстракция транспорта (`_Transport`) позволяет позже добавить проводной
принтер (USB/COM) без изменения слоёв рендера и протокола.
"""

import asyncio
import math
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

# --- необязательные зависимости, чтобы модуль импортировался даже без них ---
try:
    from PIL import Image, ImageDraw, ImageFont
    _HAS_PIL = True
except Exception:  # pragma: no cover
    _HAS_PIL = False

try:
    from bleak import BleakClient, BleakScanner
    _HAS_BLEAK = True
except Exception:  # pragma: no cover
    _HAS_BLEAK = False


def bleak_available() -> bool:
    return _HAS_BLEAK


def pil_available() -> bool:
    return _HAS_PIL


# NIIMBOT-принтеры используют «прозрачный» UART-сервис Nordic (NUS-подобный).
# Запись — в RX-характеристику, уведомления — из TX. У разных моделей строка
# сервиса может отличаться, поэтому write-характеристику ищем по свойствам.
# Основной канал данных B21/B21S — характеристика с read+write+notify в
# сервисе e7810a71-… Именно она принимает команды печати.
_WRITE_UUID_CANDIDATES = [
    "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
    "0000ff02-0000-1000-8000-00805f9b34fb",
    "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
]


@dataclass
class Device:
    name: str
    address: str


@dataclass
class LabelSettings:
    """Настройки этикетки. Размеры в мм, dpi термоголовки B21S = 203."""
    width_mm: float = 40.0
    height_mm: float = 30.0
    dpi: int = 203
    density: int = 3          # 1..5, плотность нагрева
    label_type: int = 1       # 1 — этикетка с зазором (gap)
    caption: str = ""          # пусто: печатаем только крупный номер

    def px(self, mm: float) -> int:
        return int(round(mm / 25.4 * self.dpi))


# =====================================================================
#  Слой 1. Рендер этикетки
# =====================================================================

def _load_bold_font(size: int):
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text_size(draw, text, font):
    try:
        l, t, r, b = draw.textbbox((0, 0), text, font=font)
        return r - l, b - t, l, t
    except Exception:  # старые Pillow
        w, h = draw.textsize(text, font=font)
        return w, h, 0, 0


def render_cell_label(cell_number: str, settings: Optional[LabelSettings] = None):
    """Построить монохромное (1-bit) изображение этикетки: крупный номер
    ячейки по центру, сверху — мелкая подпись. Возвращает PIL.Image('1')."""
    if not _HAS_PIL:
        raise RuntimeError("Не установлен Pillow — рендер этикетки недоступен.")
    settings = settings or LabelSettings()

    w = settings.px(settings.width_mm)
    h = settings.px(settings.height_mm)
    img = Image.new("1", (w, h), 1)  # 1 = белый
    draw = ImageDraw.Draw(img)

    text = str(cell_number).strip() or "?"
    caption = (settings.caption or "").strip()

    margin = max(int(w * 0.06), 6)
    cap_h = 0
    if caption:
        cap_font = _load_bold_font(max(int(h * 0.16), 12))
        cw, ch, cl, ct = _text_size(draw, caption, cap_font)
        draw.text(((w - cw) / 2 - cl, margin - ct), caption, font=cap_font, fill=0)
        cap_h = ch + margin

    # подбор размера крупного шрифта под доступную область
    avail_w = w - 2 * margin
    avail_h = h - cap_h - 2 * margin
    size = max(avail_h, 10)
    font = _load_bold_font(size)
    tw, th, tl, tt = _text_size(draw, text, font)
    while (tw > avail_w or th > avail_h) and size > 10:
        size -= 2
        font = _load_bold_font(size)
        tw, th, tl, tt = _text_size(draw, text, font)

    x = (w - tw) / 2 - tl
    y = cap_h + (avail_h - th) / 2 + margin - tt
    draw.text((x, y), text, font=font, fill=0)
    return img


def _image_to_rows(img) -> List[bytes]:
    """Разбить изображение на строки битов (MSB-first), чёрный пиксель = 1."""
    img = img.convert("1")
    w, h = img.size
    px = img.load()
    row_bytes = math.ceil(w / 8)
    rows = []
    for y in range(h):
        buf = bytearray(row_bytes)
        for x in range(w):
            if px[x, y] == 0:  # чёрный
                buf[x // 8] |= 0x80 >> (x % 8)
        rows.append(bytes(buf))
    return rows


# =====================================================================
#  Слой 2. Протокол NIIMBOT
# =====================================================================

class _Packet:
    def __init__(self, cmd: int, data: bytes):
        self.cmd = cmd
        self.data = data

    def to_bytes(self) -> bytes:
        checksum = self.cmd ^ len(self.data)
        for b in self.data:
            checksum ^= b
        return bytes([0x55, 0x55, self.cmd, len(self.data)]) + self.data + \
            bytes([checksum, 0xAA, 0xAA])


def _row_counts(row: bytes, width: int):
    """Три байта заголовка строки — количество чёрных пикселей в позициях
    x%3 == 0/1/2. B21S по этим счётчикам решает, что строку надо прожигать
    (нули трактует как пустую строку → лента выходит чистой)."""
    counts = [0, 0, 0]
    for x in range(width):
        if row[x // 8] & (0x80 >> (x % 8)):
            counts[x % 3] += 1
    return bytes([min(c, 255) for c in counts])


def _encode_page(rows: List[bytes], width: int) -> List[_Packet]:
    """Сжать одинаковые строки RLE; пустые передать короткой командой 0x84."""
    packets = []
    line_bytes = math.ceil(width / 8)
    y = 0
    while y < len(rows):
        line = rows[y][:line_bytes]
        run = 1
        while (y + run < len(rows) and run < 200 and
               rows[y + run][:line_bytes] == line):
            run += 1

        if not any(line):
            packets.append(_Packet(0x84, struct.pack(">HB", y, run)))
            y += run
            continue

        # B21/B21S use the "total" bitmap-row format.  The three bytes after
        # the row number are 00 + a little-endian 16-bit count of all black
        # pixels, not three counters for x % 3.  The latter is accepted as a
        # frame but produces a blank label on recent B21S firmware.
        # bin(...).count works on the old Python bundled in the Windows 7 build.
        black = sum(bin(b).count("1") for b in line)
        header = struct.pack(">H", y) + bytes([0, black & 0xFF, black >> 8, run])
        packets.append(_Packet(0x85, header + line))
        y += run
    return packets


class NiimbotProtocol:
    """Формирует последовательность пакетов для печати одной этикетки."""

    def __init__(self, settings: LabelSettings):
        self.s = settings

    def build_print_sequence(self, img) -> List[_Packet]:
        rows = _image_to_rows(img)
        w, h = img.size
        pkts: List[_Packet] = []
        pkts.append(_Packet(0x21, bytes([self.s.density])))          # set density
        pkts.append(_Packet(0x23, bytes([self.s.label_type])))       # set label type
        # Protocol-3 (B21/B21S) declares the number of pages in a 7-byte
        # PrintStart payload.
        pkts.append(_Packet(0x01, b"\x00\x01\x00\x00\x00\x00\x00"))
        pkts.append(_Packet(0x03, b"\x01"))                          # start page
        # rows (feed axis), columns (printhead axis), copies
        pkts.append(_Packet(0x13, struct.pack(">HHH", h, w, 1)))
        # set_quantity (0x15) для B21/B21S не нужен и мешает — не отправляем.
        pkts.extend(_encode_page(rows, w))                           # bitmap + RLE
        pkts.append(_Packet(0xE3, b"\x01"))                          # end page
        pkts.append(_Packet(0xF3, b"\x01"))                          # end print
        return pkts


# =====================================================================
#  Слой 3. Транспорт (BLE) + управление asyncio-циклом в фоне
# =====================================================================

class _Transport:
    """Базовый транспорт. Проводной вариант реализуется отдельным подклассом."""
    def send(self, data: bytes) -> None:
        raise NotImplementedError

    def close(self) -> None:
        pass


class _BLELoop:
    """Единый фоновый event loop для всей BLE-работы (у Tkinter — свой цикл)."""
    _instance: Optional["_BLELoop"] = None
    _lock = threading.Lock()

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run(self, coro, timeout=None):
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout)

    @classmethod
    def get(cls) -> "_BLELoop":
        with cls._lock:
            if cls._instance is None:
                cls._instance = _BLELoop()
            return cls._instance


def list_printers(timeout: float = 6.0, name_prefixes=("B21", "B1", "B3", "D11", "NIIMBOT")) -> List[Device]:
    """Сканировать BLE и вернуть похожие на NIIMBOT устройства."""
    if not _HAS_BLEAK:
        raise RuntimeError("Не установлен пакет bleak — печать по Bluetooth недоступна.")

    async def _scan():
        found = await BleakScanner.discover(timeout=timeout)
        devs = []
        for d in found:
            name = d.name or ""
            if any(name.upper().startswith(p.upper()) for p in name_prefixes):
                devs.append(Device(name=name, address=d.address))
        return devs

    return _BLELoop.get().run(_scan(), timeout=timeout + 10)


class _BLETransport(_Transport):
    def __init__(self, address: str, connect_timeout: float = 20.0):
        self._loop = _BLELoop.get()
        self._client = BleakClient(address, timeout=connect_timeout)
        self._write_uuid: Optional[str] = None
        self._rx = bytearray()
        self._responses = []
        self._rx_condition = threading.Condition()
        self._loop.run(self._connect(), timeout=connect_timeout + 10)

    def _on_notify(self, _handle, data):
        with self._rx_condition:
            self._rx.extend(data)
            while len(self._rx) >= 7:
                start = self._rx.find(b"\x55\x55")
                if start < 0:
                    self._rx.clear()
                    break
                if start:
                    del self._rx[:start]
                if len(self._rx) < 7:
                    break
                size = self._rx[3] + 7
                if len(self._rx) < size:
                    break
                frame = bytes(self._rx[:size])
                del self._rx[:size]
                if frame[-2:] == b"\xaa\xaa":
                    self._responses.append((frame[2], frame[4:-3]))
            self._rx_condition.notify_all()

    async def _connect(self):
        await self._client.connect()
        # Ищем канал данных так: 1) точное совпадение с известным UUID;
        # 2) характеристика с write И notify (у NIIMBOT это боевой канал);
        # 3) любая пишущая — как крайний фолбэк.
        by_uuid = None
        write_notify = None
        any_write = None
        for service in self._client.services:
            for ch in service.characteristics:
                props = ch.properties
                writable = "write" in props or "write-without-response" in props
                if not writable:
                    continue
                if ch.uuid.lower() in _WRITE_UUID_CANDIDATES and by_uuid is None:
                    by_uuid = ch.uuid
                if "notify" in props and write_notify is None:
                    write_notify = ch.uuid
                if any_write is None:
                    any_write = ch.uuid
        chosen = by_uuid or write_notify or any_write
        if chosen is None:
            raise RuntimeError("У принтера не найдена характеристика для записи.")
        self._write_uuid = chosen
        # подписываемся на уведомления — принтер шлёт подтверждения команд
        try:
            if "notify" in self._client.services.get_characteristic(chosen).properties:
                await self._client.start_notify(chosen, self._on_notify)
        except Exception:
            pass

        await self._client.write_gatt_char(
            self._write_uuid,
            b"\x03\x55\x55\xc1\x01\x01\xc1\xaa\xaa",
            response=False,
        )
        await asyncio.sleep(0.05)

    def send(self, data: bytes) -> None:
        async def _w():
            # Канал NIIMBOT имеет тип WRITE_NO_RESPONSE; поток регулируется
            # короткой паузой между записями.
            chunk = 200
            if len(data) <= chunk:
                await self._client.write_gatt_char(self._write_uuid, data, response=False)
            else:
                for i in range(0, len(data), chunk):
                    await self._client.write_gatt_char(
                        self._write_uuid, data[i:i + chunk], response=False
                    )
                    await asyncio.sleep(0.01)
        self._loop.run(_w(), timeout=30)

    def wait_response(self, cmd: int, timeout: float = 2.0) -> bytes:
        deadline = time.monotonic() + timeout
        with self._rx_condition:
            while True:
                for i, (response_cmd, data) in enumerate(self._responses):
                    if response_cmd == cmd:
                        self._responses.pop(i)
                        return data
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"Принтер не подтвердил команду 0x{cmd:02X}")
                self._rx_condition.wait(remaining)

    def request(self, packet: _Packet, response_cmd: int, timeout: float = 2.0) -> bytes:
        self.send(packet.to_bytes())
        return self.wait_response(response_cmd, timeout)

    def close(self) -> None:
        try:
            self._loop.run(self._client.disconnect(), timeout=10)
        except Exception:
            pass


# Одно соединение на серию сканирований. Повторное BLE-подключение и handshake
# занимают заметно больше времени, чем передача простой этикетки с номером.
_shared_transport: Optional[_BLETransport] = None
_shared_address: Optional[str] = None
_print_lock = threading.Lock()


def _get_shared_transport(address: str):
    global _shared_transport, _shared_address
    if (_shared_transport is not None and _shared_address == address and
            _shared_transport._client.is_connected):
        return _shared_transport, False
    if _shared_transport is not None:
        _shared_transport.close()
    _shared_transport = _BLETransport(address)
    _shared_address = address
    return _shared_transport, True


def _drop_shared_transport():
    global _shared_transport, _shared_address
    if _shared_transport is not None:
        _shared_transport.close()
    _shared_transport = None
    _shared_address = None


# =====================================================================
#  Публичный API печати
# =====================================================================

def print_cell_label(
    address: str,
    cell_number: str,
    settings: Optional[LabelSettings] = None,
    log: Optional[Callable[[str], None]] = None,
) -> None:
    """Отрендерить этикетку с номером ячейки и напечатать на BLE-принтере.
    Блокирующая — вызывать из рабочего потока."""
    settings = settings or LabelSettings()
    _log = log or (lambda m: None)

    if not _HAS_BLEAK:
        raise RuntimeError("Не установлен пакет bleak — печать по Bluetooth недоступна.")

    _log(f"Готовлю этикетку для ячейки {cell_number}...")
    img = render_cell_label(cell_number, settings)
    packets = NiimbotProtocol(settings).build_print_sequence(img)

    with _print_lock:
      try:
        transport, is_new_connection = _get_shared_transport(address)
        if is_new_connection:
            _log("Подключаюсь к принтеру...")
        else:
            _log("Использую активное подключение к принтеру...")
        _log("Печатаю...")
        # Обязательная инициализация protocol-3. Без неё B21/B21S может
        # принимать команды и протягивать этикетку, но не включать головку.
        if is_new_connection:
            transport.request(_Packet(0xA5, b"\x01"), 0xB5)
            for sub in (0x08, 0x0B, 0x0D, 0x0A, 0x07, 0x03, 0x0C, 0x09):
                transport.request(_Packet(0x40, bytes([sub])), 0x40 + sub)
            transport.request(_Packet(0xDC, b"\x04"), 0xD9)

        response_for = {0x21: 0x31, 0x23: 0x33, 0x01: 0x02,
                        0x03: 0x04, 0x13: 0x14, 0xE3: 0xE4}
        index = 0
        while index < len(packets):
            pkt = packets[index]
            if pkt.cmd in (0x84, 0x85):
                # Несколько полных protocol frames в одной BLE-записи. B21S
                # сам разбирает поток, а число обязательных пауз уменьшается.
                bundle = bytearray()
                while index < len(packets) and packets[index].cmd in (0x84, 0x85):
                    frame = packets[index].to_bytes()
                    if bundle and len(bundle) + len(frame) > 200:
                        break
                    bundle.extend(frame)
                    index += 1
                transport.send(bytes(bundle))
                time.sleep(0.01)
                continue
            elif pkt.cmd == 0xF3:
                # Do not end the job until the printer reports that page 1 is
                # complete; ending immediately can discard the bitmap.
                deadline = time.monotonic() + 25.0
                while True:
                    status = transport.request(_Packet(0xA3, b"\x01"), 0xB3)
                    if len(status) >= 2 and int.from_bytes(status[:2], "big") >= 1:
                        break
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Принтер не завершил печать этикетки")
                    time.sleep(0.1)
                transport.request(pkt, 0xF4)
            else:
                transport.request(pkt, response_for[pkt.cmd])
            index += 1
        _log("Этикетка отправлена на печать.")
      except Exception:
        # Разорванное соединение не должно оставаться в кэше: следующий скан
        # автоматически создаст новое.
        _drop_shared_transport()
        raise
