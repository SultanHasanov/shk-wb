const crypto = require('crypto');
const QRCode = require('qrcode');
const { isClientQrText } = require('./_wb-code');

const VERHOEFF_MUL = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],
  [2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
];
const VERHOEFF_PERM = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],
  [5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
const VERHOEFF_INV = [0,4,3,2,1,5,6,7,8,9];

function verhoeffDigit(value) {
  let checksum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const digit = value.charCodeAt(value.length - 1 - index) - 48;
    checksum = VERHOEFF_MUL[checksum][VERHOEFF_PERM[(index + 1) % 8][digit]];
  }
  return VERHOEFF_INV[checksum];
}

function encodeWbPayload(code) {
  const normalized = String(code);
  if (!/^\d{1,12}$/.test(normalized)) throw new Error('Invalid sticker code');
  const value = BigInt(normalized);
  if (value > 1099511627775n) throw new Error('Sticker code does not fit into 5 bytes');
  const prefix = normalized.slice(0, -6);
  const suffix = normalized.slice(-6);
  const bytes = Buffer.alloc(6);
  let remainder = value;
  for (let index = 4; index >= 0; index -= 1) {
    bytes[index] = Number(remainder & 255n);
    remainder >>= 8n;
  }
  bytes[5] = (verhoeffDigit(prefix) << 4) | verhoeffDigit(suffix);
  return `*${bytes.toString('base64')}`;
}

function requesterHash(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const source = forwarded || req.socket?.remoteAddress || 'unknown';
  const secret = process.env.STICKER_CLIENT_SECRET;
  if (!secret) throw new Error('STICKER_CLIENT_SECRET is not configured');
  return crypto.createHmac('sha256', secret).update(source).digest('hex');
}

