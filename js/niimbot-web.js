(function () {
  'use strict';

  var SERVICE_UUIDS = [
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
  ];
  var WRITE_UUIDS = [
    'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    '0000ff02-0000-1000-8000-00805f9b34fb',
    '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
  ];
  var device = null;
  var characteristic = null;
  var responses = [];
  var waiters = [];
  var receiveBuffer = [];

  function frame(command, data) {
    data = data || new Uint8Array(0);
    var result = new Uint8Array(data.length + 7);
    result[0] = 0x55; result[1] = 0x55; result[2] = command; result[3] = data.length;
    var checksum = command ^ data.length;
    for (var i = 0; i < data.length; i += 1) { result[4 + i] = data[i]; checksum ^= data[i]; }
    result[result.length - 3] = checksum; result[result.length - 2] = 0xaa; result[result.length - 1] = 0xaa;
    return result;
  }

  function onNotify(event) {
    var bytes = new Uint8Array(event.target.value.buffer);
    for (var added = 0; added < bytes.length; added += 1) receiveBuffer.push(bytes[added]);
    while (receiveBuffer.length >= 7) {
      var start = -1;
      for (var scan = 0; scan + 1 < receiveBuffer.length; scan += 1) {
        if (receiveBuffer[scan] === 0x55 && receiveBuffer[scan + 1] === 0x55) { start = scan; break; }
      }
      if (start < 0) { receiveBuffer = []; return; }
      if (start) receiveBuffer.splice(0, start);
      if (receiveBuffer.length < 7) return;
      var length = receiveBuffer[3];
      var frameLength = length + 7;
      if (receiveBuffer.length < frameLength) return;
      var packet = receiveBuffer.splice(0, frameLength);
      if (packet[frameLength - 2] !== 0xaa || packet[frameLength - 1] !== 0xaa) continue;
      var item = { command: packet[2], data: new Uint8Array(packet.slice(4, 4 + length)) };
      var waiterIndex = waiters.findIndex(function (waiter) { return waiter.command === item.command; });
      if (waiterIndex >= 0) {
        var waiter = waiters.splice(waiterIndex, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(item.data);
      } else responses.push(item);
    }
  }

  function response(command, timeout) {
    var index = responses.findIndex(function (item) { return item.command === command; });
    if (index >= 0) return Promise.resolve(responses.splice(index, 1)[0].data);
    return new Promise(function (resolve, reject) {
      var waiter = { command: command, resolve: resolve };
      waiter.timer = setTimeout(function () {
        var position = waiters.indexOf(waiter); if (position >= 0) waiters.splice(position, 1);
        reject(new Error('Принтер не подтвердил команду 0x' + command.toString(16)));
      }, timeout || 3000);
      waiters.push(waiter);
    });
  }

  async function write(bytes) {
    for (var offset = 0; offset < bytes.length; offset += 200) {
      var chunk = bytes.slice(offset, offset + 200);
      if (characteristic.properties.writeWithoutResponse) await characteristic.writeValueWithoutResponse(chunk);
      else await characteristic.writeValue(chunk);
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
  }

  async function request(command, data, responseCommand, timeout) {
    await write(frame(command, data));
    return response(responseCommand, timeout);
  }

  async function connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth недоступен. Откройте сайт в Chrome или Edge.');
    if (characteristic && device && device.gatt.connected) return;
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'B21' }, { namePrefix: 'NIIMBOT' }],
      optionalServices: SERVICE_UUIDS
    });
    var server = await device.gatt.connect();
    var services = await server.getPrimaryServices();
    var candidates = [];
    for (var i = 0; i < services.length; i += 1) {
      var chars = await services[i].getCharacteristics();
      candidates = candidates.concat(chars);
    }
    characteristic = candidates.find(function (item) {
      return WRITE_UUIDS.indexOf(item.uuid.toLowerCase()) >= 0 && (item.properties.write || item.properties.writeWithoutResponse);
    }) ||
      candidates.find(function (item) { return (item.properties.write || item.properties.writeWithoutResponse) && item.properties.notify; }) ||
      candidates.find(function (item) { return item.properties.write || item.properties.writeWithoutResponse; });
    if (!characteristic) throw new Error('Не найден канал печати NIIMBOT.');
    var notifyChannels = candidates.filter(function (item) { return item.properties.notify || item.properties.indicate; });
    if (!notifyChannels.length) throw new Error('Не найден канал ответов NIIMBOT.');
    receiveBuffer = []; responses = [];
    for (var channel of notifyChannels) {
      try {
        await channel.startNotifications();
        channel.addEventListener('characteristicvaluechanged', onNotify);
      } catch (_error) {}
    }
    await write(new Uint8Array([0x03,0x55,0x55,0xc1,0x01,0x01,0xc1,0xaa,0xaa]));
    await request(0xa5, new Uint8Array([1]), 0xb5);
    for (var sub of [0x08,0x0b,0x0d,0x0a,0x07,0x03,0x0c,0x09]) {
      await request(0x40, new Uint8Array([sub]), 0x40 + sub);
    }
    await request(0xdc, new Uint8Array([4]), 0xd9);
  }

  async function rasterize(url) {
    var image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    var canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 240);
    var scale = Math.min(320 / image.naturalHeight, 240 / image.naturalWidth);
    ctx.translate(160, 120); ctx.rotate(-Math.PI / 2);
    ctx.drawImage(image, -image.naturalWidth * scale / 2, -image.naturalHeight * scale / 2,
      image.naturalWidth * scale, image.naturalHeight * scale);
    var pixels = ctx.getImageData(0, 0, 320, 240).data;
    var rows = [];
    for (var y = 0; y < 240; y += 1) {
      var row = new Uint8Array(40);
      for (var x = 0; x < 320; x += 1) {
        var p = (y * 320 + x) * 4;
        var luminance = pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114;
        if (luminance < 145) row[x >> 3] |= 0x80 >> (x & 7);
      }
      rows.push(row);
    }
    return rows;
  }

  function u16(value) { return new Uint8Array([(value >> 8) & 255, value & 255]); }
  function concat(parts) {
    var length = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var out = new Uint8Array(length), offset = 0;
    parts.forEach(function (part) { out.set(part, offset); offset += part.length; });
    return out;
  }

  async function printOne(url) {
    var rows = await rasterize(url);
    await request(0x21, new Uint8Array([3]), 0x31);
    await request(0x23, new Uint8Array([1]), 0x33);
    await request(0x01, new Uint8Array([0,1,0,0,0,0,0]), 0x02);
    await request(0x03, new Uint8Array([1]), 0x04);
    await request(0x13, new Uint8Array([0,240,1,64,0,1]), 0x14);
    for (var y = 0; y < rows.length; y += 1) {
      var row = rows[y];
      if (!row.some(function (value) { return value; })) {
        await write(frame(0x84, new Uint8Array([(y >> 8) & 255, y & 255, 1])));
      } else {
        var black = row.reduce(function (sum, value) {
          var n = value, count = 0; while (n) { count += n & 1; n >>= 1; } return sum + count;
        }, 0);
        await write(frame(0x85, concat([u16(y), new Uint8Array([0, black & 255, black >> 8, 1]), row])));
      }
    }
    await request(0xe3, new Uint8Array([1]), 0xe4);
    var deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      var status = await request(0xa3, new Uint8Array([1]), 0xb3);
      if (status.length >= 2 && ((status[0] << 8) | status[1]) >= 1) break;
      await new Promise(function (resolve) { setTimeout(resolve, 120); });
    }
    await request(0xf3, new Uint8Array([1]), 0xf4);
  }

  window.NiimbotWeb = {
    supported: function () { return Boolean(navigator.bluetooth); },
    printImages: async function (urls, progress) {
      await connect();
      for (var i = 0; i < urls.length; i += 1) {
        if (progress) progress(i + 1, urls.length);
        await printOne(urls[i]);
      }
    }
  };
})();
