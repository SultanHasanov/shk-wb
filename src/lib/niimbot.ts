/**
 * Прямая печать на NIIMBOT по Web Bluetooth.
 *
 * Порт js/niimbot-web.js, потерянного при переезде на React. Обмен с
 * устройством перенесён дословно — номера команд, порядок инициализации,
 * пороги ожидания: это отлаженный протокол, править его вслепую нельзя.
 *
 * Работает только в Chrome и Edge: Safari и Firefox Web Bluetooth не
 * поддерживают. Заголовок Permissions-Policy с `bluetooth=(self)` в vercel.json
 * уже стоит.
 */

/* Web Bluetooth нет в стандартном lib.dom, а тянуть @types/web-bluetooth ради
   одного модуля не стоит: ниже ровно та часть API, которой мы пользуемся. */
type GattCharacteristic = {
  uuid: string;
  properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean; indicate: boolean };
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
};

type BluetoothDevice = {
  gatt: {
    connected: boolean;
    connect(): Promise<{
      getPrimaryServices(): Promise<{ getCharacteristics(): Promise<GattCharacteristic[]> }[]>;
    }>;
  };
};

type BluetoothApi = {
  requestDevice(options: {
    filters: { namePrefix: string }[];
    optionalServices: string[];
  }): Promise<BluetoothDevice>;
};

function bluetooth(): BluetoothApi | undefined {
  return (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
}

const SERVICE_UUIDS = [
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
];
const WRITE_UUIDS = [
  'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  '0000ff02-0000-1000-8000-00805f9b34fb',
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
];

type Waiter = { command: number; resolve: (data: Uint8Array) => void; timer: number };

let device: BluetoothDevice | null = null;
let characteristic: GattCharacteristic | null = null;
let responses: { command: number; data: Uint8Array }[] = [];
let waiters: Waiter[] = [];
let receiveBuffer: number[] = [];

function frame(command: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const result = new Uint8Array(data.length + 7);
  result[0] = 0x55;
  result[1] = 0x55;
  result[2] = command;
  result[3] = data.length;
  let checksum = command ^ data.length;
  for (let i = 0; i < data.length; i += 1) {
    result[4 + i] = data[i];
    checksum ^= data[i];
  }
  result[result.length - 3] = checksum;
  result[result.length - 2] = 0xaa;
  result[result.length - 1] = 0xaa;
  return result;
}

function onNotify(event: Event) {
  const value = (event.target as unknown as { value: DataView }).value;
  const bytes = new Uint8Array(value.buffer);
  for (let added = 0; added < bytes.length; added += 1) receiveBuffer.push(bytes[added]);

  while (receiveBuffer.length >= 7) {
    let start = -1;
    for (let scan = 0; scan + 1 < receiveBuffer.length; scan += 1) {
      if (receiveBuffer[scan] === 0x55 && receiveBuffer[scan + 1] === 0x55) {
        start = scan;
        break;
      }
    }
    if (start < 0) {
      receiveBuffer = [];
      return;
    }
    if (start) receiveBuffer.splice(0, start);
    if (receiveBuffer.length < 7) return;

    const length = receiveBuffer[3];
    const frameLength = length + 7;
    if (receiveBuffer.length < frameLength) return;

    const packet = receiveBuffer.splice(0, frameLength);
    if (packet[frameLength - 2] !== 0xaa || packet[frameLength - 1] !== 0xaa) continue;

    const item = { command: packet[2], data: new Uint8Array(packet.slice(4, 4 + length)) };
    const waiterIndex = waiters.findIndex(waiter => waiter.command === item.command);
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(item.data);
    } else responses.push(item);
  }
}

function response(command: number, timeout = 3000): Promise<Uint8Array> {
  const index = responses.findIndex(item => item.command === command);
  if (index >= 0) return Promise.resolve(responses.splice(index, 1)[0].data);

  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      command,
      resolve,
      timer: window.setTimeout(() => {
        const position = waiters.indexOf(waiter);
        if (position >= 0) waiters.splice(position, 1);
        reject(new Error(`Принтер не подтвердил команду 0x${command.toString(16)}`));
      }, timeout),
    };
    waiters.push(waiter);
  });
}

