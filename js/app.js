(function () {
  'use strict';

  var input = document.getElementById('code');
  var errorEl = document.getElementById('error');
  var genBtn = document.getElementById('generate');
  var dlBtn = document.getElementById('download');
  var shareBtn = document.getElementById('share');
  var canvas = document.getElementById('sticker');
  var ctx = canvas.getContext('2d');

  var W = canvas.width;
  var H = canvas.height;
  var lastCode = '';

  var VERHOEFF_MUL = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];
  var VERHOEFF_PERM = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];
  var VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

  function verhoeffDigit(numStr) {
    var c = 0;
    for (var i = 0; i < numStr.length; i++) {
      var digit = numStr.charCodeAt(numStr.length - 1 - i) - 48;
      c = VERHOEFF_MUL[c][VERHOEFF_PERM[(i + 1) % 8][digit]];
    }
    return VERHOEFF_INV[c];
  }

  // WB QR payload: 5-byte big-endian number plus one packed BCD byte with
  // Verhoeff(prefix) and Verhoeff(last 6 digits).
  function wbEncode(numStr) {
    var n = Number(numStr);
    if (!isFinite(n) || n < 0) return null;

    var prefix = numStr.slice(0, -6);
    var suffix = numStr.slice(-6);
    var checkByte = (verhoeffDigit(prefix) << 4) | verhoeffDigit(suffix);
    var bytes = [
      Math.floor(n / 4294967296) % 256,
      Math.floor(n / 16777216) % 256,
      Math.floor(n / 65536) % 256,
      Math.floor(n / 256) % 256,
      n % 256,
      checkByte
    ];

    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return '*' + btoa(bin);
  }

  function makeRng(seedStr) {
    var seed = 0;
    for (var i = 0; i < seedStr.length; i++) {
      seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    }
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Decorative corner blocks. They stay visually close to WB stickers, but do
  // not expose another clean matrix code that a scanner can prefer over the QR.
  function drawCornerMatrix(x, y, size, rng) {
    var n = 12;
    var cell = size / n;
    ctx.fillStyle = '#000';

    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var on;

        if (c === 0 || c === n - 1 || r === 0 || r === n - 1) {
          on = rng() > 0.28;
        } else if ((r < 3 && c < 3) || (r > n - 4 && c > n - 4)) {
          on = false;
        } else {
          on = rng() > 0.5;
        }

        if ((r === 1 && c === 1) || (r === n - 2 && c === n - 2)) {
          on = true;
        }

        if (on) ctx.fillRect(x + c * cell, y + r * cell, cell + 0.4, cell + 0.4);
      }
    }
  }

  // Decorative side stripes. They look barcode-like, but include tiny cuts so
  // scanner apps do not lock onto them instead of the central QR payload.
  function drawSideStripes(x, y, w, h, rng) {
    ctx.fillStyle = '#000';
    var pos = 0;

    while (pos < w - 1) {
      var bar = 1 + Math.floor(rng() * 3);
      var gap = 1 + Math.floor(rng() * 3);
      if (pos + bar > w) bar = w - pos;
      ctx.fillRect(x + pos, y, bar, h);
      pos += bar + gap;
    }

    ctx.fillStyle = '#fff';
    for (var cut = y + 18; cut < y + h - 10; cut += 52) {
      ctx.fillRect(x, cut, w, 2);
    }
  }

  function buildQrCanvas(text, px) {
    var holder = document.createElement('div');
    holder.style.display = 'none';
    document.body.appendChild(holder);
    new QRCode(holder, {
      text: text,
      width: px,
      height: px,
      correctLevel: QRCode.CorrectLevel.M
    });
    var qrCanvas = holder.querySelector('canvas');
    document.body.removeChild(holder);
    return qrCanvas;
  }

  function render() {
    var code = input.value.trim();
    if (!code) {
      input.classList.add('invalid');
      errorEl.textContent = 'Введите номер ШК.';
      return;
    }
    if (!/^\d+$/.test(code)) {
      input.classList.add('invalid');
      errorEl.textContent = 'Номер ШК — только цифры.';
      return;
    }

    var qrText = wbEncode(code);
    input.classList.remove('invalid');
    errorEl.textContent = '';

    var rng = makeRng(qrText);

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#cb11ab';
    ctx.font = '800 88px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WB', W / 2, 70);

    var cm = 96;
    drawCornerMatrix(40, 18, cm, rng);
    drawCornerMatrix(W - 40 - cm, 18, cm, rng);
    drawCornerMatrix(40, 540, cm, rng);
    drawCornerMatrix(W - 40 - cm, 540, cm, rng);

    var qrSize = 300;
    var qrQuiet = 24;
    var qrInnerSize = qrSize - qrQuiet * 2;
    var qrX = (W - qrSize) / 2;
    var qrY = 160;
    var qr = buildQrCanvas(qrText, qrInnerSize);

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(qrX, qrY, qrSize, qrSize);
    ctx.drawImage(qr, qrX + qrQuiet, qrY + qrQuiet, qrInnerSize, qrInnerSize);

    var stripeY = qrY - 10;
    var stripeH = qrSize + 20;
    var stripeW = 46;
    drawSideStripes(qrX - 14 - stripeW, stripeY, stripeW, stripeH, makeRng(code + 'L'));
    drawSideStripes(qrX + qrSize + 14, stripeY, stripeW, stripeH, makeRng(code + 'R'));

    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    var line1 = code;
    var line2 = '';
    if (code.length > 7) {
      line1 = code.slice(0, code.length - 4);
      line2 = code.slice(code.length - 4);
    }

    if (line2) {
      ctx.font = '800 64px "Courier New", monospace';
      ctx.fillText(line1, W / 2, 650);
      ctx.font = '800 88px "Courier New", monospace';
      ctx.fillText(line2, W / 2, 725);
    } else {
      ctx.font = '800 80px "Courier New", monospace';
      ctx.fillText(line1, W / 2, 700);
    }

    lastCode = code;
    dlBtn.disabled = false;
    shareBtn.disabled = false;
  }

  function download() {
    if (!lastCode) return;
    var a = document.createElement('a');
    a.download = 'wb-sticker-' + lastCode + '.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  function share() {
    if (!lastCode) return;
    var fileName = 'wb-sticker-' + lastCode + '.png';
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({
          files: [file],
          title: 'Стикер WB ' + lastCode,
          text: 'ШК: ' + lastCode
        }).catch(function () {});
      } else {
        errorEl.textContent = 'Браузер не поддерживает «Поделиться» — файл скачан.';
        download();
      }
    }, 'image/png');
  }

  genBtn.addEventListener('click', render);
  dlBtn.addEventListener('click', download);
  shareBtn.addEventListener('click', share);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') render();
  });
})();