async function qrPng(code, width = 700, margin = 3) {
  return QRCode.toBuffer(encodeWbPayload(code), {
    type: 'png', width, margin, errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/** «Голый» QR из строки кода клиента (без рамки WB) для бота. */
async function clientQrPng(text, width = 600, margin = 4) {
  if (!isClientQrText(text)) throw new Error('Invalid client QR text');
  return QRCode.toBuffer(String(text), {
    type: 'png', width, margin, errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

async function qrTextPng(value, width = 700, margin = 3) {
  const text=String(value || '');
  if (!/^[A-Z0-9_-]{2,24}$/.test(text)) throw new Error('Invalid QR text');
  return QRCode.toBuffer(text, { type:'png', width, margin, errorCorrectionLevel:'M', color:{dark:'#000000',light:'#ffffff'} });
}

function splitCode(code) {
  const text = String(code);
  return text.length > 7 ? [text.slice(0, -4), text.slice(-4)] : [text, ''];
}

// Code 128 patterns, expressed as alternating black/white module widths. The
// new WB label uses a compact vertical linear barcode alongside the main QR.
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212',
  '112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321',
  '112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212',
  '124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112',
];

function code128Values(value) {
  const text = String(value);
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('Invalid Code 128 value');
  let start = 104;
  let data;
  if (/^\d+$/.test(text) && text.length >= 4) {
    if (text.length % 2 === 0) {
      start = 105;
      data = text.match(/\d{2}/g).map(Number);
    } else {
      // One digit in set B, then switch to the denser set C for digit pairs.
      data = [text.charCodeAt(0) - 32, 99, ...text.slice(1).match(/\d{2}/g).map(Number)];
    }
  } else data = [...text].map(char => char.charCodeAt(0) - 32);
  const checksum = (start + data.reduce((sum, item, index) => sum + item * (index + 1), 0)) % 103;
  return [start, ...data, checksum, 106];
}

function code128Bars(value) {
  const widths = code128Values(value).flatMap(index => [...CODE128_PATTERNS[index]].map(Number));
  const bars = [];
  let module = 0;
  widths.forEach((width, index) => {
    if (index % 2 === 0) bars.push({ module, width });
    module += width;
  });
  return { bars, modules: module };
}

function newStickerDesign(code) {
  const normalized = String(code);
  if (!/^\d{1,12}$/.test(normalized)) throw new Error('Invalid sticker code');
  return {
    payload: encodeWbPayload(normalized),
    width: 600,
    height: 600,
    qr: { x: 125, y: 8, size: 463 },
    cornerSize: 92,
    corners: [{ x: 10, y: 10 }, { x: 10, y: 498 }, { x: 498, y: 498 }],
    barcode: { x: 10, y: 125, width: 92, height: 330, ...code128Bars(normalized) },
    codeParts: splitCode(normalized),
  };
}

async function newStickerSvg(code) {
  const design = newStickerDesign(code);
  const [largeQr, smallQr] = await Promise.all([
    QRCode.toString(design.payload, { type: 'svg', width: design.qr.size, margin: 0, errorCorrectionLevel: 'M' }),
    QRCode.toString(design.payload, { type: 'svg', width: design.cornerSize, margin: 1, errorCorrectionLevel: 'M' }),
  ]);
  const largeQrBase64 = Buffer.from(largeQr).toString('base64');
  const smallQrBase64 = Buffer.from(smallQr).toString('base64');
  const barcode = design.barcode.bars.map(bar => {
    const y = design.barcode.y + bar.module * design.barcode.height / design.barcode.modules;
    const height = bar.width * design.barcode.height / design.barcode.modules;
    return `<rect x="${design.barcode.x}" y="${y.toFixed(3)}" width="${design.barcode.width}" height="${height.toFixed(3)}" fill="#111"/>`;
  }).join('');
  const corners = design.corners.map(corner =>
    `<image href="data:image/svg+xml;base64,${smallQrBase64}" x="${corner.x}" y="${corner.y}" width="${design.cornerSize}" height="${design.cornerSize}"/>`
  ).join('');
  const [top, bottom] = design.codeParts;
  const codeMarkup = bottom
    ? `<text x="498" y="520" class="top">${top}</text><text x="498" y="590" class="bottom">${bottom}</text>`
    : `<text x="300" y="580" class="bottom">${top}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 600 600">
    <rect width="600" height="600" fill="white"/>
    <image href="data:image/svg+xml;base64,${largeQrBase64}" x="${design.qr.x}" y="${design.qr.y}" width="${design.qr.size}" height="${design.qr.size}" image-rendering="pixelated"/>
    ${barcode}${corners}
    <style>text{text-anchor:end;font-family:Arial,sans-serif;fill:#111;font-weight:700}.top{font-size:32px;letter-spacing:1px}.bottom{font-size:78px;letter-spacing:8px}</style>
    ${codeMarkup}
  </svg>`;
}

function makeRng(seedText) {
  let seed = 0;
  for (let index = 0; index < seedText.length; index += 1) {
    seed = (Math.imul(seed, 31) + seedText.charCodeAt(index)) >>> 0;
  }
  return function random() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sideStripes(x, y, width, height, random) {
  const bars = [];
  const cuts = [];
  let position = 0;
  while (position < height - 1) {
    let bar = 1 + Math.floor(random() * 3);
    const gap = 1 + Math.floor(random() * 3);
    if (position + bar > height) bar = height - position;
    bars.push({ x, y: y + position, width, height: bar });
    position += bar + gap;
  }
  for (let cut = y + 42; cut < y + height - 10; cut += 58) {
    cuts.push({ x, y: cut, width, height: 3 });
  }
  return { bars, cuts };
}

function stickerDecorations(code) {
  const payload = encodeWbPayload(code);
  return {
    payload,
    qr: { x: 126, y: 178, size: 348 },
    cornerSize: 104,
    corners: [
      { x: 5, y: 57 },
      { x: 491, y: 57 },
      { x: 5, y: 574 },
      { x: 491, y: 574 },
    ],
    left: sideStripes(5, 174, 104, 382, makeRng(`${code}L`)),
    right: sideStripes(491, 174, 104, 382, makeRng(`${code}R`)),
  };
}

async function stickerSvg(code) {
  const design = stickerDecorations(code);
  const [centerQr, cornerQr] = await Promise.all([
    QRCode.toString(design.payload, { type: 'svg', width: design.qr.size, margin: 0, errorCorrectionLevel: 'M' }),
    QRCode.toString(design.payload, { type: 'svg', width: design.cornerSize, margin: 1, errorCorrectionLevel: 'M' }),
  ]);
  const centerQrBase64 = Buffer.from(centerQr).toString('base64');
  const cornerQrBase64 = Buffer.from(cornerQr).toString('base64');
  const [top, bottom] = splitCode(code);
  const codeMarkup = bottom
    ? `<text x="300" y="610" class="code small">${top}</text><text x="300" y="685" class="code">${bottom}</text>`
    : `<text x="300" y="665" class="code">${top}</text>`;
  const rects = (items, fill) => items.map((item) =>
    `<rect x="${item.x.toFixed(2)}" y="${item.y.toFixed(2)}" width="${item.width.toFixed(2)}" height="${item.height.toFixed(2)}" fill="${fill}"/>`
  ).join('');
  const cornerImages = design.corners.map((corner) =>
    `<image href="data:image/svg+xml;base64,${cornerQrBase64}" x="${corner.x}" y="${corner.y}" width="${design.cornerSize}" height="${design.cornerSize}"/>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="740" viewBox="0 0 600 740">
    <rect width="600" height="740" fill="white"/>
    <text x="300" y="151" text-anchor="middle" font-family="Arial,sans-serif" font-size="92" font-weight="800" letter-spacing="-8" fill="#e5007d">wb</text>
    ${cornerImages}
    ${rects(design.left.bars, '#000')}${rects(design.right.bars, '#000')}
    ${rects(design.left.cuts, '#fff')}${rects(design.right.cuts, '#fff')}
    <rect x="118" y="170" width="364" height="364" fill="white"/>
    <image href="data:image/svg+xml;base64,${centerQrBase64}" x="${design.qr.x}" y="${design.qr.y}" width="${design.qr.size}" height="${design.qr.size}"/>
    <style>.code{text-anchor:middle;font-family:Consolas,'Courier New',monospace;font-size:86px;font-weight:800}.small{font-size:62px}</style>
    ${codeMarkup}
  </svg>`;
}

function returnStickerDesign(code) {
  const normalized = String(code);
  if (!/^\d{1,12}$/.test(normalized)) throw new Error('Invalid return sticker code');
  return {
    payload: encodeWbPayload(normalized),
    width: 600,
    height: 900,
    qr: { x: 54, y: 205, size: 492 },
    title: '*B-T*',
    displayCode: `TRBX${normalized}`,
  };
}

async function returnStickerSvg(code) {
  const design = returnStickerDesign(code);
  const qr = await QRCode.toString(design.payload, {
    type: 'svg', width: design.qr.size, margin: 1, errorCorrectionLevel: 'M',
  });
  const qrBase64 = Buffer.from(qr).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${design.width}" height="${design.height}" viewBox="0 0 ${design.width} ${design.height}">
    <rect width="${design.width}" height="${design.height}" rx="20" fill="white"/>
    <text x="300" y="148" text-anchor="middle" font-family="Arial,sans-serif" font-size="82" font-weight="800" letter-spacing="2" fill="#111">${design.title}</text>
    <image href="data:image/svg+xml;base64,${qrBase64}" x="${design.qr.x}" y="${design.qr.y}" width="${design.qr.size}" height="${design.qr.size}" image-rendering="pixelated"/>
    <text x="300" y="820" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="800" letter-spacing="1" fill="#111">${design.displayCode}</text>
  </svg>`;
}

async function boxStickerSvg(prefix, code) {
  const safePrefix = String(prefix || '').toUpperCase();
  const normalized = String(code || '');
  if (!/^[A-Z0-9_-]{1,12}$/.test(safePrefix) || !/^\d{1,12}$/.test(normalized)) throw new Error('Invalid box sticker');
  const value = `${safePrefix}${normalized}`;
  const qr = await QRCode.toString(value, { type:'svg', width:492, margin:1, errorCorrectionLevel:'M' });
  const qrBase64 = Buffer.from(qr).toString('base64');
  const fontSize = Math.max(30, Math.min(48, Math.floor(650 / value.length)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
    <rect width="600" height="900" rx="20" fill="white"/>
    <text x="300" y="148" text-anchor="middle" font-family="Arial,sans-serif" font-size="82" font-weight="800" letter-spacing="2" fill="#111">*B-T*</text>
    <image href="data:image/svg+xml;base64,${qrBase64}" x="54" y="205" width="492" height="492" image-rendering="pixelated"/>
    <text x="300" y="820" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="800" letter-spacing="1" fill="#111">${value}</text>
  </svg>`;
}

module.exports = { boxStickerSvg, clientQrPng, code128Bars, code128Values, encodeWbPayload, newStickerDesign, newStickerSvg, qrPng, qrTextPng, requesterHash, returnStickerDesign, returnStickerSvg, splitCode, stickerDecorations, stickerSvg };