async function write(bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += 200) {
    const chunk = bytes.slice(offset, offset + 200);
    if (characteristic!.properties.writeWithoutResponse) {
      await characteristic!.writeValueWithoutResponse(chunk);
    } else {
      await characteristic!.writeValue(chunk);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function request(
  command: number,
  data: Uint8Array,
  responseCommand: number,
  timeout?: number,
): Promise<Uint8Array> {
  await write(frame(command, data));
  return response(responseCommand, timeout);
}

async function connect(): Promise<void> {
  const api = bluetooth();
  if (!api) throw new Error('Web Bluetooth недоступен. Откройте сайт в Chrome или Edge.');
  if (characteristic && device && device.gatt.connected) return;

  device = await api.requestDevice({
    filters: [{ namePrefix: 'B21' }, { namePrefix: 'NIIMBOT' }],
    optionalServices: SERVICE_UUIDS,
  });
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();

  let candidates: GattCharacteristic[] = [];
  for (const service of services) {
    candidates = candidates.concat(await service.getCharacteristics());
  }

  characteristic =
    candidates.find(
      item =>
        WRITE_UUIDS.indexOf(item.uuid.toLowerCase()) >= 0 &&
        (item.properties.write || item.properties.writeWithoutResponse),
    ) ||
    candidates.find(
      item =>
        (item.properties.write || item.properties.writeWithoutResponse) && item.properties.notify,
    ) ||
    candidates.find(item => item.properties.write || item.properties.writeWithoutResponse) ||
    null;
  if (!characteristic) throw new Error('Не найден канал печати NIIMBOT.');

  const notifyChannels = candidates.filter(
    item => item.properties.notify || item.properties.indicate,
  );
  if (!notifyChannels.length) throw new Error('Не найден канал ответов NIIMBOT.');

  receiveBuffer = [];
  responses = [];
  for (const channel of notifyChannels) {
    try {
      await channel.startNotifications();
      channel.addEventListener('characteristicvaluechanged', onNotify);
    } catch {
      // Часть каналов уведомления не отдаёт — это норма, нужен хотя бы один.
    }
  }

  await write(new Uint8Array([0x03, 0x55, 0x55, 0xc1, 0x01, 0x01, 0xc1, 0xaa, 0xaa]));
  await request(0xa5, new Uint8Array([1]), 0xb5);
  for (const sub of [0x08, 0x0b, 0x0d, 0x0a, 0x07, 0x03, 0x0c, 0x09]) {
    await request(0x40, new Uint8Array([sub]), 0x40 + sub);
  }
  await request(0xdc, new Uint8Array([4]), 0xd9);
}

/** Картинка разворачивается в монохромный растр 320×240 с поворотом на 90°. */
async function rasterize(url: string): Promise<Uint8Array[]> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 320, 240);

  const scale = Math.min(320 / image.naturalHeight, 240 / image.naturalWidth);
  ctx.translate(160, 120);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(
    image,
    (-image.naturalWidth * scale) / 2,
    (-image.naturalHeight * scale) / 2,
    image.naturalWidth * scale,
    image.naturalHeight * scale,
  );

  const pixels = ctx.getImageData(0, 0, 320, 240).data;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < 240; y += 1) {
    const row = new Uint8Array(40);
    for (let x = 0; x < 320; x += 1) {
      const p = (y * 320 + x) * 4;
      const luminance = pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114;
      if (luminance < 145) row[x >> 3] |= 0x80 >> (x & 7);
    }
    rows.push(row);
  }
  return rows;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 255, value & 255]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function printOne(url: string): Promise<void> {
  const rows = await rasterize(url);
  await request(0x21, new Uint8Array([3]), 0x31);
  await request(0x23, new Uint8Array([1]), 0x33);
  await request(0x01, new Uint8Array([0, 1, 0, 0, 0, 0, 0]), 0x02);
  await request(0x03, new Uint8Array([1]), 0x04);
  await request(0x13, new Uint8Array([0, 240, 1, 64, 0, 1]), 0x14);

  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    if (!row.some(value => value)) {
      await write(frame(0x84, new Uint8Array([(y >> 8) & 255, y & 255, 1])));
    } else {
      const black = row.reduce((sum, value) => {
        let n = value;
        let count = 0;
        while (n) {
          count += n & 1;
          n >>= 1;
        }
        return sum + count;
      }, 0);
      await write(frame(0x85, concat([u16(y), new Uint8Array([0, black & 255, black >> 8, 1]), row])));
    }
  }

  await request(0xe3, new Uint8Array([1]), 0xe4);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const status = await request(0xa3, new Uint8Array([1]), 0xb3);
    if (status.length >= 2 && ((status[0] << 8) | status[1]) >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  await request(0xf3, new Uint8Array([1]), 0xf4);
}

export function niimbotSupported(): boolean {
  return Boolean(bluetooth());
}

export async function printOnNiimbot(
  urls: readonly string[],
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  await connect();
  for (let i = 0; i < urls.length; i += 1) {
    onProgress?.(i + 1, urls.length);
    await printOne(urls[i]);
  }
}
