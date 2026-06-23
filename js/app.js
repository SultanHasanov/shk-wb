(function () {
  'use strict';

  var input = document.getElementById('code');
  var errorEl = document.getElementById('error');
  var genBtn = document.getElementById('generate');
  var dlBtn = document.getElementById('download');
  var canvas = document.getElementById('sticker');
  var ctx = canvas.getContext('2d');

  var W = canvas.width;   // 600
  var H = canvas.height;  // 740
  var lastCode = '';

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

  // Вертикальный штрихкод Code128.
  function buildBarcodeCanvas(text) {
    var bc = document.createElement('canvas');
    try {
      JsBarcode(bc, text, {
        format: 'CODE128',
        width: 2,
        height: 380,
        displayValue: false,
        margin: 0,
        background: '#ffffff'
      });
    } catch (e) {
      return null;
    }
    return bc;
  }

  function render() {
    var code = input.value.trim();
    if (!code) {
      input.classList.add('invalid');
      errorEl.textContent = 'Введите номер ШК.';
      return;
    }
    if (!/^[0-9A-Za-z\-]+$/.test(code)) {
      input.classList.add('invalid');
      errorEl.textContent = 'Допустимы цифры, латинские буквы и дефис.';
      return;
    }
    input.classList.remove('invalid');
    errorEl.textContent = '';

    var rng = makeRng(code);

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
    var qr = buildQrCanvas(code, qrSize);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

    // --- Боковые вертикальные штрихкоды ---
    var bc = buildBarcodeCanvas(code);
    if (bc) {
      var bw = 60;            // ширина полосы на стикере
      var bh = qrSize + 20;   // высота вдоль QR
      var cy = qrY + qrSize / 2;
      // левый
      ctx.save();
      ctx.translate(qrX - 24, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(bc, -bh / 2, -bw / 2, bh, bw);
      ctx.restore();
      // правый
      ctx.save();
      ctx.translate(qrX + qrSize + 24, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(bc, -bh / 2, -bw / 2, bh, bw);
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
  }

  function download() {
    if (!lastCode) return;
    var a = document.createElement('a');
    a.download = 'wb-sticker-' + lastCode + '.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  genBtn.addEventListener('click', render);
  dlBtn.addEventListener('click', download);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') render();
  });

})();
