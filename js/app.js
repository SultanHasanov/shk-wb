(function () {
  'use strict';

  var input = document.getElementById('code');
  var errorEl = document.getElementById('error');
  var genBtn = document.getElementById('generate');
  var dlBtn = document.getElementById('download');
  var shareBtn = document.getElementById('share');
  var canvas = document.getElementById('sticker');
  var ctx = canvas.getContext('2d');

  var W = canvas.width;   // 600
  var H = canvas.height;  // 740
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

  // Кодирование номера ШК в строку QR формата WB: "*" + base64(5 байт BE + 0x00).

  // WB: 5-byte big-endian number plus one BCD byte packed from
  // Verhoeff(prefix) and Verhoeff(suffix), where suffix is the last 6 digits.
  function wbEncode(numStr) {
    var n = Number(numStr);
    if (!isFinite(n) || n < 0) return null;
    var prefix = numStr.slice(0, -6);
    var suffix = numStr.slice(-6);
    var checkByte = (verhoeffDigit(prefix) << 4) | verhoeffDigit(suffix);
    var bytes = [
      Math.floor(n / 4294967296) % 256, // >>32
      Math.floor(n / 16777216) % 256,   // >>24
      Math.floor(n / 65536) % 256,      // >>16
      Math.floor(n / 256) % 256,        // >>8
      n % 256,
      checkByte
    ];
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return '*' + btoa(bin);
  }

  // Детерминированный PRNG (mulberry32) — узор углов одинаков для одного номера.
  function makeRng(seedStr) {
    var seed = 0;
    for (var i = 0; i < seedStr.length; i++) {
      seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    }
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Декоративный DataMatrix-подобный квадрат.
  function drawCornerMatrix(x, y, size, rng) {
    var n = 12;
    var cell = size / n;
    ctx.fillStyle = '#000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var on;
        if (c === 0 || r === n - 1) {
          on = true;                       // сплошные L-границы
        } else if (r === 0) {
          on = c % 2 === 0;                // верхняя пунктирная
        } else if (c === n - 1) {
          on = r % 2 === 0;                // правая пунктирная
        } else {
          on = rng() > 0.5;               // случайные данные
        }
        if (on) ctx.fillRect(x + c * cell, y + r * cell, cell + 0.6, cell + 0.6);
      }
    }
  }

  // Настоящий вертикальный Code128 с числовым ШК (как на оригинале WB).
  function buildBarcodeCanvas(text, thickness) {
    var bc = document.createElement('canvas');
    try {
      JsBarcode(bc, text, {
        format: 'CODE128',
        width: 3,            // ширина модуля — крупно, чтобы сканер читал
        height: thickness,
        displayValue: false,
        margin: 0,
        background: '#ffffff'
      });
    } catch (e) {
      return null;
    }
    return bc;
  }

  // QR через qrcodejs -> возвращает canvas.
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
    var code = input.value.trim();  // номер ШК (печатается снизу)
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
    // Код для QR/штрихкода вычисляем из номера ШК по алгоритму WB ("*" + base64).
    var qrText = wbEncode(code);
    input.classList.remove('invalid');
    errorEl.textContent = '';

    var rng = makeRng(qrText);

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    // --- Логотип WB сверху по центру ---
    ctx.fillStyle = '#cb11ab';
    ctx.font = '800 88px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WB', W / 2, 70);

    // --- Угловые матрицы ---
    var cm = 96;
    drawCornerMatrix(40, 18, cm, rng);            // верх-лево
    drawCornerMatrix(W - 40 - cm, 18, cm, rng);   // верх-право
    drawCornerMatrix(40, 540, cm, rng);           // низ-лево
    drawCornerMatrix(W - 40 - cm, 540, cm, rng);  // низ-право

    // --- Центральный QR ---
    var qrSize = 300;
    var qrX = (W - qrSize) / 2;
    var qrY = 160;
    var qr = buildQrCanvas(qrText, qrSize);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

    // --- Боковые настоящие штрихкоды (Code128 числового ШК), вертикально ---
    var bc = buildBarcodeCanvas(code, 46);
    if (bc) {
      var cy = qrY + qrSize / 2;
      var len = qrSize + 20;            // длина вдоль QR
      var thick = 46;                   // толщина полосы
      ctx.imageSmoothingEnabled = false;
      // левый
      ctx.save();
      ctx.translate(qrX - 14 - thick / 2, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(bc, -len / 2, -thick / 2, len, thick);
      ctx.restore();
      // правый
      ctx.save();
      ctx.translate(qrX + qrSize + 14 + thick / 2, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(bc, -len / 2, -thick / 2, len, thick);
      ctx.restore();
    }

    // --- Номер снизу (перенос длинного на 2 строки) ---
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var line1 = code, line2 = '';
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
      // Web Share API с файлами (мобильные браузеры).
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({
          files: [file],
          title: 'Стикер WB ' + lastCode,
          text: 'ШК: ' + lastCode
        }).catch(function () {});
      } else {
        // Фолбэк: если делиться файлом нельзя — просто скачиваем.
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
